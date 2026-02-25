import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import { Email } from "../types.js";
import { useSSM, getTokenFromSSM, saveTokenToSSM } from "./ssmTools.js";

// ─── Token file paths (one per account) ─────────────────────────────────────
const TOKEN_DIR = path.resolve("tokens");

function getTokenPath(accountAlias: string): string {
  return path.join(TOKEN_DIR, `${accountAlias}.token.json`);
}

// ─── Build an authenticated OAuth2 client for a given account ───────────────
export function buildOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4242/oauth2callback"
  );
}

// ─── Load tokens from SSM (EC2) or filesystem (local) ───────────────────────
async function loadTokens(accountAlias: string, auth: OAuth2Client): Promise<void> {
  let tokens: Record<string, unknown>;

  if (useSSM()) {
    tokens = await getTokenFromSSM(accountAlias);
    auth.setCredentials(tokens);
    // Auto-save refreshed tokens back to SSM
    auth.on("tokens", async (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      await saveTokenToSSM(accountAlias, merged).catch(console.error);
    });
  } else {
    const tokenPath = getTokenPath(accountAlias);
    if (!fs.existsSync(tokenPath)) {
      throw new Error(
        `No token found for account "${accountAlias}". ` +
          `Run: npm run auth -- ${accountAlias}`
      );
    }
    tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    auth.setCredentials(tokens);
    // Auto-save refreshed tokens back to file
    auth.on("tokens", (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    });
  }
}

// ─── Importance heuristics ───────────────────────────────────────────────────
const IMPORTANT_KEYWORDS = [
  "urgent",
  "action required",
  "invoice",
  "payment",
  "contract",
  "offer",
  "closing",
  "alert",
  "deadline",
  "important",
  "follow up",
  "reminder",
  "overdue",
];

function detectImportant(subject: string, snippet: string, labels: string[]): boolean {
  const text = `${subject} ${snippet}`.toLowerCase();
  const hasKeyword = IMPORTANT_KEYWORDS.some((kw) => text.includes(kw));
  const hasImportantLabel =
    labels.includes("IMPORTANT") || labels.includes("STARRED");
  return hasKeyword || hasImportantLabel;
}

// ─── Fetch unread emails for one account ─────────────────────────────────────
export async function fetchUnreadEmails(
  accountAlias: string,
  maxResults = 20
): Promise<Email[]> {
  const auth = buildOAuth2Client();
  await loadTokens(accountAlias, auth);

  const gmail = google.gmail({ version: "v1", auth });

  // Get list of unread message IDs
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults,
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) return [];

  // Fetch each message in parallel (up to 10 at once)
  const batch = messages.slice(0, 10);
  const emails: Email[] = await Promise.all(
    batch.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });

      const headers = detail.data.payload?.headers ?? [];
      const get = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value ?? "";

      const labels = detail.data.labelIds ?? [];
      const subject = get("Subject") || "(no subject)";
      const snippet = detail.data.snippet ?? "";

      return {
        id: msg.id!,
        subject,
        from: get("From"),
        snippet,
        date: get("Date"),
        account: accountAlias,
        isImportant: detectImportant(subject, snippet, labels),
        labels,
      };
    })
  );

  return emails;
}

// ─── Search emails with a Gmail query (e.g. "from:john", "today", "subject:invoice") ──
export async function searchEmails(
  query: string,
  accountAlias?: string,
  maxResults = 10
): Promise<Email[]> {
  const accounts = accountAlias
    ? [accountAlias]
    : [
        process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal",
        process.env.GMAIL_ACCOUNT_2_ALIAS ?? "work",
      ];

  const results = await Promise.allSettled(
    accounts.map(async (alias) => {
      const auth = buildOAuth2Client();
      await loadTokens(alias, auth);
      const gmail = google.gmail({ version: "v1", auth });

      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const messages = listRes.data.messages ?? [];
      if (messages.length === 0) return [] as Email[];

      return Promise.all(
        messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const headers = detail.data.payload?.headers ?? [];
          const get = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
              ?.value ?? "";
          const labels = detail.data.labelIds ?? [];
          const subject = get("Subject") || "(no subject)";
          const snippet = detail.data.snippet ?? "";
          return {
            id: msg.id!,
            subject,
            from: get("From"),
            snippet,
            date: get("Date"),
            account: alias,
            isImportant: detectImportant(subject, snippet, labels),
            labels,
          } as Email;
        })
      );
    })
  );

  const emails: Email[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") emails.push(...r.value);
    else console.error("searchEmails error:", r.reason);
  }
  return emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// ─── Mark messages as read for a given account ──────────────────────────────
export async function markEmailsAsRead(
  accountAlias: string,
  query = "is:unread newer_than:1d"
): Promise<{ marked: number }> {
  const auth = buildOAuth2Client();
  await loadTokens(accountAlias, auth);
  const gmail = google.gmail({ version: "v1", auth });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) return { marked: 0 };

  await gmail.users.messages.batchModify({
    userId: "me",
    requestBody: {
      ids: messages.map((m) => m.id!),
      removeLabelIds: ["UNREAD"],
    },
  });

  return { marked: messages.length };
}

// ─── Fetch from BOTH configured Gmail accounts ───────────────────────────────
export async function fetchAllAccountEmails(): Promise<Email[]> {
  const accounts = [
    process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal",
    process.env.GMAIL_ACCOUNT_2_ALIAS ?? "work",
  ];

  const results = await Promise.allSettled(
    accounts.map((alias) => fetchUnreadEmails(alias))
  );

  const emails: Email[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      emails.push(...result.value);
    } else {
      console.error("Gmail fetch error:", result.reason);
    }
  }

  // Sort: important first, then by date descending
  return emails.sort((a, b) => {
    if (a.isImportant && !b.isImportant) return -1;
    if (!a.isImportant && b.isImportant) return 1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}
