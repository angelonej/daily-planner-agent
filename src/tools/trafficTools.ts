/**
 * trafficTools.ts
 *
 * Google Maps Routes API (New) wrapper.
 * Returns drive time with live traffic between two addresses.
 *
 * Required env vars:
 *   GOOGLE_MAPS_API_KEY  — Maps Platform API key with Routes API enabled
 *   HOME_ADDRESS         — e.g. "123 Main St, Orlando, FL 32801"
 *   WORK_ADDRESS         — e.g. "200 SW 2nd St, Fort Lauderdale, FL 33021"
 */

export interface TrafficResult {
  durationMin: number;         // normal drive time (no traffic)
  durationTrafficMin: number;  // current traffic-adjusted drive time
  trafficDelayMin: number;     // extra minutes due to traffic
  summary: string;             // human-readable e.g. "22 min drive (28 min with traffic ⚠️)"
  heavyTraffic: boolean;       // true if delay > 5 min
}

export async function getTrafficDuration(
  origin: string,
  destination: string
): Promise<TrafficResult | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ GOOGLE_MAPS_API_KEY not set — skipping traffic check");
    return null;
  }

  // Routes API (New) — replaces legacy Distance Matrix
  const url = "https://routes.googleapis.com/directions/v2:computeRoutes";

  const body = {
    origin:      { address: origin },
    destination: { address: destination },
    travelMode:  "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: new Date().toISOString(),
    computeAlternativeRoutes: false,
    routeModifiers: { avoidTolls: false, avoidHighways: false },
    languageCode: "en-US",
    units: "IMPERIAL",
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    const data = await res.json() as RoutesApiResponse;

    if (!res.ok || !data.routes?.length) {
      console.warn("Routes API error:", res.status, JSON.stringify(data).slice(0, 200));
      return null;
    }

    const route = data.routes[0];

    // duration = traffic-aware, staticDuration = no-traffic baseline
    const durationTrafficMin = Math.round(parseDurationSec(route.duration) / 60);
    const durationMin        = Math.round(parseDurationSec(route.staticDuration ?? route.duration) / 60);
    const trafficDelayMin    = Math.max(0, durationTrafficMin - durationMin);
    const heavyTraffic       = trafficDelayMin > 5;

    let summary: string;
    if (heavyTraffic) {
      summary = `${durationMin} min drive · ⚠️ ${durationTrafficMin} min with current traffic (+${trafficDelayMin} min delay)`;
    } else if (trafficDelayMin > 0) {
      summary = `${durationMin} min drive · ~${durationTrafficMin} min with traffic`;
    } else {
      summary = `${durationMin} min drive · traffic is clear`;
    }

    return { durationMin, durationTrafficMin, trafficDelayMin, summary, heavyTraffic };
  } catch (err) {
    console.error("Traffic API error:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Parse a Routes API duration string like "1234s" → number of seconds */
function parseDurationSec(duration: string | undefined): number {
  if (!duration) return 0;
  const match = duration.match(/^(\d+)s$/);
  return match ? parseInt(match[1], 10) : 0;
}

// ─── Types ─────────────────────────────────────────────────────────────────
interface RoutesApiResponse {
  routes?: Array<{
    duration:       string;        // e.g. "1234s" — traffic-aware
    staticDuration?: string;       // e.g. "1100s" — no-traffic baseline
    distanceMeters: number;
  }>;
  error?: { code: number; message: string };
}
