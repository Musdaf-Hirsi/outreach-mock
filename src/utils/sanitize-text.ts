// Hard guarantee for the "no em dashes, no curly quotes" rule — the LLM
// doesn't always follow that instruction reliably (same lesson as the
// placeholder-email bug), so enforce it in code after generation instead of
// trusting the prompt alone.
export function sanitizeHumanText(text: string): string {
  return text
    .replace(/[—–]/g, ", ") // em dash, en dash -> comma
    .replace(/\s*,\s*,\s*/g, ", ") // collapse any doubled commas from the above
    .replace(/[‘’]/g, "'") // curly single quotes -> straight
    .replace(/[“”]/g, '"') // curly double quotes -> straight
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
