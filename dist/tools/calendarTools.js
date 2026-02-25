import { google } from "googleapis";
import { buildOAuth2Client } from "./gmailTools.js";
import fs from "fs";
import path from "path";
import { useSSM, getTokenFromSSM, saveTokenToSSM } from "./ssmTools.js";
const TOKEN_DIR = path.resolve("tokens");
async function loadCalendarTokens() {
    const alias = process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal";
    if (useSSM()) {
        return getTokenFromSSM(alias);
    }
    const tokenPath = path.join(TOKEN_DIR, `${alias}.token.json`);
    if (!fs.existsSync(tokenPath)) {
        throw new Error(`No token found for calendar account "${alias}". ` +
            `Run: npm run auth -- ${alias}`);
    }
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
}
async function buildCalendarClient() {
    const auth = buildOAuth2Client();
    const tokens = await loadCalendarTokens();
    auth.setCredentials(tokens);
    // Auto-save refreshed tokens
    const alias = process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal";
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
// ─── Helper: resolve a natural-ish date+time string to a full ISO datetime ─
// Accepts "2026-02-25T14:00" or "2026-02-25" (all-day)
function toGoogleDateTime(iso) {
    const tz = process.env.TIMEZONE ?? "America/New_York";
    if (iso.includes("T")) {
        return { dateTime: iso.includes("Z") || iso.includes("+") ? iso : `${iso}:00`, timeZone: tz };
    }
    return { date: iso };
}
// ─── Helper: get all writable + readable calendar IDs ────────────────────
async function getAllCalendarIds(calendar) {
    const res = await calendar.calendarList.list({ minAccessRole: "reader" });
    return (res.data.items ?? [])
        .filter((c) => c.id && c.selected !== false)
        .map((c) => ({ id: c.id, primary: Boolean(c.primary) }));
}
// ─── Helper: format event start/end ISO to readable time ─────────────────
function fmtEventTime(iso) {
    if (!iso)
        return "";
    const d = new Date(iso);
    if (isNaN(d.getTime()))
        return iso;
    return iso.includes("T")
        ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: process.env.TIMEZONE ?? "America/New_York" })
        : "All Day";
}
export async function getCalendarEventsByRange(startIso, endIso) {
    const calendar = await buildCalendarClient();
    const calendarIds = await getAllCalendarIds(calendar);
    const allEvents = [];
    await Promise.all(calendarIds.map(async ({ id }) => {
        try {
            const res = await calendar.events.list({
                calendarId: id,
                timeMin: new Date(startIso).toISOString(),
                timeMax: new Date(endIso).toISOString(),
                singleEvents: true,
                orderBy: "startTime",
                maxResults: 100,
            });
            for (const event of res.data.items ?? []) {
                const start = event.start?.dateTime ?? event.start?.date ?? "";
                const end = event.end?.dateTime ?? event.end?.date ?? "";
                allEvents.push({
                    start: fmtEventTime(start),
                    end: fmtEventTime(end),
                    title: event.summary ?? "(no title)",
                    location: event.location ?? undefined,
                    description: event.description ?? undefined,
                    eventId: event.id ?? undefined,
                });
            }
        }
        catch { }
    }));
    allEvents.sort((a, b) => a.start.localeCompare(b.start));
    return allEvents;
}
export async function getCalendarEvents(daysAhead = 1) {
    const calendar = await buildCalendarClient();
    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setHours(0, 0, 0, 0);
    const timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + daysAhead);
    // Fetch all calendars the user has access to
    const calendarIds = await getAllCalendarIds(calendar);
    const allEvents = [];
    await Promise.all(calendarIds.map(async ({ id }) => {
        try {
            const res = await calendar.events.list({
                calendarId: id,
                timeMin: timeMin.toISOString(),
                timeMax: timeMax.toISOString(),
                singleEvents: true,
                orderBy: "startTime",
                maxResults: 50,
            });
            for (const event of res.data.items ?? []) {
                const start = event.start?.dateTime ?? event.start?.date ?? "";
                const end = event.end?.dateTime ?? event.end?.date ?? "";
                allEvents.push({
                    start: fmtEventTime(start),
                    end: fmtEventTime(end),
                    title: event.summary ?? "(no title)",
                    location: event.location ?? undefined,
                    description: event.description ?? undefined,
                    eventId: event.id ?? undefined,
                });
            }
        }
        catch (err) {
            // Skip calendars we can't read (e.g. holidays calendar, deleted shared)
            console.warn(`Skipping calendar ${id}:`, err.message);
        }
    }));
    // Sort all events by start time
    allEvents.sort((a, b) => a.start.localeCompare(b.start));
    return allEvents;
}
// ─── Create a new event ────────────────────────────────────────────────────
export async function createCalendarEvent(params) {
    const calendar = await buildCalendarClient();
    const res = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
            summary: params.title,
            location: params.location,
            description: params.description,
            start: toGoogleDateTime(params.startIso),
            end: toGoogleDateTime(params.endIso),
        },
    });
    return {
        eventId: res.data.id ?? "",
        link: res.data.htmlLink ?? "",
    };
}
// ─── Update an existing event by ID ───────────────────────────────────────
export async function updateCalendarEvent(params) {
    const calendar = await buildCalendarClient();
    // First fetch the existing event to avoid wiping fields
    const existing = await calendar.events.get({
        calendarId: "primary",
        eventId: params.eventId,
    });
    const patch = {};
    if (params.title !== undefined)
        patch.summary = params.title;
    if (params.location !== undefined)
        patch.location = params.location;
    if (params.description !== undefined)
        patch.description = params.description;
    if (params.startIso !== undefined)
        patch.start = toGoogleDateTime(params.startIso);
    if (params.endIso !== undefined)
        patch.end = toGoogleDateTime(params.endIso);
    await calendar.events.patch({
        calendarId: "primary",
        eventId: params.eventId,
        requestBody: patch,
    });
}
// ─── Delete an event by ID ────────────────────────────────────────────────
export async function deleteCalendarEvent(eventId) {
    const calendar = await buildCalendarClient();
    await calendar.events.delete({ calendarId: "primary", eventId });
}
// ─── Find events by title keyword across ALL calendars ────────────────────
export async function findEventsByTitle(query, daysToSearch = 14) {
    const calendar = await buildCalendarClient();
    const timeMin = new Date();
    timeMin.setHours(0, 0, 0, 0);
    const timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + daysToSearch);
    const calendarIds = await getAllCalendarIds(calendar);
    const allEvents = [];
    await Promise.all(calendarIds.map(async ({ id }) => {
        try {
            const res = await calendar.events.list({
                calendarId: id,
                timeMin: timeMin.toISOString(),
                timeMax: timeMax.toISOString(),
                q: query,
                singleEvents: true,
                orderBy: "startTime",
                maxResults: 10,
            });
            for (const event of res.data.items ?? []) {
                const start = event.start?.dateTime ?? event.start?.date ?? "";
                const end = event.end?.dateTime ?? event.end?.date ?? "";
                allEvents.push({
                    start: fmtEventTime(start),
                    end: fmtEventTime(end),
                    title: event.summary ?? "(no title)",
                    location: event.location ?? undefined,
                    description: event.description ?? undefined,
                    eventId: event.id ?? undefined,
                });
            }
        }
        catch (err) {
            console.warn(`Skipping calendar ${id} in search:`, err.message);
        }
    }));
    allEvents.sort((a, b) => a.start.localeCompare(b.start));
    return allEvents;
}
