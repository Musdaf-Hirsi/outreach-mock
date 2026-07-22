// Deterministic, non-LLM check for fabricated brand names in a drafted
// email. The drafting agent is instructed to only name brands from an
// explicit allowed list (or none at all), and the supervisor is separately
// instructed to reject any other brand name — but both of those are LLM
// judgment calls, and both have been observed to miss a fabricated brand
// name in practice. This catches the exact phrasing pattern the drafting
// agent is taught to use ("brands like X and Y," "brand like X") with plain
// string matching, so a fabrication can be caught even if both LLM layers
// let it through.

const BRAND_LIKE_PHRASE_REGEX = /\bbrands?\s+(?:like|such as)\s+([A-Z][A-Za-z0-9&'.]*(?:(?:\s*,\s*|\s+and\s+)[A-Z][A-Za-z0-9&'.]*)*)/gi;

export function findNamedBrandsInOfferText(body: string): string[] {
  const brands = new Set<string>();
  for (const match of body.matchAll(BRAND_LIKE_PHRASE_REGEX)) {
    const list = match[1];
    for (const name of list.split(/\s*,\s*|\s+and\s+/)) {
      const trimmed = name.trim();
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
