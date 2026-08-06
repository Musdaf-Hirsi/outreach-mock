import "dotenv/config";
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initGraph, setNode } from "./viz/graph";
import { getContactHistory } from "./tracking/outreach-log";
import { draftReviewAndSend, type DraftCandidate } from "./draft-review-send";

// Usage: npm run import-manual -- <path-to-csv>
// CSV header (required columns: platform,name,link,niche,content,email —
// followers,brands are optional): platform,name,link,niche,content,followers,brands,email
//
// The course's action step for TikTok/Instagram (no free discovery API, so
// no automated equivalent to find-influencers-tool.ts) is "find at least 50
// influencers and fill the tracking sheet" — a browsing session that
// produces a list, not one creator at a time. run-manual.ts's interactive
// Q&A interview is fine for a handful of creators but turns a real list
// into an hour of retyping the same 6-7 fields. This reads that list from a
// CSV instead — still one real draft/review/y-n-confirm/send per creator
// (never a silent bulk-send; that would break the human-in-the-loop
// pattern every other send path in this app follows), just without
// retyping.

type Platform = "tiktok" | "instagram" | "other";

function normalizePlatform(input: string): Platform {
  const lower = input.trim().toLowerCase();
  if (lower.startsWith("t")) return "tiktok";
  if (lower.startsWith("i")) return "instagram";
  return "other";
}

// Minimal RFC4180-ish parser (quoted fields, escaped "" inside quotes,
// commas/newlines inside quotes) — no CSV library in this project's
// dependencies, and this use case doesn't need a full one.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

async function main() {
  const [csvPath] = process.argv.slice(2);
  if (!csvPath) {
    console.error("Usage: npm run import-manual -- <path-to-csv>");
    console.error("Header: platform,name,link,niche,content,followers,brands,email (followers,brands optional)");
    process.exit(1);
  }

  const text = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCsv(text);
  if (rows.length === 0) {
    console.error("CSV is empty.");
    process.exit(1);
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const required = ["platform", "name", "link", "niche", "content", "email"];
  const missing = required.filter((col) => !header.includes(col));
  if (missing.length > 0) {
    console.error(`CSV missing required column(s): ${missing.join(", ")}`);
    console.error("Header: platform,name,link,niche,content,followers,brands,email (followers,brands optional)");
    process.exit(1);
  }
  const col = (name: string) => header.indexOf(name);
  const dataRows = rows.slice(1);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  initGraph();
  setNode("trigger", "done", "manual CSV import (TikTok/Instagram)");
  setNode("agent", "done", "manual entry — no discovery API");

  let sentCount = 0;
  let skippedCount = 0;

  for (const r of dataRows) {
    const platform = normalizePlatform(r[col("platform")] ?? "");
    const displayName = (r[col("name")] ?? "").trim();
    const link = (r[col("link")] ?? "").trim();
    const niche = (r[col("niche")] ?? "").trim();
    const contentDescription = (r[col("content")] ?? "").trim();
    const followerNote = col("followers") >= 0 ? (r[col("followers")] ?? "").trim() : "";
    const brandsInput = col("brands") >= 0 ? (r[col("brands")] ?? "").trim() : "";
    // Semicolon-separated, not comma — commas are already the CSV field
    // delimiter, and requiring a quoted "brand a, brand b" field per row is
    // more friction than the course's course-notes/tracking-sheet habit
    // would naturally produce.
    const allowedBrands = brandsInput ? brandsInput.split(";").map((b) => b.trim()).filter(Boolean) : [];
    const email = (r[col("email")] ?? "").trim();

    console.log(`\n--- ${displayName} (${platform}) ---`);
    console.log(`Link: ${link}`);
    if (followerNote) console.log(`Followers: ${followerNote}`);

    if (!email) {
      console.log(`Skipped — no email in this CSV row.`);
      skippedCount++;
      continue;
    }

    const history = getContactHistory(email);
    if (history.contacted) {
      console.log(
        `(Heads up: ${email} was already contacted ${history.timesContacted}x, last on ${history.lastContactedAt}.)`,
      );
      const proceed = await rl.question(`Send another email anyway? (y/n): `);
      if (proceed.trim().toLowerCase() !== "y") {
        console.log(`Skipped.`);
        skippedCount++;
        continue;
      }
    }

    const candidate: DraftCandidate = {
      displayName: link ? `${displayName} (${link})` : displayName,
      niche,
      contextLine: `Recent content: "${contentDescription}"`,
      allowedBrands,
      platform,
    };

    const result = await draftReviewAndSend(rl, candidate, email);
    if (result === "sent") sentCount++;
    else skippedCount++;
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
