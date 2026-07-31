// Deterministic, non-LLM check for fabricated brand names in a drafted
// email. The drafting agent is instructed to only name brands from an
// explicit allowed list (or none at all), and the supervisor is separately
// instructed to reject any other brand name — but both of those are LLM
// judgment calls, and both have been observed to miss a fabricated brand
// name in practice. This catches the phrasing patterns the drafting agent is
// taught to use ("brands like X and Y") AND the higher-risk fabrication the
// course explicitly warns against — claiming an existing/closed relationship
// ("we've worked with X," "our client X," "we partnered with X") — with
// plain string matching, so a fabrication can be caught even if both LLM
// layers let it through.
//
// Originally this only matched "brands like X" — the offer-suggestion
// phrasing the drafting agent is taught. It missed a claimed-relationship
// phrasing like "we've worked with Nike before" entirely, which is the more
// damaging fabrication (a specific false claim of a past/existing deal, not
// just a suggested future one). Both trigger sets are still a heuristic:
// this only catches phrasing patterns it recognizes, not every possible way
// of naming a brand.
const BRAND_TRIGGER_PHRASE_REGEX =
  /\b(?:brands?\s+(?:like|such as)|(?:we|our team|our agency)(?:'ve| have)?\s+(?:worked with|partnered with|collaborated with)|our (?:client|clients|partner|partners)(?:\s+(?:like|include|includes|such as))?)\s+/gi;
const BRAND_NAME_LIST_REGEX = /^([A-Z][A-Za-z0-9&'.]*(?:(?:\s*,\s*|\s+and\s+)[A-Z][A-Za-z0-9&'.]*)*)/;

export function findNamedBrandsInOfferText(body: string): string[] {
  const brands = new Set<string>();
  for (const triggerMatch of body.matchAll(BRAND_TRIGGER_PHRASE_REGEX)) {
    const afterTrigger = body.slice(triggerMatch.index! + triggerMatch[0].length);
    const list = BRAND_NAME_LIST_REGEX.exec(afterTrigger)?.[1];
    if (!list) continue;
    for (const name of list.split(/\s*,\s*|\s+and\s+/)) {
      // Strip a trailing sentence-ending period, e.g. "brands like Nike."
      // at the end of a sentence — the name-char class allows "." mid-name
      // (for cases like "Squarespace.com"), so a real trailing full stop
      // otherwise gets swallowed into the captured name and makes an
      // actually-allowed brand ("Nike") fail to match "Nike." on comparison.
      const trimmed = name.trim().replace(/\.$/, "");
      if (trimmed && /^[A-Z]/.test(trimmed)) brands.add(trimmed);
    }
  }
  return [...brands];
}

// Returns the brand names actually named in the body that are NOT in the
// allowed list — non-empty means the draft fabricated a brand and should be
// rejected before it ever reaches a human "send?" prompt.
export function findFabricatedBrands(body: string, allowedBrands: string[]): string[] {
  const allowedLower = new Set(allowedBrands.map((b) => b.toLowerCase()));
  return findNamedBrandsInOfferText(body).filter((b) => !allowedLower.has(b.toLowerCase()));
}
