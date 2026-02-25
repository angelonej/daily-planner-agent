/**
 * notificationTools.ts
 *
 * Server-Sent Events (SSE) notification system.
 * - Polls calendar every minute for events starting within the next 15 min
 * - Polls Gmail every 5 minutes for new important emails
 * - Pushes NotificationAlert objects to all connected browser clients
 *
 * Usage in index.ts:
 *   import { addNotificationClient, removeNotificationClient, startNotificationPolling } from "./tools/notificationTools.js";
 *   app.get("/notifications", (req, res) => { ... addNotificationClient(res); });
 *   startNotificationPolling();
 */
import { getCalendarEvents } from "./calendarTools.js";
import { getTrafficDuration } from "./trafficTools.js";
import { listTasks } from "./tasksTools.js";
import { getDueReminders, markFired } from "./remindersTools.js";
import { fetchAllAccountEmails } from "./gmailTools.js";
import { randomUUID } from "crypto";
import webpush from "web-push";
import fs from "fs";
import path from "path";
// ─── Web Push: VAPID setup + subscription store ────────────────────────────
const SUBS_FILE = path.resolve("data", "push-subscriptions.json");
function loadSubscriptions() {
    try {
        if (!fs.existsSync(SUBS_FILE))
            return [];
        return JSON.parse(fs.readFileSync(SUBS_FILE, "utf-8"));
    }
    catch {
        return [];
    }
}
function saveSubscriptions(subs) {
    try {
        fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
        fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), "utf-8");
    }
    catch (err) {
        console.error("push-sub save error:", err);
    }
}
export function addPushSubscription(sub) {
    const subs = loadSubscriptions();
    // Deduplicate by endpoint
    const filtered = subs.filter((s) => s.endpoint !== sub.endpoint);
    filtered.push(sub);
    saveSubscriptions(filtered);
}
function initVapid() {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const mail = process.env.VAPID_EMAIL ?? "mailto:admin@example.com";
    if (pub && priv) {
        webpush.setVapidDetails(mail, pub, priv);
        console.log("🔔 Web Push VAPID configured");
    }
    else {
        console.warn("⚠️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled");
    }
}
initVapid();
// ─── Last known GPS location from mobile client ───────────────────────
let lastGpsLocation = null;
export function updateUserLocation(lat, lng) {
    lastGpsLocation = { lat, lng, timestamp: Date.now() };
}
/** Returns GPS coords as "lat,lng" if fresh (< 2 hours), otherwise null */
function getFreshGpsOrigin() {
    if (!lastGpsLocation)
        return null;
    const ageMs = Date.now() - lastGpsLocation.timestamp;
    if (ageMs > 2 * 60 * 60 * 1000)
        return null; // stale
    return `${lastGpsLocation.lat},${lastGpsLocation.lng}`;
}
// ─── VIP senders & filter keywords (set from settings API) ─────────────────
let runtimeVipSenders = (process.env.VIP_SENDERS ?? "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
let runtimeFilterKeywords = (process.env.FILTER_KEYWORDS ?? "")
    .split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
export function getVipSenders() { return [...runtimeVipSenders]; }
export function setVipSenders(senders) { runtimeVipSenders = senders; }
export function getFilterKeywords() { return [...runtimeFilterKeywords]; }
export function setFilterKeywords(keywords) { runtimeFilterKeywords = keywords; }
// ─── SSE client registry ───────────────────────────────────────────────────
const sseClients = new Set();
export function addNotificationClient(res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();
    // Send a heartbeat immediately so the browser knows we're alive
    res.write("event: ping\ndata: connected\n\n");
    sseClients.add(res);
    res.on("close", () => {
        sseClients.delete(res);
    });
}
export function removeNotificationClient(res) {
    sseClients.delete(res);
}
function broadcast(alert) {
    // 1. SSE — push to open browser tabs
    const payload = `event: notification\ndata: ${JSON.stringify(alert)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        }
        catch {
            sseClients.delete(client);
        }
    }
    // 2. Web Push — push to subscribed browsers even when closed
    const pub = process.env.VAPID_PUBLIC_KEY;
    if (pub) {
        const subs = loadSubscriptions();
        const pushPayload = JSON.stringify({ title: alert.title, body: alert.body, tag: alert.id });
        const dead = [];
        for (const sub of subs) {
            webpush.sendNotification(sub, pushPayload).catch((err) => {
                if (err.statusCode === 410 || err.statusCode === 404)
                    dead.push(sub.endpoint);
                else
                    console.error("Web Push send error:", err.message);
            });
        }
        if (dead.length) {
            // Remove expired subscriptions
            saveSubscriptions(loadSubscriptions().filter((s) => !dead.includes(s.endpoint)));
        }
    }
    console.log(`🔔 Notification sent (SSE: ${sseClients.size}, push subs: ${loadSubscriptions().length}): ${alert.title}`);
}
// ─── Track already-fired alerts so we don't spam ──────────────────────────
const firedAlerts = new Set(); // key: `${eventId}-${alertType}`
function pruneOldFiredAlerts() {
    // Keep the set from growing forever — clear keys older than today
    if (firedAlerts.size > 500)
        firedAlerts.clear();
}
// ─── Calendar polling: alert before events, with traffic info if location set ──
async function checkUpcomingEvents() {
    try {
        const events = await getCalendarEvents(1); // today's events
        const now = Date.now();
        const home = process.env.HOME_ADDRESS;
        for (const ev of events) {
            if (!ev.eventId)
                continue;
            // Prefer the raw ISO startIso; fall back to parsing the formatted string
            const startTs = ev.startIso
                ? new Date(ev.startIso).getTime()
                : parseEventTime(ev.start);
            if (!startTs || isNaN(startTs))
                continue;
            const diffMin = (startTs - now) / 60_000;
            if (diffMin < -5 || diffMin > 120)
                continue; // ignore past or far-future
            // ── Traffic-aware departure alert for events with a location ──────────
            if (ev.location && home) {
                const trafficKey = `${ev.eventId}-traffic-check`;
                if (!firedAlerts.has(trafficKey)) {
                    firedAlerts.add(trafficKey);
                    // Run async — don't block the poll loop
                    void (async () => {
                        try {
                            // Use fresh GPS if available, otherwise fall back to home address
                            const origin = getFreshGpsOrigin() ?? home;
                            const traffic = await getTrafficDuration(origin, ev.location);
                            if (!traffic)
                                return;
                            // Lead time = travel time + 10 min buffer, minimum 20 min
                            const leadMin = Math.max(20, traffic.durationTrafficMin + 10);
                            const fireKey = `${ev.eventId}-depart`;
                            if (firedAlerts.has(fireKey))
                                return;
                            const fireAt = startTs - leadMin * 60_000;
                            const nowCheck = Date.now();
                            const sinceFireAt = (nowCheck - fireAt) / 60_000;
                            if (sinceFireAt >= 0 && sinceFireAt <= 2) {
                                firedAlerts.add(fireKey);
                                const leaveIn = Math.round(leadMin - traffic.durationTrafficMin);
                                broadcast({
                                    id: randomUUID(),
                                    type: "event_soon",
                                    title: `🚗 Depart soon for ${ev.title}`,
                                    body: `${traffic.summary}\nLeave in ~${leaveIn} min to arrive on time.`,
                                    eventId: ev.eventId,
                                    timestamp: new Date().toISOString(),
                                });
                            }
                        }
                        catch (e) {
                            console.error("Traffic alert error:", e);
                        }
                    })();
                }
            }
            // ── Standard 15-minute warning ────────────────────────────────────────
            if (diffMin > 13 && diffMin <= 16) {
                const key = `${ev.eventId}-15min`;
                if (!firedAlerts.has(key)) {
                    firedAlerts.add(key);
                    broadcast({
                        id: randomUUID(),
                        type: "event_soon",
                        title: `📅 Starting in ~15 min`,
                        body: `${ev.title}${ev.location ? ` @ ${ev.location}` : ""}`,
                        eventId: ev.eventId,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
            // ── Starting-now warning ──────────────────────────────────────────────
            if (diffMin > -2 && diffMin <= 2) {
                const key = `${ev.eventId}-starting`;
                if (!firedAlerts.has(key)) {
                    firedAlerts.add(key);
                    broadcast({
                        id: randomUUID(),
                        type: "event_starting",
                        title: `🚨 Starting now`,
                        body: `${ev.title}${ev.location ? ` @ ${ev.location}` : ""}`,
                        eventId: ev.eventId,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
        }
        pruneOldFiredAlerts();
    }
    catch (err) {
        // Don't crash the polling loop on transient errors
        console.error("Notification calendar check error:", err instanceof Error ? err.message : err);
    }
}
/**
 * Parse a formatted time string like "Mon, Feb 24 at 9:00 AM" into a timestamp.
 * Falls back to null if unparseable.
 */
function parseEventTime(formatted) {
    // The string looks like "Mon, Feb 24 at 9:00 AM" — add current year for parsing
    const year = new Date().getFullYear();
    // Remove leading weekday
    const cleaned = formatted.replace(/^[A-Za-z]+,\s*/, "");
    const ts = Date.parse(`${cleaned.replace(" at ", " ")}, ${year}`);
    return isNaN(ts) ? null : ts;
}
// ─── Task due-date reminders ───────────────────────────────────────────────
async function checkUpcomingTasks() {
    try {
        const tasks = await listTasks(50);
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
        // Group overdue + due today
        const dueNow = tasks.filter(t => {
            if (!t.due)
                return false;
            const dueDate = t.due.slice(0, 10); // Google Tasks due is ISO date at midnight UTC
            return dueDate <= todayStr;
        });
        if (dueNow.length === 0)
            return;
        // Fire one summary notification per day (first poll after 8 AM local)
        const localHour = now.toLocaleString("en-US", {
            hour: "numeric", hour12: false, timeZone: process.env.TIMEZONE ?? "America/New_York",
        });
        const hour = parseInt(localHour);
        if (hour < 8)
            return; // don't fire before 8 AM
        const dailyKey = `task-due-summary-${todayStr}`;
        if (firedAlerts.has(dailyKey))
            return;
        firedAlerts.add(dailyKey);
        // Group by list for a clean message
        const byList = new Map();
        for (const t of dueNow) {
            const list = t.listTitle || "Tasks";
            if (!byList.has(list))
                byList.set(list, []);
            byList.get(list).push(t.title);
        }
        const lines = [];
        for (const [list, titles] of byList) {
            lines.push(`${list}: ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? ` +${titles.length - 3} more` : ""}`);
        }
        broadcast({
            id: randomUUID(),
            type: "task_reminder",
            title: `📋 ${dueNow.length} task${dueNow.length > 1 ? "s" : ""} due today`,
            body: lines.join("\n"),
            timestamp: new Date().toISOString(),
        });
    }
    catch (err) {
        console.error("Task reminder check error:", err instanceof Error ? err.message : err);
    }
}
// ─── Recurring reminder polling ──────────────────────────────────────────────
async function checkRecurringReminders() {
    try {
        const tz = process.env.TIMEZONE ?? "America/New_York";
        const due = getDueReminders(tz);
        for (const r of due) {
            const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
            markFired(r.id, todayStr);
            broadcast({
                id: randomUUID(),
                type: "task_reminder",
                title: `🔔 ${r.title}`,
                body: r.notes ?? describeReminderFreq(r.frequency, r.dayOfWeek, r.dayOfMonth, r.month),
                timestamp: new Date().toISOString(),
            });
            console.log(`🔔 Recurring reminder fired: ${r.title}`);
        }
    }
    catch (err) {
        console.error("Recurring reminder check error:", err instanceof Error ? err.message : err);
    }
}
function describeReminderFreq(freq, dayOfWeek, dayOfMonth, month) {
    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (freq === "weekly")
        return `Weekly on ${DAY_NAMES[dayOfWeek ?? 0]}`;
    if (freq === "monthly")
        return `Monthly on the ${dayOfMonth}`;
    if (freq === "yearly")
        return `Yearly on ${MONTH_NAMES[month ?? 1]} ${dayOfMonth}`;
    return "Daily reminder";
}
// ─── VIP email polling ─────────────────────────────────────────────────────
// Track the latest email id seen to avoid re-alerting
let lastSeenEmailId = null;
async function checkVipEmails() {
    if (runtimeVipSenders.length === 0)
        return; // no VIPs configured
    try {
        const emails = await fetchAllAccountEmails();
        if (emails.length === 0)
            return;
        // Find the first email we haven’t seen yet
        const firstNewIndex = lastSeenEmailId
            ? emails.findIndex((e) => e.id === lastSeenEmailId)
            : emails.length;
        const newEmails = firstNewIndex > 0 ? emails.slice(0, firstNewIndex) : [];
        // Update the watermark
        if (emails[0])
            lastSeenEmailId = emails[0].id;
        for (const email of newEmails) {
            const fromLower = email.from.toLowerCase();
            const isVip = runtimeVipSenders.some((v) => fromLower.includes(v));
            if (!isVip)
                continue;
            const alertKey = `vip-email-${email.id}`;
            if (firedAlerts.has(alertKey))
                continue;
            firedAlerts.add(alertKey);
            broadcast({
                id: randomUUID(),
                type: "vip_email",
                title: `⭐ VIP email from ${email.from.split("<")[0].trim()}`,
                body: email.subject,
                timestamp: new Date().toISOString(),
            });
            console.log(`⭐ VIP email alert: ${email.from} - ${email.subject}`);
        }
    }
    catch (err) {
        console.error("VIP email check error:", err instanceof Error ? err.message : err);
    }
}
// ─── Heartbeat to keep SSE connections alive ───────────────────────────────
function sendHeartbeat() {
    if (sseClients.size === 0)
        return;
    const ping = "event: ping\ndata: heartbeat\n\n";
    for (const client of sseClients) {
        try {
            client.write(ping);
        }
        catch {
            sseClients.delete(client);
        }
    }
}
// ─── Public: start all polling ─────────────────────────────────────────────
let pollingStarted = false;
export function startNotificationPolling() {
    if (pollingStarted)
        return;
    pollingStarted = true;
    // Configurable via NOTIFICATION_POLL_SECONDS env var (default: 60, min: 15)
    const pollSec = Math.max(15, Number(process.env.NOTIFICATION_POLL_SECONDS ?? 60));
    setInterval(checkUpcomingEvents, pollSec * 1_000);
    // Task due-date reminders — check every 15 minutes
    setInterval(checkUpcomingTasks, 15 * 60 * 1_000);
    // Also fire once 30 seconds after startup (so morning reminders hit quickly)
    setTimeout(checkUpcomingTasks, 30_000);
    // Recurring reminders — check every minute (they fire on the exact minute)
    setInterval(checkRecurringReminders, 60_000);
    // VIP email alerts — poll every 5 minutes
    setInterval(checkVipEmails, 5 * 60_000);
    setTimeout(checkVipEmails, 10_000); // initial check 10s after startup
    // Heartbeat every 30 seconds (keeps SSE alive through proxies/nginx)
    setInterval(sendHeartbeat, 30_000);
    console.log(`🔔 Notification polling started (calendar: every ${pollSec}s, tasks: every 15min, reminders: every 1min, VIP email: every 5min)`);
}
/**
 * Manually push a notification — used by digestEmail.ts when the digest is sent
 */
export function pushNotification(alert) {
    broadcast({
        ...alert,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
    });
}
