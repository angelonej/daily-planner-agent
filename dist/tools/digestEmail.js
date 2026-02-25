/**
 * digestEmail.ts
 *
 * Sends the morning briefing as a formatted HTML email to the user
 * via the Gmail API (using the personal account's send scope).
 *
 * Scheduling:
 *   - Called by coordinator.ts using node-cron at 7:00 AM daily
 *   - Can also be triggered manually via chat: "send me the digest email"
 *
 * Requires: gmail send scope in personal account token.
 * If the token was generated without it, re-run: npm run auth -- personal
 */
import { google } from "googleapis";
import { buildOAuth2Client } from "./gmailTools.js";
import fs from "fs";
import path from "path";
import { useSSM, getTokenFromSSM } from "./ssmTools.js";
const TOKEN_DIR = path.resolve("tokens");
async function buildGmailSendClient() {
    const alias = process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal";
    const auth = buildOAuth2Client();
    let tokens;
    if (useSSM()) {
        tokens = await getTokenFromSSM(alias);
    }
    else {
        const tokenPath = path.join(TOKEN_DIR, `${alias}.token.json`);
        if (!fs.existsSync(tokenPath))
            throw new Error(`No token for ${alias}. Run: npm run auth -- ${alias}`);
        tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    }
    auth.setCredentials(tokens);
    return google.gmail({ version: "v1", auth });
}
/** Encode a raw RFC 2822 message to base64url for Gmail API */
function encodeMessage(raw) {
    return Buffer.from(raw)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
/** Build a minimal RFC 2822 message with HTML body */
function buildEmailRaw(to, subject, html) {
    const boundary = "----=_Part_daily_planner";
    return [
        `To: ${to}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        html.replace(/<[^>]+>/g, ""), // strip HTML for plain-text fallback
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset="UTF-8"`,
        ``,
        html,
        ``,
        `--${boundary}--`,
    ].join("\r\n");
}
/** Convert the morning briefing to an HTML email */
function briefingToHtml(briefing) {
    const date = new Date().toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const weatherHtml = briefing.weather
        ? `<p>🌡️ ${briefing.weather.temperatureF}°F, feels like ${briefing.weather.feelsLikeF}°F — ${briefing.weather.condition}<br>
       💧 ${briefing.weather.humidity}% humidity · 💨 ${briefing.weather.windSpeedMph} mph wind<br>
       🌅 Sunrise ${briefing.weather.sunrise} · 🌇 Sunset ${briefing.weather.sunset}<br>
       High ${briefing.weather.high}°F / Low ${briefing.weather.low}°F · ☔ ${briefing.weather.precipChance}% precip</p>`
        : "<p>Weather unavailable.</p>";
    const calHtml = briefing.calendar.length > 0
        ? briefing.calendar
            .map((e) => `<li><b>${e.start}–${e.end}</b>: ${e.title}${e.location ? ` @ ${e.location}` : ""}</li>`)
            .join("")
        : "<li>No events today.</li>";
    const importantHtml = briefing.importantEmails.length > 0
        ? briefing.importantEmails
            .map((e) => `<li><b>[${e.account}]</b> ${e.subject} — <i>${e.from}</i><br><small>${e.snippet}</small></li>`)
            .join("")
        : "<li>None.</li>";
    const emailHtml = briefing.emails.slice(0, 8)
        .map((e) => `<li>[${e.account}] <b>${e.subject}</b> — ${e.from}</li>`)
        .join("") || "<li>Inbox is clear.</li>";
    const taskHtml = briefing.googleTasks.length > 0
        ? briefing.googleTasks
            .map((t) => `<li>${t.status === "completed" ? "✅" : "☐"} ${t.title}${t.due ? ` <small>(due ${new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })})</small>` : ""}</li>`)
            .join("")
        : "<li>No tasks.</li>";
    const newsHtml = briefing.news.length > 0
        ? briefing.news
            .map((n) => `<h4>${n.topic}</h4><ul>${n.articles.slice(0, 3).map((a) => `<li><a href="${a.url}">${a.title}</a></li>`).join("")}</ul>`)
            .join("")
        : "<p>No news loaded.</p>";
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #1a1a2e; background: #f8f9fa; }
  h1 { color: #667eea; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
  h3 { color: #4a4a6a; margin-top: 24px; margin-bottom: 8px; }
  h4 { color: #6a6a8a; margin: 10px 0 4px; }
  ul { padding-left: 20px; margin: 4px 0; }
  li { margin: 4px 0; line-height: 1.5; }
  .section { background: white; border-radius: 8px; padding: 16px; margin: 12px 0; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  a { color: #667eea; text-decoration: none; }
  small { color: #888; }
</style></head>
<body>
  <h1>☀️ Good Morning!</h1>
  <p style="color:#888">${date}</p>

  <div class="section"><h3>🌤️ Weather</h3>${weatherHtml}</div>
  <div class="section"><h3>📅 Calendar</h3><ul>${calHtml}</ul></div>
  <div class="section"><h3>⚠️ Important Emails (${briefing.importantEmails.length})</h3><ul>${importantHtml}</ul></div>
  <div class="section"><h3>📧 Unread Emails (${briefing.emails.length})</h3><ul>${emailHtml}</ul></div>
  <div class="section"><h3>✅ Tasks (${briefing.googleTasks.length})</h3><ul>${taskHtml}</ul></div>
  <div class="section"><h3>📰 Morning News</h3>${newsHtml}</div>

  <p style="color:#bbb;font-size:12px;margin-top:24px">Sent by your Daily Planner Agent · <a href="http://localhost:3000">Open web app</a></p>
</body>
</html>`;
}
/**
 * Send the morning briefing as an email.
 * @param briefing  The built MorningBriefing object
 * @param toEmail   Recipient email (defaults to DIGEST_EMAIL_TO env var)
 */
export async function sendDailyDigestEmail(briefing, toEmail) {
    const to = toEmail ?? process.env.DIGEST_EMAIL_TO;
    if (!to) {
        return { success: false, error: "No recipient. Set DIGEST_EMAIL_TO in .env" };
    }
    try {
        const gmail = await buildGmailSendClient();
        const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        const subject = `☀️ Daily Briefing — ${date}`;
        const html = briefingToHtml(briefing);
        const raw = buildEmailRaw(to, subject, html);
        const encoded = encodeMessage(raw);
        const result = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: encoded },
        });
        console.log(`📧 Digest email sent to ${to} (id: ${result.data.id})`);
        return { success: true, messageId: result.data.id ?? undefined };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Digest email error:", msg);
        return { success: false, error: msg };
    }
}
