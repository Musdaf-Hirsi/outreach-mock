import "dotenv/config";
import { setCreatorRating } from "./tracking/outreach-log";

// Usage: npm run rate-creator -- <channelId> <1-5> [note words...]
// Course's tracking-sheet discipline: keep a running qualitative rating per
// creator so quality signal isn't lost across a growing candidate list.

const [channelId, ratingRaw, ...noteWords] = process.argv.slice(2);
if (!channelId || !ratingRaw) {
  console.error("Usage: npm run rate-creator -- <channelId> <1-5> [note words...]");
  process.exit(1);
}

const rating = Number(ratingRaw);
const note = noteWords.join(" ") || undefined;

try {
  const state = await setCreatorRating(channelId, rating, note);
  console.log(`Rated ${state.channelName} (${channelId}): ${rating}/5${note ? ` — ${note}` : ""}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
