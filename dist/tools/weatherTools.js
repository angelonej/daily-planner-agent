/**
 * Weather via Open-Meteo (primary, free, no API key required)
 * Docs: https://open-meteo.com/en/docs
 *
 * Falls back to wttr.in JSON API if Open-Meteo is unreachable.
 */
import fetch from "node-fetch";
// WMO Weather Interpretation Codes → human readable
const WMO_CODES = {
    0: "Clear sky",
    1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};
function celsiusToF(c) {
    return Math.round(c * 9 / 5 + 32);
}
function mmToInch(mm) {
    return Math.round(mm / 25.4 * 100) / 100;
}
function kphToMph(kph) {
    return Math.round(kph * 0.621371);
}
// ─── wttr.in fallback ─────────────────────────────────────────────────────────
async function getWeatherFromWttr(locationName, tz) {
    // wttr.in accepts city name or lat,lon — use location name directly
    const query = encodeURIComponent(locationName);
    const url = `https://wttr.in/${query}?format=j1`;
    const res = await fetch(url, {
        headers: { "User-Agent": "daily-planner-agent/1.0" },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok)
        throw new Error(`wttr.in error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const cur = data.current_condition?.[0];
    const wDay = data.weather?.[0];
    const hourlyRaw = wDay?.hourly ?? [];
    const tempF = parseInt(cur?.temp_F ?? "0");
    const feelsF = parseInt(cur?.FeelsLikeF ?? "0");
    const humidity = parseInt(cur?.humidity ?? "0");
    const windMph = parseInt(cur?.windspeedMiles ?? "0");
    const wmoCode = mapWttrCodeToWMO(parseInt(cur?.weatherCode ?? "0"));
    const isDay = parseInt(cur?.uvIndex ?? "0") > 0;
    const precipIn = parseFloat(cur?.precipMM ?? "0") / 25.4;
    const highF = parseInt(wDay?.maxtempF ?? "0");
    const lowF = parseInt(wDay?.mintempF ?? "0");
    const precipChance = parseInt(wDay?.hourly?.[0]?.chanceofrain ?? "0");
    const uvIndex = parseInt(wDay?.uvIndex ?? "0");
    // sunrise/sunset from wttr — format "06:47 AM" etc
    const sunrise = wDay?.astronomy?.[0]?.sunrise ?? "7:00 AM";
    const sunset = wDay?.astronomy?.[0]?.sunset ?? "7:00 PM";
    // Build next 12 hours
    const nowHour = new Date().getHours();
    const hourlyResult = [];
    for (const h of hourlyRaw) {
        const hTime = parseInt(h.time) / 100;
        if (hTime < nowHour || hourlyResult.length >= 12)
            continue;
        const label = new Date().toLocaleTimeString("en-US", {
            hour: "numeric", hour12: true, timeZone: tz,
        });
        hourlyResult.push({
            time: `${hTime % 12 === 0 ? 12 : hTime % 12}${hTime < 12 ? " AM" : " PM"}`,
            tempF: parseInt(h.tempF ?? "0"),
            precipChance: parseInt(h.chanceofrain ?? "0"),
            condition: WMO_CODES[mapWttrCodeToWMO(parseInt(h.weatherCode ?? "0"))] ?? "Unknown",
        });
    }
    return {
        location: locationName,
        temperatureF: tempF,
        feelsLikeF: feelsF,
        humidity,
        windSpeedMph: windMph,
        condition: WMO_CODES[wmoCode] ?? cur?.weatherDesc?.[0]?.value ?? "Unknown",
        conditionCode: wmoCode,
        precipitationInch: Math.round(precipIn * 100) / 100,
        isDay,
        high: highF,
        low: lowF,
        precipChance,
        uvIndex,
        sunrise,
        sunset,
        hourly: hourlyResult,
    };
}
// Map wttr.in weather codes (BBC codes) to approximate WMO codes
function mapWttrCodeToWMO(code) {
    if (code === 113)
        return 0; // Sunny/Clear
    if (code === 116)
        return 2; // Partly cloudy
    if (code === 119)
        return 3; // Cloudy
    if (code === 122)
        return 3; // Overcast
    if (code === 143)
        return 45; // Mist/Fog
    if (code >= 176 && code <= 179)
        return 80; // Patchy rain
    if (code >= 182 && code <= 185)
        return 71; // Patchy snow
    if (code >= 200 && code <= 201)
        return 95; // Thunder
    if (code >= 227 && code <= 230)
        return 73; // Blowing/Heavy snow
    if (code >= 248 && code <= 260)
        return 45; // Fog/freezing fog
    if (code >= 263 && code <= 266)
        return 51; // Light drizzle
    if (code >= 281 && code <= 284)
        return 51; // Freezing drizzle
    if (code >= 293 && code <= 296)
        return 61; // Light/Moderate rain
    if (code >= 299 && code <= 305)
        return 63; // Moderate/Heavy rain
    if (code >= 308 && code <= 314)
        return 65; // Heavy rain
    if (code >= 317 && code <= 323)
        return 73; // Light/Moderate snow
    if (code >= 326 && code <= 338)
        return 75; // Heavy snow
    if (code >= 350 && code <= 353)
        return 80; // Light rain showers
    if (code >= 356 && code <= 362)
        return 81; // Moderate/Heavy rain showers
    if (code >= 365 && code <= 374)
        return 85; // Snow showers
    if (code >= 386 && code <= 389)
        return 95; // Thunder + rain
    if (code >= 392 && code <= 395)
        return 95; // Thunder + snow
    return 0;
}
// Cache weather for 15 minutes — no need to re-fetch on every briefing cache miss
let weatherCache = null;
const WEATHER_CACHE_TTL_MS = 15 * 60 * 1000;
export async function getWeather() {
    if (weatherCache && Date.now() - weatherCache.fetchedAt < WEATHER_CACHE_TTL_MS) {
        return weatherCache.data;
    }
    const lat = process.env.LATITUDE ?? "26.0112"; // Hollywood FL default
    const lon = process.env.LONGITUDE ?? "-80.1495";
    const locationName = process.env.LOCATION_NAME ?? "Hollywood, FL";
    const tz = process.env.TIMEZONE ?? "America/New_York";
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat);
    url.searchParams.set("longitude", lon);
    url.searchParams.set("timezone", tz);
    url.searchParams.set("current", [
        "temperature_2m",
        "apparent_temperature",
        "relative_humidity_2m",
        "wind_speed_10m",
        "weather_code",
        "is_day",
        "precipitation",
    ].join(","));
    url.searchParams.set("daily", [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "uv_index_max",
        "sunrise",
        "sunset",
        "weather_code",
    ].join(","));
    url.searchParams.set("hourly", [
        "temperature_2m",
        "precipitation_probability",
        "weather_code",
    ].join(","));
    url.searchParams.set("forecast_days", "7");
    url.searchParams.set("wind_speed_unit", "kmh");
    url.searchParams.set("temperature_unit", "celsius");
    url.searchParams.set("precipitation_unit", "mm");
    try {
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
        if (!res.ok)
            throw new Error(`Open-Meteo error: ${res.status} ${res.statusText}`);
        const data = await res.json();
        const cur = data.current;
        const daily = data.daily;
        const hourly = data.hourly;
        // Build next 12 hours of hourly data (skip past hours)
        const nowHour = new Date().getHours();
        const hourlyResult = [];
        for (let i = nowHour; i < Math.min(nowHour + 12, 24); i++) {
            if (!hourly.time[i])
                break;
            const timeLabel = new Date(hourly.time[i]).toLocaleTimeString("en-US", {
                hour: "numeric", hour12: true, timeZone: tz,
            });
            hourlyResult.push({
                time: timeLabel,
                tempF: celsiusToF(hourly.temperature_2m[i]),
                precipChance: hourly.precipitation_probability[i] ?? 0,
                condition: WMO_CODES[hourly.weather_code[i]] ?? "Unknown",
            });
        }
        // Format sunrise/sunset
        const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
        const result = {
            location: locationName,
            temperatureF: celsiusToF(cur.temperature_2m),
            feelsLikeF: celsiusToF(cur.apparent_temperature),
            humidity: Math.round(cur.relative_humidity_2m),
            windSpeedMph: kphToMph(cur.wind_speed_10m),
            condition: WMO_CODES[cur.weather_code] ?? "Unknown",
            conditionCode: cur.weather_code,
            precipitationInch: mmToInch(cur.precipitation),
            isDay: Boolean(cur.is_day),
            high: celsiusToF(daily.temperature_2m_max[0]),
            low: celsiusToF(daily.temperature_2m_min[0]),
            precipChance: daily.precipitation_probability_max[0] ?? 0,
            uvIndex: Math.round(daily.uv_index_max[0] ?? 0),
            sunrise: fmtTime(daily.sunrise[0]),
            sunset: fmtTime(daily.sunset[0]),
            hourly: hourlyResult,
        };
        weatherCache = { data: result, fetchedAt: Date.now() };
        return result;
    }
    catch (primaryErr) {
        console.warn(`⚠️  Open-Meteo failed (${primaryErr.message}) — falling back to wttr.in`);
        const fallback = await getWeatherFromWttr(locationName, tz);
        weatherCache = { data: fallback, fetchedAt: Date.now() };
        return fallback;
    }
}
export async function getWeatherForecast(days = 7) {
    const lat = process.env.LATITUDE ?? "26.0112";
    const lon = process.env.LONGITUDE ?? "-80.1495";
    const tz = process.env.TIMEZONE ?? "America/New_York";
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat);
    url.searchParams.set("longitude", lon);
    url.searchParams.set("timezone", tz);
    url.searchParams.set("daily", [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "uv_index_max",
        "sunrise",
        "sunset",
        "weather_code",
    ].join(","));
    url.searchParams.set("forecast_days", String(Math.min(days, 16)));
    url.searchParams.set("temperature_unit", "celsius");
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok)
        throw new Error(`Open-Meteo error: ${res.status}`);
    const data = await res.json();
    const daily = data.daily;
    const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
    return daily.time.map((dateStr, i) => ({
        date: dateStr,
        dayName: new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: tz }),
        high: celsiusToF(daily.temperature_2m_max[i]),
        low: celsiusToF(daily.temperature_2m_min[i]),
        precipChance: daily.precipitation_probability_max[i] ?? 0,
        condition: WMO_CODES[daily.weather_code[i]] ?? "Unknown",
        uvIndex: Math.round(daily.uv_index_max[i] ?? 0),
        sunrise: fmtTime(daily.sunrise[i]),
        sunset: fmtTime(daily.sunset[i]),
    }));
}
export function formatWeatherSummary(w) {
    const icon = getWeatherIcon(w.conditionCode, w.isDay);
    const rainWarning = w.precipChance >= 50 ? ` ☂️ ${w.precipChance}% chance of rain` : "";
    const uvWarning = w.uvIndex >= 8 ? ` 🕶️ High UV (${w.uvIndex})` : "";
    return `${icon} ${w.condition}, ${w.temperatureF}°F (feels ${w.feelsLikeF}°F) · H:${w.high}° L:${w.low}° · 💧${w.humidity}% · 💨${w.windSpeedMph}mph${rainWarning}${uvWarning}`;
}
function getWeatherIcon(code, isDay) {
    if (code === 0)
        return isDay ? "☀️" : "🌙";
    if (code <= 2)
        return isDay ? "🌤️" : "🌥️";
    if (code === 3)
        return "☁️";
    if (code <= 48)
        return "🌫️";
    if (code <= 55)
        return "🌦️";
    if (code <= 65)
        return "🌧️";
    if (code <= 77)
        return "❄️";
    if (code <= 82)
        return "🌦️";
    if (code <= 86)
        return "🌨️";
    return "⛈️";
}
