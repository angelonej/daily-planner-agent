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
import cron from "node-cron";
// Cache the morning briefing per user so chat can reference it all day
const briefingCache = new Map();
// ─── Scheduled jobs ────────────────────────────────────────────────────────
export function startScheduledJobs() {
    const tz = process.env.TIMEZONE ?? "America/New_York";
    // 7:00 AM daily: build briefing, cache it, send digest email
    cron.schedule("0 7 * * *", async () => {
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
    console.log(`⏰ Cron jobs scheduled (tz: ${tz}): digest email at 7:00 AM daily`);
    // Start SSE notification polling (calendar event reminders)
    startNotificationPolling();
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
    const briefing = {
        calendar: calendarData,
        emails: emailsData,
        importantEmails,
        news: newsData,
        weather: weatherData,
        googleTasks: googleTasksData,
        llmUsage: getUsageToday(),
        generatedAt: new Date().toISOString(),
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
                ? n.articles.map((a) => `  • ${a.title}\n    ${a.url}`).join("\n")
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
