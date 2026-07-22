// Live node-graph, n8n-style: nodes light up as the agent actually executes
// them. Renders to the terminal (ANSI) and, if a dashboard server is
// running (`npm run dashboard`), also pushes the same events over
// WebSocket so a browser tab can render the identical graph live.

import { WebSocket } from "ws";

type NodeStatus = "pending" | "active" | "done" | "error";

interface GraphNode {
  id: string;
  label: string;
  status: NodeStatus;
  detail: string;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GRAY = "\x1b[90m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

const nodes: GraphNode[] = [
  { id: "trigger", label: "TRIGGER", status: "pending", detail: "npm run dev" },
  { id: "agent", label: "AGENT / DEEPSEEK", status: "pending", detail: "reasoning" },
  { id: "find-influencers", label: "FIND INFLUENCERS", status: "pending", detail: "YouTube API" },
  { id: "send-email", label: "SEND EMAIL", status: "pending", detail: "Gmail API" },
  { id: "done", label: "DONE", status: "pending", detail: "" },
];

function colorFor(status: NodeStatus): string {
  switch (status) {
    case "active":
      return YELLOW + BOLD;
    case "done":
      return GREEN;
    case "error":
      return RED;
    default:
      return GRAY;
  }
}

function box(node: GraphNode): string[] {
  const color = colorFor(node.status);
  const icon = node.status === "active" ? "●" : node.status === "done" ? "✔" : node.status === "error" ? "✘" : "○";
  const label = node.label.padEnd(18);
  const width = 22;
  const top = "┌" + "─".repeat(width) + "┐";
  const mid = `│ ${color}${icon} ${label}${RESET} │`;
  const bottom = "└" + "─".repeat(width) + "┘";
  const detailLine = node.detail ? `${DIM}${node.detail.slice(0, width).padEnd(width)}${RESET}` : "".padEnd(width);
  return [top, mid, `  ${detailLine}`, bottom];
}

function render(logLines: string[]) {
  console.clear();
  console.log(`${BOLD}${CYAN}outreach-mock — live agent graph${RESET}\n`);

  const boxes = nodes.map(box);
  const rows = boxes[0].length;
  for (let r = 0; r < rows; r++) {
    const line = boxes.map((b) => b[r]).join(r === 1 ? "  ─▶  " : "      ");
    console.log(line);
  }

  console.log(`\n${DIM}── log ──${RESET}`);
  for (const line of logLines.slice(-24)) {
    console.log(`${DIM}${line}${RESET}`);
  }
  console.log("");
}

const log: string[] = [];

// Lazily connect to the dashboard server if it's running. If it's not
// (dashboard is optional), this just never fires — terminal output still
// works either way.
let dashboardSocket: WebSocket | null = null;
let dashboardTried = false;

function getDashboardSocket(): WebSocket | null {
  if (dashboardTried) return dashboardSocket;
  dashboardTried = true;
  try {
    const port = process.env.DASHBOARD_PORT ?? "4741";
    const ws = new WebSocket(`ws://localhost:${port}/?role=producer`);
    ws.on("error", () => {
      // Dashboard not running — that's fine, terminal rendering still works.
    });
    dashboardSocket = ws;
  } catch {
    dashboardSocket = null;
  }
  return dashboardSocket;
}

export function setNode(id: string, status: NodeStatus, detail?: string) {
  const node = nodes.find((n) => n.id === id);
  if (!node) return;
  node.status = status;
  if (detail !== undefined) node.detail = detail;

  const stamp = new Date().toLocaleTimeString();
  log.push(`[${stamp}] ${node.label}: ${status}${detail ? " — " + detail : ""}`);
  render(log);

  const socket = getDashboardSocket();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id, label: node.label, status, detail: node.detail }));
  }
}

// For detail lines that don't correspond to a pipeline-stage transition
// (e.g. per-channel filtering decisions) — appends to the persistent log
// panel without touching any node's status, and without clearing the
// terminal mid-listing.
export function logDetail(message: string) {
  const stamp = new Date().toLocaleTimeString();
  log.push(`[${stamp}] ${message}`);
  render(log);

  const socket = getDashboardSocket();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: "__log__", label: "log", status: "info", detail: message }));
  }
}

export function initGraph() {
  render(log);
}
