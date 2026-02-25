import { calendarAgent } from "./agents/calendarAgent.js";
import { taskAgent } from "./agents/taskAgent.js";
import { newsAgent } from "./agents/newsAgent.js";
import { emailAgent, filterImportant } from "./agents/emailAgent.js";
import { criticAgent } from "./agents/criticAgent.js";
import { chatAgent } from "./agents/chatAgent.js";
import { getWeather, formatWeatherSummary } from "./tools/weatherTools.js";
import { listTasks } from "./tools/tasksTools.js";
import { sendDailyDigestEmail } from "./tools/digestEmail.js";
import { pushNotification, startNotificationPolling } from "./tools/notificationTools.js";
import { getUsageToday } from "./tools/usageTracker.js";
import { getTrafficDuration } from "./tools/trafficTools.js";
import { getTrackedPackages } from "./tools/packageTools.js";
import cron from "node-cron";
// Cache the morning briefing per user so chat can reference it all day
const briefingCache = new Map();
// ─── Dashboard briefing cache (TTL = 5 minutes) ──────────────────────────────
const BRIEFING_TTL_MS = 5 * 60 * 1000;
let dashboardCache = null;
let dashboardFetchInFlight = null;
export function invalidateDashboardCache() {
    dashboardCache = null;
}
export function dashboardCacheFetchedAt() {
    return dashboardCache ? new Date(dashboardCache.fetchedAt).toISOString() : null;
}
export async function getCachedBriefing() {
    const now = Date.now();
    // Return cached data if still fresh
    if (dashboardCache && now - dashboardCache.fetchedAt < BRIEFING_TTL_MS) {
        return dashboardCache.data;
    }
    // Deduplicate concurrent requests — only one fetch at a time
    if (dashboardFetchInFlight)
        return dashboardFetchInFlight;
    dashboardFetchInFlight = buildMorningBriefing()
        .then((data) => {
        dashboardCache = { data, fetchedAt: Date.now() };
        dashboardFetchInFlight = null;
        return data;
    })
        .catch((err) => {
        dashboardFetchInFlight = null;
        throw err;
    });
    return dashboardFetchInFlight;
}
// ─── Parse "H:MM" or "HH:MM" into a cron expression "M H * * *" ─────────────
function timeToCron(envVar, defaultHour, defaultMin = 0) {
    const raw = process.env[envVar];
    if (raw) {
        const [h, m] = raw.split(":").map(Number);
        if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
            return `${m} ${h} * * *`;
        }
        console.warn(`⚠️  Invalid ${envVar}="${raw}" — expected HH:MM, using default`);
    }
    return `${defaultMin} ${defaultHour} * * *`;
}
// Hold references so we can stop/restart them
let morningTask = null;
let eveningTask = null;
function scheduleMorningJob(tz) {
    morningTask?.stop();
    const morningCron = timeToCron("MORNING_BRIEFING_TIME", 7, 0);
    morningTask = cron.schedule(morningCron, async () => {
        console.log("⏰ Cron: building morning briefing + sending digest email...");
        try {
            const briefing = await buildMorningBriefing();
            briefingCache.set("cron-user", briefing);
            const result = await sendDailyDigestEmail(briefing);
            if (result.success) {
                pushNotification({
                    type: "digest_ready",
                    title: "☀️ Morning digest sent!",
                    body: `Your daily briefing has been emailed to ${process.env.DIGEST_EMAIL_TO ?? "you"}.`,
                });
            }
            else {
                console.error("Digest email failed:", result.error);
            }
        }
        catch (err) {
            console.error("Cron morning job error:", err);
        }
    }, { timezone: tz });
    console.log(`⏰ Morning briefing scheduled: ${morningCron} (${tz})`);
}
function scheduleEveningJob(tz) {
    eveningTask?.stop();
    const eveningCron = timeToCron("EVENING_BRIEFING_TIME", 17, 0);
    eveningTask = cron.schedule(eveningCron, async () => {
        console.log("⏰ Cron: sending evening briefing notification...");
        try {
            const briefing = await buildMorningBriefing();
            pushNotification({
                type: "digest_ready",
                title: "🌙 Evening Briefing Ready",
                body: "Tap to see your evening summary",
            });
            briefingCache.set("cron-user-evening", briefing);
            console.log("Evening briefing cached");
        }
        catch (err) {
            console.error("Cron evening job error:", err);
        }
    }, { timezone: tz });
    console.log(`⏰ Evening briefing scheduled: ${eveningCron} (${tz})`);
}
// ─── Reschedule cron jobs at runtime (called by /api/settings) ───────────────
export function rescheduleBriefingJobs() {
    const tz = process.env.TIMEZONE ?? "America/New_York";
    scheduleMorningJob(tz);
    scheduleEveningJob(tz);
}
// ─── Scheduled jobs ────────────────────────────────────────────────────────
export function startScheduledJobs() {
    const tz = process.env.TIMEZONE ?? "America/New_York";
    scheduleMorningJob(tz);
    scheduleEveningJob(tz);
    // Start SSE notification polling (calendar event reminders)
    startNotificationPolling();
}
// ─── Proactive Suggestions ────────────────────────────────────────────────────
/**
 * Analyzes the morning briefing and returns an array of actionable suggestion strings.
 * These are surfaced as dismissible banners on the dashboard.
 */
