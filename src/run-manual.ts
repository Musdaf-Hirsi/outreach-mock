import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initGraph, setNode } from "./viz/graph";
import { getContactHistory } from "./tracking/outreach-log";
import { draftReviewAndSend, type DraftCandidate } from "./draft-review-send";

// Manual-add flow for platforms with no free public discovery API (TikTok,
// Instagram) — unlike find-influencers-tool.ts, which searches YouTube
// automatically via the Data API, here you paste in a creator's link and a
// short description of their content yourself, then it runs through the
// exact same draft -> review -> send -> tracking pipeline as a YouTube
// candidate (see draft-review-send.ts).

type Platform = "tiktok" | "instagram" | "other";

function normalizePlatform(input: string): Platform {
  const lower = input.trim().toLowerCase();
  if (lower.startsWith("t")) return "tiktok";
  if (lower.startsWith("i")) return "instagram";
  return "other";
}

async function addOne(rl: readline.Interface): Promise<"sent" | "skipped"> {
  const platformInput = await rl.question(`Platform (tiktok/instagram/other): `);
  const platform = normalizePlatform(platformInput);

  const displayName = (await rl.question(`Creator name/handle: `)).trim();
  const link = (await rl.question(`Profile or video link: `)).trim();
  const niche = (await rl.question(`Niche: `)).trim();
  const contentDescription = (
    await rl.question(`Short description of their recent content (used for personalization): `)
  ).trim();
  const followerNote = (await rl.question(`Follower count, if known (optional, press Enter to skip): `)).trim();
  const brandsInput = (
    await rl.question(`Brands to offer, comma-separated (optional, press Enter for none): `)
  ).trim();
  const allowedBrands = brandsInput
    ? brandsInput.split(",").map((b) => b.trim()).filter(Boolean)
    : [];

  console.log(`\n--- ${displayName} (${platform}) ---`);
  console.log(`Link: ${link}`);
  if (followerNote) console.log(`Followers: ${followerNote}`);

  const email = (await rl.question(`Enter the real email for ${displayName} (or press Enter to skip): `)).trim();
  if (!email) {
    console.log(`Skipped — no email provided.`);
    return "skipped";
  }

  const history = getContactHistory(email);
  if (history.contacted) {
    console.log(
      `(Heads up: ${email} was already contacted ${history.timesContacted}x, last on ${history.lastContactedAt}.)`,
    );
    const proceed = await rl.question(`Send another email anyway? (y/n): `);
    if (proceed.trim().toLowerCase() !== "y") {
      console.log(`Skipped.`);
      return "skipped";
    }
  }

  const candidate: DraftCandidate = {
    displayName: link ? `${displayName} (${link})` : displayName,
    niche,
    contextLine: `Recent content: "${contentDescription}"`,
    allowedBrands,
    platform,
  };

  return draftReviewAndSend(rl, candidate, email);
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  initGraph();
  setNode("trigger", "done", "manual add (TikTok/Instagram)");
  setNode("agent", "done", "manual entry — no discovery API");

  let sentCount = 0;
  let skippedCount = 0;

  let keepGoing = true;
  while (keepGoing) {
    const result = await addOne(rl);
    if (result === "sent") sentCount++;
    else skippedCount++;

    const again = await rl.question(`\nAdd another creator? (y/n): `);
    keepGoing = again.trim().toLowerCase() === "y";
  }

  setNode("done", "done", `${sentCount} sent, ${skippedCount} skipped`);
  rl.close();

  console.log(`\n=== Summary ===`);
  console.log(`Sent: ${sentCount}`);
  console.log(`Skipped: ${skippedCount}`);
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
