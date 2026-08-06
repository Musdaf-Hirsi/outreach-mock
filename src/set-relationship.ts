import "dotenv/config";
import { setRelationshipType } from "./tracking/outreach-log";

// Usage: npm run set-relationship -- <channelId> discount|exclusive [commissionPct]
// Course technique ("The 2 Different Paths You Can Take"): every
// relationship starts on the discount path; exclusive is a later,
// deliberate upsell after a few successful deals. This is the only place
// that flips relationshipType — without it, a creator who actually gets
// signed exclusively keeps showing up in getExclusivityCandidates forever.

const [channelId, relationshipTypeRaw, commissionPctRaw] = process.argv.slice(2);
if (!channelId || !relationshipTypeRaw) {
  console.error("Usage: npm run set-relationship -- <channelId> discount|exclusive [commissionPct]");
  process.exit(1);
}

if (relationshipTypeRaw !== "discount" && relationshipTypeRaw !== "exclusive") {
  console.error(`relationshipType must be "discount" or "exclusive", got "${relationshipTypeRaw}"`);
  process.exit(1);
}

const commissionPct = commissionPctRaw ? Number(commissionPctRaw) : undefined;

try {
  const state = await setRelationshipType(channelId, relationshipTypeRaw, commissionPct);
  console.log(
    `${state.channelName} (${channelId}) set to ${relationshipTypeRaw}` +
      (commissionPct !== undefined ? ` at ${commissionPct}% commission` : ""),
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
