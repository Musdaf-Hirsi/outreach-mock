// Course technique ("How to Find Influencers"): a broad niche term like
// "cybersecurity" keeps resurfacing the same handful of mega-channels no
// matter how many times you search it — the fix taught in the course is to
// search several specific, long-tail phrasings of the niche instead of the
// broad term itself, since that's what actually surfaces smaller, more
// relevant channels. This used to mean the user manually typing out and
// re-running 10 separate searches by hand; now saying the broad niche once
// expands to the full keyword set automatically, in find-candidates-for-
// niche, so "cybersecurity" always means "run the real long-tail list," not
// a single generic search.
//
// Any niche other than cybersecurity used to silently fall back to a single
// generic search — the hardcoded list below only ever covered one niche.
// The course's own fix for this ("ask the AI to generate 10 long-tail
// keywords for your niche") is applied automatically here for any
// unrecognized niche: generate once via the LLM, cache to
// niche-keywords.json (gitignored, per-machine state) so it's reviewable/
// editable and never regenerated on every sweep, and reuse from then on.

import fs from "node:fs";
import path from "node:path";
import { Agent } from "@mastra/core/agent";
import { outreachModel } from "./model";

interface NicheExpansion {
  // Matched against the niche string with spaces stripped, so "cyber
  // security", "cybersecurity", and "Cyber-Security" all resolve the same.
  matches: (normalizedNiche: string) => boolean;
  keywords: string[];
}

// Segmented per the course's own advice (module 2, "how to find
// influencers organically"): rather than one flat list, this covers
// distinct sub-audiences within cybersecurity (career/entry, certifications,
// hands-on technical) so the sweep doesn't just repeatedly hit the same
// "getting started" crowd — a broad niche has enough real sub-niches that a
// single flat keyword list runs out of new channels fast.
const CYBERSECURITY_LONG_TAIL_KEYWORDS = [
  // Career / entry
  "how I passed my Security+ exam",
  "SOC analyst day in the life",
  "cybersecurity internship interview questions",
  "how to become a penetration tester with no degree",
  "cybersecurity career change at 30",
  "home lab setup for cybersecurity beginners",
  "OSCP exam review honest",
  "GRC analyst career path",
  "cybersecurity job rejection what I learned",
  "TryHackMe vs HackTheBox for beginners",
  "how I got my first cybersecurity job with no experience",
  "cybersecurity resume that got me interviews",
  "self taught cybersecurity roadmap 2026",
  "military to cybersecurity career transition",
  "IT help desk to cybersecurity career path",
  "cybersecurity bootcamp honest review",
  "is a cybersecurity degree worth it",
  "cybersecurity salary first year reality",
  "women in cybersecurity my journey",
  "cybersecurity portfolio website walkthrough",
  // Certifications
  "CompTIA Security+ study plan",
  "CySA+ exam experience",
  "CISSP exam tips first attempt",
  "CEH certification worth it",
  "how I passed OSCP in 90 days",
  // Hands-on / technical
  "building a home SOC lab",
  "malware analysis for beginners",
  "digital forensics case walkthrough",
  "incident response tabletop exercise",
  "bug bounty first payout story",
  "capture the flag walkthrough beginner",
  "Python scripting for cybersecurity automation",
  "Linux command line for security analysts",
  "vulnerability management analyst day in the life",
  "cloud security engineer AWS certification",
  "red team vs blue team explained",
  "threat intelligence analyst career",
  "DevSecOps engineer explained",
  "network security engineer interview",
  "appsec engineer career path",
];

const NICHE_EXPANSIONS: NicheExpansion[] = [
  {
    matches: (n) => n.includes("cybersecurity") || n.includes("cyber-security"),
    keywords: CYBERSECURITY_LONG_TAIL_KEYWORDS,
  },
];

function normalize(niche: string): string {
  return niche.toLowerCase().replace(/\s+/g, "");
}

const CACHE_FILE = path.resolve("niche-keywords.json");

function loadCache(): Record<string, string[]> {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    // Corrupted cache is not worth failing a whole sweep over — just
    // regenerate for whatever niches are requested going forward.
    return {};
  }
}

function saveCache(cache: Record<string, string[]>) {
  const tmpFile = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2));
  fs.renameSync(tmpFile, CACHE_FILE);
}

const keywordExpansionAgent = new Agent({
  name: "keyword-expansion-agent",
  instructions: `
You generate long-tail YouTube search phrases for an influencer-discovery
sweep, per the course technique taught in "The Best Way of Finding
Influencers Organically": broad niche terms keep resurfacing the same
handful of giant channels, but specific phrasings that sound like real video
titles surface smaller, more relevant creators instead.

Given a niche, output 12-15 long-tail phrases, one per line, no numbering,
no bullets, no commentary. Each phrase should read like something a real
creator would title a video in this niche — specific, personal, and
searchable (e.g. for "personal finance": "how I paid off $30k in debt in a
year", "budgeting on minimum wage that actually worked", "day in the life
of a bogleheads investor"). Cover a few distinct sub-angles within the niche
(getting started/beginner, a personal story/journey, a how-to/tutorial, a
review/opinion, a career or milestone moment) rather than 12 variations of
the same angle. Never include the raw niche word by itself as one of the
lines — every line must be a specific long-tail phrase, not the niche name.
`,
  model: outreachModel,
});

async function generateLongTailKeywords(niche: string): Promise<string[]> {
  const result = await keywordExpansionAgent.generate(`Niche: ${niche}\nGenerate the long-tail phrase list now.`);
  return result.text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*\d.)]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
}

// Returns the long-tail keyword list for a niche. Known broad niches
// (cybersecurity) use the hand-curated list above; anything else generates
// once via the LLM and caches to niche-keywords.json, falling back to the
// niche itself unchanged if generation fails (no API key, network error) so
// a sweep never hard-fails just because keyword expansion couldn't run.
export async function expandNiche(niche: string): Promise<string[]> {
  const normalized = normalize(niche);
  const hardcoded = NICHE_EXPANSIONS.find((e) => e.matches(normalized));
  if (hardcoded) return hardcoded.keywords;

  const cache = loadCache();
  if (cache[normalized]?.length) return cache[normalized];

  let keywords: string[];
  try {
    keywords = await generateLongTailKeywords(niche);
  } catch {
    return [niche];
  }
  if (keywords.length === 0) return [niche];

  cache[normalized] = keywords;
  saveCache(cache);
  return keywords;
}
