import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { getAllFoundCandidatesDeduped } from "./tracking/found-candidates-log";
import { getAllContactedCreators, getContactHistory, getNegotiationState } from "./tracking/outreach-log";

// Excel counterpart to report-influencers.ts's INFLUENCERS.md — same
// "rebuild wholesale from the real tracking data every run" approach, just
// as a spreadsheet instead of markdown, since that's the format asked for
// (documenting found influencers for the course). Two sheets: every real
// candidate ever surfaced by find-influencers-tool (deduped to one row per
// channel), and everyone actually contacted so far — kept separate because
// "found" and "contacted" are different real states, not the same list at
// different stages.

const OUTPUT_FILE = path.resolve("Influencers.xlsx");

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  other: "Other",
};

function styleHeaderRow(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
  });
}

export async function writeInfluencersExcel(): Promise<{ found: number; contacted: number }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "outreach-mock";
  workbook.created = new Date();

  // --- Sheet 1: Found Candidates ------------------------------------------
  const found = getAllFoundCandidatesDeduped();
  const foundSheet = workbook.addWorksheet("Found Candidates");
  foundSheet.columns = [
    { header: "Channel", key: "channelName", width: 30 },
    { header: "Channel Link", key: "channelUrl", width: 42 },
    { header: "Niche(s)", key: "niches", width: 30 },
    // Previously you had to cross-reference this sheet against the
    // Contacted sheet by eye to tell who's already been reached out to.
    { header: "Contacted?", key: "contacted", width: 12 },
    { header: "Subscribers", key: "subscribers", width: 14 },
    { header: "Avg Views", key: "avgViews", width: 14 },
    { header: "Engagement %", key: "engagementRate", width: 14 },
    { header: "Posting", key: "postingConsistency", width: 14 },
    { header: "Days Since Upload", key: "daysSinceLastUpload", width: 16 },
    { header: "Possible Fake Engagement", key: "possibleFakeEngagement", width: 20 },
    { header: "Inconsistent Views", key: "inconsistentViews", width: 16 },
    { header: "Recent Video", key: "recentVideoTopic", width: 40 },
    { header: "Contact Email", key: "contactEmail", width: 28 },
    { header: "Contact Link", key: "contactLink", width: 30 },
    { header: "About Page", key: "aboutUrl", width: 42 },
    { header: "Rating", key: "rating", width: 10 },
    { header: "Sponsors Already Mentioned", key: "sponsorBrandsMentioned", width: 30 },
    { header: "Suggested Brands To Offer", key: "suggestedBrandsToOffer", width: 30 },
    { header: "First/Last Found", key: "foundAt", width: 22 },
  ];
  styleHeaderRow(foundSheet.getRow(1));

  for (const c of found) {
    const rating = getNegotiationState(c.channelId, c.channelName).rating;
    foundSheet.addRow({
      channelName: c.channelName,
      channelUrl: { text: c.channelUrl, hyperlink: c.channelUrl },
      niches: c.niches.join(", "),
      contacted: getContactHistory(c.channelId).contacted ? "yes" : "no",
      subscribers: c.subscribers,
      avgViews: c.avgViews,
      engagementRate: Number((c.engagementRate * 100).toFixed(2)),
      postingConsistency: c.postingConsistency,
      // Absent on entries logged before this field existed.
      daysSinceLastUpload: c.daysSinceLastUpload ?? "",
      possibleFakeEngagement: c.possibleFakeEngagement ? "yes" : "no",
      inconsistentViews: c.inconsistentViews ? "yes" : "",
      recentVideoTopic: c.recentVideoTopic,
      contactEmail: c.contactEmail ?? "",
      contactLink: c.contactLink ?? "",
      aboutUrl: c.aboutUrl ? { text: c.aboutUrl, hyperlink: c.aboutUrl } : "",
      rating: rating ?? "",
      // sponsorBrandsMentioned is absent on entries logged before this
      // field existed — treat as "not scanned" (blank), not "no sponsors".
      sponsorBrandsMentioned: (c.sponsorBrandsMentioned ?? []).join(", "),
      suggestedBrandsToOffer: c.suggestedBrandsToOffer.join(", "),
      foundAt: c.foundAt.slice(0, 10),
    });
  }
  foundSheet.autoFilter = { from: "A1", to: "S1" };

  // --- Sheet 2: Contacted --------------------------------------------------
  const contacted = getAllContactedCreators();
  const contactedSheet = workbook.addWorksheet("Contacted");
  contactedSheet.columns = [
    { header: "Creator", key: "channelName", width: 30 },
    { header: "Platform", key: "platform", width: 12 },
    { header: "Niche", key: "niche", width: 24 },
    { header: "Status", key: "dealStatus", width: 14 },
    { header: "Replied", key: "replied", width: 10 },
    // Course qualification dimension (Ammar's 4th): responsiveness during
    // initial contact predicts responsiveness once a deal's on the line.
    { header: "Days To First Reply", key: "daysToFirstReply", width: 18 },
    { header: "Times Contacted", key: "timesContacted", width: 16 },
    { header: "Last Contacted", key: "lastContactedAt", width: 16 },
  ];
  styleHeaderRow(contactedSheet.getRow(1));

  for (const c of contacted) {
    contactedSheet.addRow({
      channelName: c.channelName,
      platform: PLATFORM_LABEL[c.platform] ?? c.platform,
      niche: c.niche,
      dealStatus: c.dealStatus,
      replied: c.replied ? "yes" : "no",
      daysToFirstReply: c.daysToFirstReply ?? "",
      timesContacted: c.timesContacted,
      lastContactedAt: c.lastContactedAt.slice(0, 10),
    });
  }
  contactedSheet.autoFilter = { from: "A1", to: "H1" };

  await workbook.xlsx.writeFile(OUTPUT_FILE);
  return { found: found.length, contacted: contacted.length };
}

// See report-influencers.ts for why this isn't a raw file://${argv[1]} string
// compare — this project's directory name has a space in it, which
// import.meta.url percent-encodes but argv[1] never does.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { found, contacted } = await writeInfluencersExcel();
  console.log(`Wrote ${found} found candidate(s) and ${contacted} contacted creator(s) to ${OUTPUT_FILE}`);
}
