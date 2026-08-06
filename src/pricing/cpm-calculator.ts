// Pure pricing math — no LLM, no tools. Encodes the course's CPM-based
// pricing procedure (see COURSE_RULES.md Section 6) so the negotiation
// agent reasons from real computed numbers instead of guessing a price.

export interface VideoViews {
  views: number;
}

// Course procedure: gather the last ~12 pieces of content, drop the single
// highest and single lowest as outliers, average the rest for a realistic
// baseline — one or two viral/dud outliers shouldn't skew the whole estimate.
export function computeBaselineViews(recentVideos: VideoViews[]): number {
  if (recentVideos.length === 0) return 0;
  if (recentVideos.length <= 2) {
    // Not enough data to safely drop two outliers — just average what's there.
    const total = recentVideos.reduce((sum, v) => sum + v.views, 0);
    return Math.round(total / recentVideos.length);
  }
  const sorted = [...recentVideos].map((v) => v.views).sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1); // drop lowest and highest
  const total = trimmed.reduce((sum, v) => sum + v, 0);
  return Math.round(total / trimmed.length);
}

export interface CpmRange {
  min: number;
  max: number;
}

// Rough per-niche YouTube CPM ranges from the course, explicitly framed as
// ballpark guides, not fixed rules. Niche matching is a simple substring
// lookup against these keys — good enough for a first pass, not exhaustive.
//
// The course itself gives two different tables across two lessons
// ("Understanding Influencer Pricing" and "How to Price Influencers Step-
// by-Step") that don't fully agree — this takes the union where they
// overlap and defers to whichever lesson actually covers a niche the other
// doesn't. Two corrections from an earlier version of this table that
// didn't match either lesson: education's floor was 10 (neither lesson
// says lower than 25), and gaming/food were missing entirely and fell
// through to the default.
export const NICHE_CPM_BENCHMARKS: Record<string, CpmRange> = {
  tech: { min: 20, max: 50 },
  gadgets: { min: 20, max: 50 },
  finance: { min: 40, max: 80 },
  "personal finance": { min: 40, max: 80 },
  fitness: { min: 15, max: 35 },
  health: { min: 15, max: 35 },
  entertainment: { min: 5, max: 20 },
  lifestyle: { min: 10, max: 25 },
  beauty: { min: 10, max: 25 },
  travel: { min: 12, max: 20 },
  education: { min: 25, max: 40 },
  luxury: { min: 30, max: 50 },
  gaming: { min: 10, max: 20 },
  food: { min: 10, max: 20 },
  cooking: { min: 10, max: 20 },
};

// Course lesson ("How do influencers get paid: CPM vs Straight"): the
// generic unknown-niche range is $5-15, most creators landing $5-10 — this
// used to default to {10, 30}, roughly double the course's own intro-level
// number, which biased every unmatched-niche counter upward instead of
// toward the course's stated floor.
const DEFAULT_CPM_RANGE: CpmRange = { min: 5, max: 15 };

export function getNicheCpmRange(niche: string): CpmRange {
  const key = niche.trim().toLowerCase();
  if (NICHE_CPM_BENCHMARKS[key]) return NICHE_CPM_BENCHMARKS[key];
  const match = Object.keys(NICHE_CPM_BENCHMARKS).find((k) => key.includes(k) || k.includes(key));
  return match ? NICHE_CPM_BENCHMARKS[match] : DEFAULT_CPM_RANGE;
}

// Course's rough cross-platform CPM scaling relative to YouTube. Not wired
// to anything yet — the discovery tool is YouTube-only today — but exposed
// now so a future cross-platform pricing call doesn't need this re-derived.
export const PLATFORM_CPM_MULTIPLIER: Record<string, number> = {
  youtube: 1,
  instagram: 0.5,
  tiktok: 0.33,
  facebook: 0.45,
  twitter: 0.15,
  x: 0.15,
};

