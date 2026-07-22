import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 4741);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server });
const browsers = new Set<WebSocket>();

wss.on("connection", (ws, req) => {
  const isProducer = req.url?.includes("role=producer");

  if (isProducer) {
    // The agent run (src/run.ts) connects here and pushes trace events —
    // just relay every message straight to any connected dashboard tabs.
    ws.on("message", (data) => {
      for (const browser of browsers) {
        if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
      }
    });
  } else {
    browsers.add(ws);
    ws.on("close", () => browsers.delete(ws));
  }
});

server.listen(PORT, () => {
  console.log(`\nDashboard running at http://localhost:${PORT}\n`);
  console.log("Open that URL in your browser, then run your agent in another terminal:");
  console.log("  npm run dev -- \"halal fitness\"\n");
});
