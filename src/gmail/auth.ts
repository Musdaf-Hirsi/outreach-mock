import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";

// gmail.readonly (rather than the narrower gmail.metadata) is needed so
// auto-reply-detection can read a thread's actual message bodies/headers to
// tell a real reply apart from our own sent messages — metadata-only scope
// wouldn't be enough to reliably identify the sender on older messages
// missing a clean From header cache. Adding this scope means an existing
// gmail-token.json (authorized under the old send-only scope) stops being
// sufficient — re-run `npm run gmail-auth` once to get a token that covers
// both scopes.
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = path.resolve("gmail-token.json");

function getOAuthClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI ?? "http://localhost:53682/callback";

  if (!clientId || !clientSecret) {
    throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// Loads a previously saved refresh token from gmail-token.json (created by
// `npm run gmail-auth`) and returns a ready-to-use authenticated client.
export async function getAuthorizedGmailClient() {
  const oAuth2Client = getOAuthClient();

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `No saved Gmail token found at ${TOKEN_PATH}. Run "npm run gmail-auth" once to authorize this app.`,
    );
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

export { SCOPES, TOKEN_PATH, getOAuthClient };