export function scaledCpmRange(niche: string, platform: string = "youtube"): CpmRange {
  const base = getNicheCpmRange(niche);
  const multiplier = PLATFORM_CPM_MULTIPLIER[platform.trim().toLowerCase()] ?? 1;
  return { min: Math.round(base.min * multiplier), max: Math.round(base.max * multiplier) };
}

export function estimateFairPrice(
  baselineViews: number,
  niche: string,
  platform: string = "youtube",
): { cpm: CpmRange; price: CpmRange } {
  const cpm = scaledCpmRange(niche, platform);
  // CPM = cost per thousand (mille) views, so this is thousands of views,
  // not millions — despite the name this used to have. The math was always
  // correct; the old name was actively misleading and an easy trap for a
  // future "fix" (e.g. dividing by 1_000_000 because the name said so).
  const thousands = baselineViews / 1000;
  return {
    cpm,
    price: { min: Math.round(cpm.min * thousands), max: Math.round(cpm.max * thousands) },
  };
}

export interface QuoteEvaluation {
  impliedCpm: number;
  benchmarkRange: CpmRange;
  verdict: "underpriced" | "fair" | "overpriced";
  suggestedCounterRange: { min: number; max: number };
}

// Compares a creator's quoted price against the CPM benchmark for their
// actual baseline views, applying the course's negative-adjustment rule
// (sub-2% engagement pulls the effective benchmark down) before verdicting.
export function evaluateQuote(
  quotedPrice: number,
  baselineViews: number,
  niche: string,
  opts: { platform?: string; engagementRate?: number } = {},
): QuoteEvaluation {
  const { platform = "youtube", engagementRate } = opts;
  let benchmarkRange = scaledCpmRange(niche, platform);

  // Negative price-adjustment factor: engagement under ~2% justifies
  // pricing below baseline CPM (audience is less valuable to the brand).
  if (engagementRate !== undefined && engagementRate < 0.02) {
    benchmarkRange = { min: Math.round(benchmarkRange.min * 0.7), max: Math.round(benchmarkRange.max * 0.7) };
  }

  const thousands = baselineViews / 1000;
  const impliedCpm = thousands > 0 ? quotedPrice / thousands : 0;

  let verdict: QuoteEvaluation["verdict"];
  if (impliedCpm < benchmarkRange.min) verdict = "underpriced";
  else if (impliedCpm > benchmarkRange.max) verdict = "overpriced";
  else verdict = "fair";

  // Standard negotiation target: 20-50% off a fairly-priced quote; more
  // aggressive discounts (40-80% off) when clearly overpriced. Underpriced
  // is its own case, not "fair" — course rule ("How to Price Influencers
  // Step-by-Step"): lock in a bargain at or slightly below their own
  // number (0-20% off) rather than squeezing further. Negotiating hard on
  // an already-cheap quote risks exposing that they're underpriced and
  // losing the deal — the margin here comes from the brand-side markup,
  // not from further discounting the creator.
  const [loPct, hiPct] =
    verdict === "overpriced" ? [0.4, 0.8] : verdict === "underpriced" ? [0.0, 0.2] : [0.2, 0.5];
  const suggestedCounterRange = {
    min: Math.round(quotedPrice * (1 - hiPct)),
    max: Math.round(quotedPrice * (1 - loPct)),
  };

  return { impliedCpm: Math.round(impliedCpm * 100) / 100, benchmarkRange, verdict, suggestedCounterRange };
}

// Hard business-rule floor, referenced by name in COURSE_RULES.md: never
// pitch a brand below what the creator originally quoted, even after
// negotiating them down internally — the negotiated discount is the
// agency's margin, not a discount to pass on to the brand. Nothing calls
// this yet (no brand-pitch code exists), but it's exposed now so that
// future code has a single, correct source for this constraint rather than
// re-deriving it inline.
export function marginFloor(originalQuotedPrice: number): number {
  return originalQuotedPrice;
}
