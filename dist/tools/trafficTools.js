/**
 * trafficTools.ts
 *
 * Google Maps Distance Matrix API wrapper.
 * Returns drive time with live traffic between two addresses.
 *
 * Required env vars:
 *   GOOGLE_MAPS_API_KEY  — Maps Platform API key with Distance Matrix enabled
 *   HOME_ADDRESS         — e.g. "123 Main St, Orlando, FL 32801"
 */
export async function getTrafficDuration(origin, destination) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.warn("⚠️ GOOGLE_MAPS_API_KEY not set — skipping traffic check");
        return null;
    }
    const params = new URLSearchParams({
        origins: origin,
        destinations: destination,
        mode: "driving",
        departure_time: "now", // enables live traffic
        traffic_model: "best_guess",
        key: apiKey,
    });
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.status !== "OK") {
            console.warn("Maps API status:", data.status);
            return null;
        }
        const element = data.rows?.[0]?.elements?.[0];
        if (!element || element.status !== "OK") {
            console.warn("Maps element status:", element?.status);
            return null;
        }
        const durationMin = Math.round(element.duration.value / 60);
        const durationTrafficMin = Math.round((element.duration_in_traffic?.value ?? element.duration.value) / 60);
        const trafficDelayMin = Math.max(0, durationTrafficMin - durationMin);
        const heavyTraffic = trafficDelayMin > 5;
        let summary;
        if (heavyTraffic) {
            summary = `${durationMin} min drive · ⚠️ ${durationTrafficMin} min with current traffic (+${trafficDelayMin} min delay)`;
        }
        else if (trafficDelayMin > 0) {
            summary = `${durationMin} min drive · ~${durationTrafficMin} min with traffic`;
        }
        else {
            summary = `${durationMin} min drive · traffic is clear`;
        }
        return { durationMin, durationTrafficMin, trafficDelayMin, summary, heavyTraffic };
    }
    catch (err) {
        console.error("Traffic API error:", err instanceof Error ? err.message : err);
        return null;
    }
}
