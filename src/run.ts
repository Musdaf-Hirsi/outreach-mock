import "dotenv/config";
import { mastra } from "./mastra";
import { initGraph, setNode } from "./viz/graph";

async function main() {
  const agent = mastra.getAgent("outreachAgent");
  const niche = process.argv[2] ?? "food";

  initGraph();
  setNode("trigger", "done", `niche: "${niche}"`);
  setNode("agent", "active", "reasoning with DeepSeek...");

  const result = await agent.generate(
    `Find influencers in the "${niche}" niche and send each one a personalized outreach email.`,
  );

  setNode("agent", "done", "final answer ready");
  setNode("done", "done", "see summary below");

  console.log("=== Agent final summary ===");
  console.log(result.text);
}

main().catch((err) => {
  setNode("agent", "error", String(err.message ?? err));
  console.error("Run failed:", err);
  process.exit(1);
});
