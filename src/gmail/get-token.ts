import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import { SCOPES, TOKEN_PATH, getOAuthClient } from "./auth";

// One-time interactive OAuth flow: opens a consent URL for you to visit,
// spins up a tiny local server to catch the redirect, exchanges the code
// for tokens, and saves them to gmail-token.json for future runs.
async function main() {
  const oAuth2Client = getOAuthClient();

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n1. Open this URL in your browser and approve access:\n");
  console.log(authUrl);
  console.log("\n2. Waiting for you to approve... (this will complete automatically)\n");

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, "http://localhost:53682");
      const code = url.searchParams.get("code");
      if (code) {
        res.end("Authorization successful — you can close this tab and return to the terminal.");
        server.close();
        resolve(code);
      } else {
        res.end("No code found in callback.");
        server.close();
        reject(new Error("No code found in callback URL."));
      }
    });
    server.listen(53682);
  });

  const { tokens } = await oAuth2Client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nSaved Gmail token to ${TOKEN_PATH}. You can now send real emails.\n`);
}

main().catch((err) => {
  console.error("Gmail auth failed:", err);
  process.exit(1);
});
