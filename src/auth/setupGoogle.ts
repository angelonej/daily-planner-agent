/**
 * Google OAuth2 Setup Helper
 *
 * Run this once per Gmail account to generate and save a refresh token.
 *
 * Usage:
 *   npm run auth -- personal      (for your first Gmail account)
 *   npm run auth -- work          (for your second Gmail account)
 *
 * A browser window will open automatically. After you authorize,
 * the token is saved to tokens/<alias>.token.json
 */

import { google } from "googleapis";
import http from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",    // send digest emails
  "https://www.googleapis.com/auth/calendar",      // read + write
  "https://www.googleapis.com/auth/tasks",         // Google Tasks read + write
];

const REDIRECT_URI = "http://localhost:4242/oauth2callback";
const TOKEN_DIR = path.resolve("tokens");

async function main() {
  const alias = process.argv[2];
  if (!alias) {
    console.error("Usage: npm run auth -- <account-alias>");
    console.error("  e.g. npm run auth -- personal");
    console.error("       npm run auth -- work");
    process.exit(1);
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log(`\n🔐 Authorizing account: "${alias}"`);
  console.log("\nOpening browser... (if it doesn't open, visit the URL manually)");
  console.log("\n  " + authUrl + "\n");

  // Try to open browser automatically
  const { exec } = await import("child_process");
  exec(`start "" "${authUrl}"`);

  // Spin up a temporary localhost server to capture the redirect
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, "http://localhost:4242");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.end("<h2>No code received.</h2>");
          return;
        }

        res.end("<h2>✅ Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>");
        server.close();

        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);

        if (!fs.existsSync(TOKEN_DIR)) {
          fs.mkdirSync(TOKEN_DIR, { recursive: true });
        }

        const tokenPath = path.join(TOKEN_DIR, `${alias}.token.json`);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

        console.log(`\n✅ Token saved to: ${tokenPath}`);
        console.log(`   Account alias "${alias}" is ready.\n`);
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    server.listen(4242, () => {
      console.log("Waiting for Google to redirect back (listening on http://localhost:4242)...");
    });

    server.on("error", reject);
  });
}

main().catch((err) => {
  console.error("Auth failed:", err);
  process.exit(1);
});
