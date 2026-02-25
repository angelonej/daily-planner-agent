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
// ─── Last known GPS location from mobile client ─────────────────────────
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
    // Heartbeat every 30 seconds (keeps SSE alive through proxies/nginx)
    setInterval(sendHeartbeat, 30_000);
    console.log(`🔔 Notification polling started (calendar: every ${pollSec}s)`);
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
