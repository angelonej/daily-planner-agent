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
import { NotificationAlert } from "../types.js";
import { randomUUID } from "crypto";

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

// ─── Calendar polling: alert 15 min and 1 min before events ───────────────
async function checkUpcomingEvents(): Promise<void> {
  try {
    const events = await getCalendarEvents(1); // today's events
    const now = Date.now();

    for (const ev of events) {
      if (!ev.eventId || !ev.start) continue;

      // Parse the start time — format from calendarTools is "Mon, Feb 24 at 9:00 AM"
      // We stored the original ISO via ev.start from calendarTools, but that's formatted.
      // Use a simpler approach: check events where start string contains today's date
      const startTs = parseEventTime(ev.start);
      if (!startTs) continue;

      const diffMin = (startTs - now) / 60_000;

      // 15-minute warning
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

      // 1-minute warning / starting now
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
