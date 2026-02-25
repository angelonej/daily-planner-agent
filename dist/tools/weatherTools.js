/**
 * Weather via Open-Meteo (free, no API key required)
 * Docs: https://open-meteo.com/en/docs
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
export async function getWeather() {
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
    const res = await fetch(url.toString());
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
    return {
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
    const res = await fetch(url.toString());
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
