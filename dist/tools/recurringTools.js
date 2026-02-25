/**
 * recurringTools.ts
 *
 * Analyzes your Google Calendar history (past N weeks) to identify
 * events that happen on a regular schedule, and suggests making them
 * official recurring events.
 *
 * Algorithm:
 *  1. Fetch all events from the past 4 weeks across all calendars
 *  2. Normalize titles (lowercase, strip punctuation)
 *  3. Group by (normalizedTitle, dayOfWeek)
 *  4. For groups with 2+ occurrences, calculate typical start/end time
 *  5. Return RecurringSuggestion[] sorted by confidence
 */
import { google } from "googleapis";
import { buildOAuth2Client } from "./gmailTools.js";
import fs from "fs";
import path from "path";
import { useSSM, getTokenFromSSM, saveTokenToSSM } from "./ssmTools.js";
const TOKEN_DIR = path.resolve("tokens");
async function buildCalendarClient() {
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
    auth.on("tokens", async (newTokens) => {
        const merged = { ...tokens, ...newTokens };
        if (useSSM()) {
            await saveTokenToSSM(alias, merged).catch(console.error);
        }
        else {
            const tokenPath = path.join(TOKEN_DIR, `${alias}.token.json`);
            fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
        }
    });
    return google.calendar({ version: "v3", auth });
}
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function toHHMM(date) {
    return date.toTimeString().slice(0, 5);
}
function medianTime(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const ms = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const d = new Date(ms);
    return toHHMM(d);
}
/**
 * Analyze calendar history and return recurring event suggestions.
 * @param weeksBack How many weeks to look back (default: 4)
 * @param minOccurrences Minimum occurrences to suggest (default: 2)
 */
export async function suggestRecurringEvents(weeksBack = 4, minOccurrences = 2) {
    const calendar = await buildCalendarClient();
    // Time range: past N weeks up to today
    const now = new Date();
    const timeMin = new Date(now.getTime() - weeksBack * 7 * 24 * 3600 * 1000).toISOString();
    const timeMax = now.toISOString();
    // Get all calendars
    const calListRes = await calendar.calendarList.list({ minAccessRole: "reader" });
    const calIds = (calListRes.data.items ?? [])
        .map((c) => c.id)
        .filter(Boolean);
    // Fetch events from all calendars in parallel
    const allEvents = [];
    await Promise.allSettled(calIds.map(async (calId) => {
        try {
            let pageToken;
            do {
                const res = await calendar.events.list({
                    calendarId: calId,
                    timeMin,
                    timeMax,
                    singleEvents: true,
                    orderBy: "startTime",
                    maxResults: 250,
                    pageToken,
                });
                for (const ev of res.data.items ?? []) {
                    if (!ev.summary)
                        continue;
                    // Skip all-day events (no time component)
                    const startStr = ev.start?.dateTime;
                    const endStr = ev.end?.dateTime;
                    if (!startStr || !endStr)
                        continue;
                    // Skip events that are already recurring
                    if (ev.recurrence || ev.recurringEventId)
                        continue;
                    allEvents.push({
                        title: ev.summary,
                        start: new Date(startStr),
                        end: new Date(endStr),
                        calendarId: calId,
                    });
                }
                pageToken = res.data.nextPageToken ?? undefined;
            } while (pageToken);
        }
        catch {
            // Skip calendars we can't read
        }
    }));
    const groups = new Map();
    for (const ev of allEvents) {
        const norm = normalizeTitle(ev.title);
        const dow = ev.start.getDay();
        const key = `${norm}::${dow}`;
        if (!groups.has(key)) {
            groups.set(key, { title: ev.title, dayOfWeek: dow, starts: [], ends: [] });
        }
        const g = groups.get(key);
        g.starts.push(ev.start.getTime());
        g.ends.push(ev.end.getTime());
        // Keep the original (non-normalized) title from latest occurrence
        g.title = ev.title;
    }
    // ─── Build suggestions ─────────────────────────────────────────────────
    const suggestions = [];
    for (const g of groups.values()) {
        if (g.starts.length < minOccurrences)
            continue;
        const typicalStart = medianTime(g.starts);
        const typicalEnd = medianTime(g.ends);
        const dayName = DAYS[g.dayOfWeek];
        const occ = g.starts.length;
        let confidence;
        if (occ >= 4)
            confidence = "high";
        else if (occ >= 3)
            confidence = "medium";
        else
            confidence = "low";
        // Check if times are consistent (std dev < 30 min)
        if (g.starts.length >= 2) {
            const mean = g.starts.reduce((a, b) => a + b, 0) / g.starts.length;
            const stdDev = Math.sqrt(g.starts.reduce((a, b) => a + (b - mean) ** 2, 0) / g.starts.length);
            if (stdDev > 30 * 60 * 1000)
                confidence = "low"; // > 30 min variance
        }
        suggestions.push({
            title: g.title,
            dayOfWeek: dayName,
            typicalStart,
            typicalEnd,
            occurrences: occ,
            confidence,
            suggestedRule: `Weekly on ${dayName} at ${formatTime12h(typicalStart)}`,
        });
    }
    // Sort: high confidence first, then by occurrences
    const confOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence] || b.occurrences - a.occurrences);
    return suggestions;
}
function formatTime12h(hhmm) {
    const [hStr, mStr] = hhmm.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const suffix = h >= 12 ? "PM" : "AM";
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}
/** Format suggestions as a readable string for chat display */
export function formatRecurringSuggestions(suggestions) {
    if (suggestions.length === 0) {
        return "No recurring patterns found in the past 4 weeks. You may not have enough calendar history yet.";
    }
    const lines = suggestions.map((s, i) => {
        const conf = s.confidence === "high" ? "🟢" : s.confidence === "medium" ? "🟡" : "🔴";
        return `${i + 1}. ${conf} **${s.title}**\n   ${s.suggestedRule} (seen ${s.occurrences}× in past 4 weeks)\n   Typical time: ${formatTime12h(s.typicalStart)}–${formatTime12h(s.typicalEnd)}`;
    });
    return `📅 **Recurring Event Suggestions** (based on past ${4} weeks):\n\n${lines.join("\n\n")}\n\nWant me to create any of these as recurring calendar events?`;
}
