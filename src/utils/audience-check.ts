// Course qualification dimension ("What are media kits" / "How to Qualify
// Influencers"): for English-language campaigns, look for at least one
// high-purchasing-power country in a creator's top-3 audience countries —
// none present is a "run away" red flag. This can't be pulled from the
// YouTube API — it only exists once a human has actually checked a media
// kit — so this is a non-blocking check against whatever free-text note was
// entered, not an automatic filter. Previously only lived inside
// run-interactive.ts and nothing else in the app (the web UI, the CLI
// negotiate path) ever ran it.
const GOLDEN_COUNTRY_KEYWORDS = ["us", "usa", "united states", "uk", "united kingdom", "canada", "australia"];

// Word-boundary matching, not a raw substring check — "us" as a bare
// .includes() match would false-positive on "business," "focus," "Belarus,"
// "Mauritius," etc. This only matters now that the check is wired into the
// close-warning path (a real per-close signal), not just an interactive
// CLI prompt where a false positive was low-stakes.
export function mentionsGoldenCountry(note: string): boolean {
  const lower = note.toLowerCase();
  return GOLDEN_COUNTRY_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(lower));
}
