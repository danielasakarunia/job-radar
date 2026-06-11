#!/usr/bin/env node
/* ============================================================
   Job Radar — harvester + rule-based scorer
   Runs in GitHub Actions on a schedule. No paid API.
   - Fetches jobs from Remotive (keyless) + JSearch (free key, optional)
   - Scores each job against data/profile.json using simple rules
   - Writes data/jobs.json (committed back to the repo by the workflow)
   ============================================================ */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PROFILE_PATH = path.join(ROOT, "data", "profile.json");
const JOBS_PATH = path.join(ROOT, "data", "jobs.json");

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8"));
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || ""; // optional; set as GitHub Secret

const norm = (s) => (s || "").toLowerCase();
const todayISO = () => new Date().toISOString().slice(0, 10);

/* ---------------- rule-based scoring ---------------- */
function scoreSkills(text) {
  const t = norm(text);
  let hits = 0;
  for (const kw of profile.skillKeywords) if (t.includes(norm(kw))) hits++;
  // saturate: 12+ keyword hits = full marks
  return Math.min(100, Math.round((hits / 12) * 100));
}

function scoreSeniority(title) {
  const t = norm(title);
  const want = profile.targetSeniority || "mid";
  const terms = profile.seniorityTerms || {};
  const inGroup = (g) => (terms[g] || []).some((w) => t.includes(norm(w)));
  const jobLevel = inGroup("senior") ? "senior" : inGroup("junior") ? "junior" : "mid";
  if (jobLevel === want) return 100;
  if (Math.abs(["junior", "mid", "senior"].indexOf(jobLevel) - ["junior", "mid", "senior"].indexOf(want)) === 1) return 70;
  return 45;
}

function scoreLocation(text) {
  const t = norm(text);
  for (const loc of profile.locationTerms) if (t.includes(norm(loc))) return 100;
  return 40; // unknown location: neutral-low
}

function scoreJob(job) {
  const blob = `${job.title} ${job.company} ${job.location} ${job.description}`;
  const skills = scoreSkills(blob);
  const seniority = scoreSeniority(job.title);
  const location = scoreLocation(`${job.location} ${job.description}`);
  // weights: skills 50, seniority 25, location 25
  const overall = Math.round(skills * 0.5 + seniority * 0.25 + location * 0.25);
  return { score: overall, breakdown: { skills, seniority, location } };
}

/* ---------------- fetchers ---------------- */
async function fetchRemotive() {
  try {
    const q = encodeURIComponent(profile.remotiveSearch || "product");
    const url = `https://remotive.com/api/remote-jobs?search=${q}&limit=40`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Remotive HTTP " + res.status);
    const data = await res.json();
    return (data.jobs || []).map((j) => ({
      id: "rem-" + j.id,
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || "Remote",
      source: "Remotive",
      link: j.url,
      description: stripHtml(j.description).slice(0, 1500),
      posted: (j.publication_date || "").slice(0, 10),
    }));
  } catch (e) {
    console.error("Remotive failed:", e.message);
    return [];
  }
}

async function fetchJSearch() {
  if (!RAPIDAPI_KEY) {
    console.log("No RAPIDAPI_KEY set — skipping JSearch (Remotive only).");
    return [];
  }
  const out = [];
  for (const query of profile.searchQueries || []) {
    try {
      const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=1`;
      const res = await fetch(url, {
        headers: {
          "X-RapidAPI-Key": RAPIDAPI_KEY,
          "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
        },
      });
      if (!res.ok) throw new Error("JSearch HTTP " + res.status);
      const data = await res.json();
      for (const j of data.data || []) {
        out.push({
          id: "js-" + (j.job_id || Math.random().toString(36).slice(2)),
          title: j.job_title,
          company: j.employer_name,
          location: [j.job_city, j.job_country].filter(Boolean).join(", ") || (j.job_is_remote ? "Remote" : "—"),
          source: j.job_publisher || "JSearch",
          link: j.job_apply_link,
          description: (j.job_description || "").slice(0, 1500),
          posted: (j.job_posted_at_datetime_utc || "").slice(0, 10),
        });
      }
    } catch (e) {
      console.error(`JSearch "${query}" failed:`, e.message);
    }
  }
  return out;
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

/* ---------------- main ---------------- */
async function main() {
  const [remote, jsearch] = await Promise.all([fetchRemotive(), fetchJSearch()]);
  const raw = [...jsearch, ...remote];

  // dedupe by title+company
  const seen = new Set();
  const deduped = [];
  for (const j of raw) {
    const key = norm(j.title) + "|" + norm(j.company);
    if (!j.title || seen.has(key)) continue;
    seen.add(key);
    deduped.push(j);
  }

  // score + filter by threshold
  const threshold = profile.scoreThreshold ?? 50;
  const scored = deduped
    .map((j) => ({ ...j, ...scoreJob(j) }))
    .filter((j) => j.score >= threshold)
    .sort((a, b) => b.score - a.score);

  // merge with existing jobs to preserve user-set status
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(JOBS_PATH, "utf8")).jobs || []; } catch {}
  const statusById = new Map(existing.map((j) => [j.id, j.status]));

  const merged = scored.map((j) => ({
    ...j,
    status: statusById.get(j.id) || "New",
    firstSeen: existing.find((e) => e.id === j.id)?.firstSeen || todayISO(),
  }));

  // keep any existing jobs the user has acted on, even if they fell out of search
  for (const e of existing) {
    if (!merged.find((m) => m.id === e.id) && e.status && e.status !== "New") {
      merged.push(e);
    }
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    count: merged.length,
    jobs: merged.slice(0, 100),
  };
  fs.writeFileSync(JOBS_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${payload.jobs.length} jobs (from ${raw.length} raw, ${deduped.length} unique) to data/jobs.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
