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

// Returns the long-tail keyword list for a known broad niche, or the niche
// itself unchanged (as a single-item list) if it doesn't match a known
// expansion — an unrecognized niche still searches exactly what was typed,
// same as before this existed.
export function expandNiche(niche: string): string[] {
  const normalized = normalize(niche);
  const expansion = NICHE_EXPANSIONS.find((e) => e.matches(normalized));
  return expansion ? expansion.keywords : [niche];
}