function proactiveAnalysis(briefing) {
    const suggestions = [];
    const events = briefing.calendar;
    const tasks = briefing.googleTasks;
    const weather = briefing.weather;
    // ── Back-to-back meetings (< 5 min gap) ──────────────────────────────────
    for (let i = 0; i < events.length - 1; i++) {
        const a = events[i];
        const b = events[i + 1];
        if (!a.startIso || !b.startIso)
            continue;
        // find a's end time from the formatted string is tricky; use b's start vs a's start+estimated
        // Use the end ISO if available — if not, skip
        const aEndMs = a.startIso ? new Date(a.startIso).getTime() + 60 * 60_000 : null; // rough 1hr estimate
        const bStartMs = new Date(b.startIso).getTime();
        if (aEndMs && bStartMs - aEndMs < 5 * 60_000 && bStartMs > aEndMs) {
            suggestions.push(`📆 Back-to-back meetings: "${a.title}" runs into "${b.title}" with little buffer.`);
        }
    }
    // ── Events with location but no preceding travel buffer ──────────────────
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev.location || !ev.startIso)
            continue;
        const evStartMs = new Date(ev.startIso).getTime();
        // Check if the prior event ends close to this one's start
        const prior = events[i - 1];
        if (prior && prior.startIso) {
            const priorEndMs = new Date(prior.startIso).getTime() + 60 * 60_000;
            if (evStartMs - priorEndMs < 30 * 60_000) {
                suggestions.push(`📍 "${ev.title}" is at ${ev.location} — you may need travel time after "${prior.title}".`);
            }
        }
    }
    // ── Overdue tasks (due > 3 days ago) ──────────────────────────────────────
    const todayMs = Date.now();
    const overdue = tasks.filter((t) => {
        if (!t.due || t.status === "completed")
            return false;
        const dueMs = new Date(t.due).getTime();
        return todayMs - dueMs > 3 * 24 * 60 * 60_000;
    });
    if (overdue.length > 0) {
        const titles = overdue.slice(0, 3).map(t => `"${t.title}"`).join(", ");
        suggestions.push(`⚠️ ${overdue.length} overdue task${overdue.length > 1 ? "s" : ""}: ${titles}${overdue.length > 3 ? " and more" : ""}.`);
    }
    // ── Rain today + outdoor/offsite event ──────────────────────────────────
    if (weather && weather.precipChance >= 60) {
        const outdoorEvents = events.filter(e => e.location && !e.location.toLowerCase().includes("zoom") && !e.location.toLowerCase().includes("teams") && !e.location.toLowerCase().includes("meet"));
        if (outdoorEvents.length > 0) {
            suggestions.push(`🌧️ ${weather.precipChance}% chance of rain — "${outdoorEvents[0].title}" is at an in-person location. Consider an umbrella.`);
        }
    }
    // ── Heavy meeting day (4+ events) ────────────────────────────────────────
    if (events.length >= 4) {
        suggestions.push(`🔥 Heavy meeting day — ${events.length} events on your calendar. Block focus time if possible.`);
    }
    return suggestions;
}
// ─── Morning Briefing ──────────────────────────────────────────────────────
export async function buildMorningBriefing() {
    console.log("⏳ Fetching morning briefing data...");
    const [calendar, tasks, emails, news, weather, googleTasks] = await Promise.allSettled([
        calendarAgent(),
        taskAgent(),
        emailAgent(),
        newsAgent(),
        getWeather(),
        listTasks(30),
    ]);
    const calendarData = calendar.status === "fulfilled" ? calendar.value : [];
    const tasksData = tasks.status === "fulfilled" ? tasks.value : [];
    const emailsData = emails.status === "fulfilled" ? emails.value : [];
    const newsData = news.status === "fulfilled" ? news.value : [];
    const weatherData = weather.status === "fulfilled" ? weather.value : undefined;
    const googleTasksData = googleTasks.status === "fulfilled" ? googleTasks.value : [];
    if (calendar.status === "rejected")
        console.error("Calendar error:", calendar.reason);
    if (tasks.status === "rejected")
        console.error("Tasks error:", tasks.reason);
    if (emails.status === "rejected")
        console.error("Email error:", emails.reason);
    if (news.status === "rejected")
        console.error("News error:", news.reason);
    if (weather.status === "rejected")
        console.error("Weather error:", weather.reason);
    if (googleTasks.status === "rejected")
        console.error("Google Tasks error:", googleTasks.reason);
    const importantEmails = filterImportant(emailsData);
    // Run proactive analysis and package tracking in parallel (non-blocking)
    const [suggestionsResult, packagesResult] = await Promise.allSettled([
        Promise.resolve(proactiveAnalysis({
            calendar: calendarData, emails: emailsData, importantEmails,
            news: newsData, weather: weatherData, googleTasks: googleTasksData,
            llmUsage: getUsageToday(), generatedAt: new Date().toISOString(),
        })),
        getTrackedPackages(),
    ]);
    const suggestions = suggestionsResult.status === "fulfilled" ? suggestionsResult.value : [];
    const packages = packagesResult.status === "fulfilled" ? packagesResult.value : [];
    if (packagesResult.status === "rejected")
        console.error("Package tracking error:", packagesResult.reason);
    const briefing = {
        calendar: calendarData,
        emails: emailsData,
        importantEmails,
        news: newsData,
        weather: weatherData,
        googleTasks: googleTasksData,
        llmUsage: getUsageToday(),
        generatedAt: new Date().toISOString(),
        suggestions,
        packages,
    };
    return briefing;
}
function formatMorningBriefingText(briefing) {
    const schedule = [
        { start: "06:30", end: "07:30", title: "Gym" },
        { start: "18:00", end: "19:00", title: "AWS Learning" },
    ];
    const review = criticAgent(schedule);
    const weatherSection = briefing.weather
        ? `  ${formatWeatherSummary(briefing.weather)}\n  🌅 Sunrise ${briefing.weather.sunrise} · 🌇 Sunset ${briefing.weather.sunset}`
        : "  Weather unavailable.";
    const calSection = briefing.calendar.length > 0
        ? briefing.calendar.map((e) => `  ${e.start}–${e.end}  ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n")
        : "  No events today.";
    const importantSection = briefing.importantEmails.length > 0
        ? briefing.importantEmails.map((e) => `  ⚠️ [${e.account}] ${e.subject}\n     From: ${e.from}\n     ${e.snippet}`).join("\n\n")
        : "  None.";
    const emailSection = briefing.emails.length > 0
        ? briefing.emails
            .slice(0, 8)
            .map((e) => `  • [${e.account}] ${e.subject} — ${e.from}`)
            .join("\n")
        : "  Inbox is clear.";
    const taskSection = briefing.googleTasks.length > 0
        ? briefing.googleTasks
            .map((t) => `  • ${t.title}${t.due ? ` (due ${new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}`)
            .join("\n")
        : "  No tasks.";
    const newsSection = briefing.news.length > 0
        ? briefing.news
            .map((n) => `\n  ${n.topic}:\n` +
            (n.articles.length > 0
                ? n.articles.map((a) => `  • [${a.title}](${a.url})`).join("\n")
                : "  No articles found."))
            .join("\n")
        : "  No news loaded.";
    const usageSection = briefing.llmUsage
        ? `  ${briefing.llmUsage.totalTokens.toLocaleString()} tokens used today across ${briefing.llmUsage.calls} calls · Est. cost: $${briefing.llmUsage.estimatedCostUSD.toFixed(4)}`
        : "  No usage data yet.";
    const scheduleWarning = !review.valid ? "\n⚠️ Schedule conflict detected!\n" : "";
    return `
Good morning! Here's your daily briefing for ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}

🌤️ WEATHER
${weatherSection}

📅 CALENDAR
${calSection}
${scheduleWarning}
⚠️ IMPORTANT EMAILS (${briefing.importantEmails.length})
${importantSection}

📧 UNREAD EMAILS (${briefing.emails.length} total)
${emailSection}

✅ TODAY'S TASKS (${briefing.googleTasks.length})
${taskSection}

📰 MORNING NEWS
${newsSection}

🤖 LLM USAGE TODAY
${usageSection}

💬 Chat with me anytime — ask about your emails, schedule, tasks, or anything else!
`.trim();
}
// ─── Evening Briefing ─────────────────────────────────────────────────────
const EVENING_TRIGGERS = ["/evening", "evening briefing", "end of day", "evening summary", "wrap up my day", "end my day"];
async function formatEveningBriefingText(briefing) {
    const home = process.env.HOME_ADDRESS;
    const work = process.env.WORK_ADDRESS;
    // Tomorrow's calendar events
    const tmrStart = new Date();
    tmrStart.setDate(tmrStart.getDate() + 1);
    tmrStart.setHours(0, 0, 0, 0);
    const tmrEnd = new Date(tmrStart);
    tmrEnd.setHours(23, 59, 59, 999);
    const tomorrowStr = tmrStart.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    let tomorrowEvents;
    try {
        const { getCalendarEventsByRange } = await import("./tools/calendarTools.js");
        const events = await getCalendarEventsByRange(tmrStart.toISOString(), tmrEnd.toISOString());
        tomorrowEvents = events.length > 0
            ? events.map((e) => `  ${e.start}–${e.end}  ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n")
            : "  Nothing scheduled.";
    }
    catch {
        tomorrowEvents = "  Unable to load tomorrow's calendar.";
    }
    // Live commute home traffic (work → home)
    let commuteSection = "";
    if (work && home) {
        try {
            const traffic = await getTrafficDuration(work, home);
            if (traffic) {
                const icon = traffic.heavyTraffic ? "🔴" : "🟢";
                commuteSection = `\n🚗 COMMUTE HOME\n  ${icon} ${traffic.summary}\n  Drive: ${traffic.durationTrafficMin} min${traffic.trafficDelayMin > 0 ? ` (+${traffic.trafficDelayMin} min delay)` : ""}`;
            }
        }
        catch { /* Maps unavailable */ }
    }
    const openTasks = briefing.googleTasks.filter((t) => t.status !== "completed");
    const taskSection = openTasks.length > 0
        ? openTasks.map((t) => `  • ${t.title}${t.due ? ` (due ${new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}`).join("\n")
        : "  All tasks complete! 🎉";
    const usageSection = briefing.llmUsage
        ? `  ${briefing.llmUsage.totalTokens.toLocaleString()} tokens across ${briefing.llmUsage.calls} calls · Est. cost: $${briefing.llmUsage.estimatedCostUSD.toFixed(4)}`
        : "  No usage data.";
    return [
        `Good evening! Here's your end-of-day summary for ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`,
        commuteSection,
        `\n📅 TOMORROW — ${tomorrowStr}\n${tomorrowEvents}`,
        `\n✅ OPEN TASKS\n${taskSection}`,
        `\n🤖 LLM USAGE TODAY\n${usageSection}`,
        `\n💬 Ask me anything before you wrap up!`,
    ].join("\n").trim();
}
// ─── Main coordinator ──────────────────────────────────────────────────────
const MORNING_TRIGGERS = ["/morning", "good morning", "morning briefing", "daily briefing", "start my day"];
export async function coordinatorAgent(message, userId = "default") {
    const lower = message.toLowerCase().trim();
    // Morning briefing request
    if (MORNING_TRIGGERS.some((t) => lower.includes(t))) {
        try {
            const briefing = await buildMorningBriefing();
            briefingCache.set(userId, briefing);
            return formatMorningBriefingText(briefing);
        }
        catch (err) {
            console.error("Morning briefing error:", err);
            return "Sorry, I ran into an error building your morning briefing. Check your Google credentials and API keys.";
        }
    }
    // Evening briefing request
    if (EVENING_TRIGGERS.some((t) => lower.includes(t))) {
        try {
            const briefing = await buildMorningBriefing();
            briefingCache.set(userId, briefing);
            return await formatEveningBriefingText(briefing);
        }
        catch (err) {
            console.error("Evening briefing error:", err);
            return "Sorry, I ran into an error building your evening briefing.";
        }
    }
    // Clear history command
    if (lower === "/clear" || lower === "clear history") {
        const { clearHistory } = await import("./agents/chatAgent.js");
        clearHistory(userId);
        return "Conversation history cleared.";
    }
    // All other messages → chat agent with briefing context
    const briefing = briefingCache.get(userId);
    try {
        return await chatAgent(userId, message, briefing);
    }
    catch (err) {
        console.error("Chat agent error:", err?.status, err?.error ?? err?.message ?? err);
        const status = err?.status ?? err?.code;
        if (status === 401)
            return "❌ Invalid Grok API key. Check XAI_API_KEY in .env";
        if (status === 429)
            return "❌ Grok rate limit hit. Try again in a moment.";
        if (status === 404)
            return `❌ Grok model not found: ${err?.error?.message ?? ""}`;
        return `❌ AI error (${status ?? "unknown"}): ${err?.error?.message ?? err?.message ?? "Please try again."}`;
    }
}
