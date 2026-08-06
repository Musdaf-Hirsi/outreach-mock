import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncTrackingSheet } from "./tracking/google-sheet-sync";

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_ID is not set in .env — paste your sheet's ID or share URL.");
  }
  const { found, contacted } = await syncTrackingSheet(spreadsheetId);
  console.log(`Synced ${found} found candidate(s) and ${contacted} contacted creator(s) to the Google Sheet.`);
}

// See report-influencers.ts for why this isn't a raw file://${argv[1]} string
// compare — this project's directory name has a space in it, which
// import.meta.url percent-encodes but argv[1] never does.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Sheet sync failed:", err);
    process.exit(1);
  });
}
