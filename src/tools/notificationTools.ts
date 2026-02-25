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

import { Response } from "express";
import { getCalendarEvents } from "./calendarTools.js";
import { getTrafficDuration } from "./trafficTools.js";
import { NotificationAlert } from "../types.js";
import { randomUUID } from "crypto";

// ─── Last known GPS location from mobile client ─────────────────────────
let lastGpsLocation: { lat: number; lng: number; timestamp: number } | null = null;

export function updateUserLocation(lat: number, lng: number): void {
  lastGpsLocation = { lat, lng, timestamp: Date.now() };
}

/** Returns GPS coords as "lat,lng" if fresh (< 2 hours), otherwise null */
function getFreshGpsOrigin(): string | null {
  if (!lastGpsLocation) return null;
  const ageMs = Date.now() - lastGpsLocation.timestamp;
  if (ageMs > 2 * 60 * 60 * 1000) return null; // stale
  return `${lastGpsLocation.lat},${lastGpsLocation.lng}`;
}

// ─── SSE client registry ───────────────────────────────────────────────────
const sseClients = new Set<Response>();

export function addNotificationClient(res: Response): void {
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

export function removeNotificationClient(res: Response): void {
  sseClients.delete(res);
}

function broadcast(alert: NotificationAlert): void {
  if (sseClients.size === 0) return;
  const payload = `event: notification\ndata: ${JSON.stringify(alert)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
  console.log(`🔔 Notification sent (${sseClients.size} clients): ${alert.title}`);
}

// ─── Track already-fired alerts so we don't spam ──────────────────────────
const firedAlerts = new Set<string>(); // key: `${eventId}-${alertType}`

function pruneOldFiredAlerts(): void {
  // Keep the set from growing forever — clear keys older than today
  if (firedAlerts.size > 500) firedAlerts.clear();
}

// ─── Calendar polling: alert before events, with traffic info if location set ──
async function checkUpcomingEvents(): Promise<void> {
  try {
    const events = await getCalendarEvents(1); // today's events
    const now    = Date.now();
    const home   = process.env.HOME_ADDRESS;

    for (const ev of events) {
      if (!ev.eventId) continue;

      // Prefer the raw ISO startIso; fall back to parsing the formatted string
      const startTs = ev.startIso
        ? new Date(ev.startIso).getTime()
        : parseEventTime(ev.start);
      if (!startTs || isNaN(startTs)) continue;

      const diffMin = (startTs - now) / 60_000;
      if (diffMin < -5 || diffMin > 120) continue; // ignore past or far-future

      // ── Traffic-aware departure alert for events with a location ──────────
      if (ev.location && home) {
        const trafficKey = `${ev.eventId}-traffic-check`;
        if (!firedAlerts.has(trafficKey)) {
          firedAlerts.add(trafficKey);
          // Run async — don't block the poll loop
          void (async () => {
            try {
              // Use fresh GPS if available, otherwise fall back to home address
              const origin  = getFreshGpsOrigin() ?? home;
              const traffic = await getTrafficDuration(origin, ev.location!);
              if (!traffic) return;

              // Lead time = travel time + 10 min buffer, minimum 20 min
              const leadMin  = Math.max(20, traffic.durationTrafficMin + 10);
              const fireKey  = `${ev.eventId}-depart`;
              if (firedAlerts.has(fireKey)) return;

              const fireAt      = startTs - leadMin * 60_000;
              const nowCheck    = Date.now();
              const sinceFireAt = (nowCheck - fireAt) / 60_000;

              if (sinceFireAt >= 0 && sinceFireAt <= 2) {
                firedAlerts.add(fireKey);
                const leaveIn = Math.round(leadMin - traffic.durationTrafficMin);
                broadcast({
                  id:        randomUUID(),
                  type:      "event_soon",
                  title:     `🚗 Depart soon for ${ev.title}`,
                  body:      `${traffic.summary}\nLeave in ~${leaveIn} min to arrive on time.`,
                  eventId:   ev.eventId,
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (e) {
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
            id:        randomUUID(),
            type:      "event_soon",
            title:     `📅 Starting in ~15 min`,
            body:      `${ev.title}${ev.location ? ` @ ${ev.location}` : ""}`,
            eventId:   ev.eventId,
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
            id:        randomUUID(),
            type:      "event_starting",
            title:     `🚨 Starting now`,
            body:      `${ev.title}${ev.location ? ` @ ${ev.location}` : ""}`,
            eventId:   ev.eventId,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    pruneOldFiredAlerts();
  } catch (err) {
    // Don't crash the polling loop on transient errors
    console.error("Notification calendar check error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Parse a formatted time string like "Mon, Feb 24 at 9:00 AM" into a timestamp.
 * Falls back to null if unparseable.
 */
function parseEventTime(formatted: string): number | null {
  // The string looks like "Mon, Feb 24 at 9:00 AM" — add current year for parsing
  const year = new Date().getFullYear();
  // Remove leading weekday
  const cleaned = formatted.replace(/^[A-Za-z]+,\s*/, "");
  const ts = Date.parse(`${cleaned.replace(" at ", " ")}, ${year}`);
  return isNaN(ts) ? null : ts;
}

// ─── Heartbeat to keep SSE connections alive ───────────────────────────────
function sendHeartbeat(): void {
  if (sseClients.size === 0) return;
  const ping = "event: ping\ndata: heartbeat\n\n";
  for (const client of sseClients) {
    try { client.write(ping); } catch { sseClients.delete(client); }
  }
}

// ─── Public: start all polling ─────────────────────────────────────────────
let pollingStarted = false;

export function startNotificationPolling(): void {
  if (pollingStarted) return;
  pollingStarted = true;

  // Check calendar every 60 seconds
  setInterval(checkUpcomingEvents, 60_000);

  // Heartbeat every 30 seconds (keeps SSE alive through proxies/nginx)
  setInterval(sendHeartbeat, 30_000);

  console.log("🔔 Notification polling started (calendar: every 60s)");
}

/**
 * Manually push a notification — used by digestEmail.ts when the digest is sent
 */
export function pushNotification(alert: Omit<NotificationAlert, "id" | "timestamp">): void {
  broadcast({
    ...alert,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  });
}
