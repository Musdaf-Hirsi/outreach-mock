import { google } from "googleapis";
import { getAuthorizedGmailClient } from "../gmail/auth";
import { getAllFoundCandidatesDeduped } from "./found-candidates-log";
import { getAllContactedCreators } from "./outreach-log";

// Pushes the same data as Influencers.xlsx / GET /sheet into a real Google
// Sheet the user already owns and has shared with people (course teammates,
// whoever), so they see updates land in a link they can hand out — instead
// of a local file or a URL only this app's own server can serve. Rebuilds
// both tabs wholesale on every sync (same "regenerate from the real
// tracking data, don't hand-edit" approach as report-excel.ts/
// report-influencers.ts) — this is a read view onto found-candidates.json /
// outreach-log.json, not a second place that data lives.

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  other: "Other",
};

const FOUND_HEADER = [
  "Channel",
  "Channel Link",
  "Niche(s)",
  "Subscribers",
  "Avg Views",
  "Engagement %",
  "Posting",
  "Possible Fake Engagement",
  "Recent Video",
  "Contact Email",
  "Contact Link",
  "Sponsors Already Mentioned",
  "Suggested Brands To Offer",
  "First/Last Found",
];

const CONTACTED_HEADER = ["Creator", "Platform", "Niche", "Status", "Replied", "Times Contacted", "Last Contacted"];

function extractSpreadsheetId(idOrUrl: string): string {
  const match = idOrUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : idOrUrl;
}

async function getSheetsClient() {
  const auth = await getAuthorizedGmailClient();
  return google.sheets({ version: "v4", auth });
}

// A brand-new spreadsheet only has "Sheet1" by default — create the two
// named tabs this sync writes to if they don't exist yet, so the user never
// has to manually rename/add tabs before the first sync works.
async function ensureTabsExist(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTitles = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));

  const requests = [];
  for (const title of ["Found Candidates", "Contacted"]) {
    if (!existingTitles.has(title)) {
      requests.push({ addSheet: { properties: { title } } });
    }
  }
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

async function writeSheet(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string,
  header: string[],
  rows: (string | number)[][],
) {
  // Clear first — row count shrinks/grows between syncs (candidates get
  // deduped differently, contacted count changes), so a plain overwrite
  // without clearing can leave stale trailing rows from a longer previous
  // sync.
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [header, ...rows] },
  });
}

export async function syncTrackingSheet(spreadsheetIdOrUrl: string): Promise<{ found: number; contacted: number }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  const sheets = await getSheetsClient();

  await ensureTabsExist(sheets, spreadsheetId);

  const found = getAllFoundCandidatesDeduped();
  const foundRows = found.map((c) => [
    c.channelName,
    c.channelUrl,
    c.niches.join(", "),
    c.subscribers,
    c.avgViews,
    Number((c.engagementRate * 100).toFixed(2)),
    c.postingConsistency,
    c.possibleFakeEngagement ? "yes" : "no",
    c.recentVideoTopic,
    c.contactEmail ?? "",
    c.contactLink ?? "",
    (c.sponsorBrandsMentioned ?? []).join(", "),
    c.suggestedBrandsToOffer.join(", "),
    c.foundAt.slice(0, 10),
  ]);
  await writeSheet(sheets, spreadsheetId, "Found Candidates", FOUND_HEADER, foundRows);

  const contacted = getAllContactedCreators();
  const contactedRows = contacted.map((c) => [
    c.channelName,
    PLATFORM_LABEL[c.platform] ?? c.platform,
    c.niche,
    c.dealStatus,
    c.replied ? "yes" : "no",
    c.timesContacted,
    c.lastContactedAt.slice(0, 10),
  ]);
  await writeSheet(sheets, spreadsheetId, "Contacted", CONTACTED_HEADER, contactedRows);

  return { found: found.length, contacted: contacted.length };
}

// Best-effort sync for call sites that just found new candidates and want
// the live sheet to reflect it (web search, the manager agent's discovery
// tool) — silently does nothing if GOOGLE_SHEETS_ID isn't set (sheet sync
// is optional), and never throws into the caller: a Sheets API hiccup
// (auth expired, rate limit) shouldn't fail the search that triggered it,
// since the candidates are already safely logged to found-candidates.json
// regardless and can be synced later.
export async function syncTrackingSheetIfConfigured(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return;
  try {
    await syncTrackingSheet(spreadsheetId);
  } catch (err: any) {
    console.error(`Google Sheet sync failed (non-fatal): ${err.message ?? err}`);
  }
}
