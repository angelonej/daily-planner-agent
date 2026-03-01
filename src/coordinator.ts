import { calendarAgent } from "./agents/calendarAgent.js";
import { taskAgent } from "./agents/taskAgent.js";
import { newsAgent } from "./agents/newsAgent.js";
import { emailAgent, filterImportant } from "./agents/emailAgent.js";
import { criticAgent } from "./agents/criticAgent.js";
import { chatAgent, formatBriefingContext, type AssistantTone } from "./agents/chatAgent.js";
import { getWeather, formatWeatherSummary } from "./tools/weatherTools.js";
import { listTasks } from "./tools/tasksTools.js";
import { getTrackedPackages } from "./tools/packageTools.js";
import { sendDailyDigestEmail, sendWeeklyDigestEmail } from "./tools/digestEmail.js";
import { pushNotification, startNotificationPolling } from "./tools/notificationTools.js";
import { getUsageToday } from "./tools/usageTracker.js";
import { getTrafficDuration } from "./tools/trafficTools.js";
import { MorningBriefing, ScheduleBlock } from "./types.js";
import cron from "node-cron";

// Cache the morning briefing per user so chat can reference it all day
const briefingCache = new Map<string, MorningBriefing>();

// ─── Dashboard briefing cache (TTL = 5 minutes) ──────────────────────────────
const BRIEFING_TTL_MS = 15 * 60 * 1000;
let dashboardCache: { data: MorningBriefing; fetchedAt: number } | null = null;
let dashboardFetchInFlight: Promise<MorningBriefing> | null = null;

export function invalidateDashboardCache(): void {
  dashboardCache = null;
}

export function dashboardCacheFetchedAt(): string | null {
  return dashboardCache ? new Date(dashboardCache.fetchedAt).toISOString() : null;
}

export async function getCachedBriefing(): Promise<MorningBriefing> {
  const now = Date.now();
  // Return cached data if still fresh
  if (dashboardCache && now - dashboardCache.fetchedAt < BRIEFING_TTL_MS) {
    return dashboardCache.data;
  }
  // Deduplicate concurrent requests — only one fetch at a time
  if (dashboardFetchInFlight) return dashboardFetchInFlight;
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
function timeToCron(envVar: string, defaultHour: number, defaultMin = 0): string {
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
let morningTask: cron.ScheduledTask | null = null;
let eveningTask: cron.ScheduledTask | null = null;
let weeklyTask: cron.ScheduledTask | null = null;

function scheduleMorningJob(tz: string): void {
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
      } else {
        console.error("Digest email failed:", result.error);
      }
    } catch (err) {
      console.error("Cron morning job error:", err);
    }
  }, { timezone: tz });
  console.log(`⏰ Morning briefing scheduled: ${morningCron} (${tz})`);
}

function scheduleEveningJob(tz: string): void {
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
    } catch (err) {
      console.error("Cron evening job error:", err);
    }
  }, { timezone: tz });
  console.log(`⏰ Evening briefing scheduled: ${eveningCron} (${tz})`);
}

function scheduleWeeklyJob(tz: string): void {
  weeklyTask?.stop();
  // Every Monday at 7:00 AM (or WEEKLY_DIGEST_TIME env var)
  const weeklyTime = timeToCron("WEEKLY_DIGEST_TIME", 7, 0);
  const weeklyCron = `${weeklyTime.split(" ")[0]} ${weeklyTime.split(" ")[1]} * * 1`; // day-of-week=1 (Monday)
  weeklyTask = cron.schedule(weeklyCron, async () => {
    console.log("⏰ Cron: sending weekly digest email...");
    try {
      const result = await sendWeeklyDigestEmail();
      if (result.success) {
        pushNotification({
          type: "digest_ready",
          title: "📅 Weekly Briefing Sent!",
          body: `Your week-ahead digest has been emailed to ${process.env.DIGEST_EMAIL_TO ?? "you"}.`,
        });
      } else {
        console.error("Weekly digest email failed:", result.error);
      }
    } catch (err) {
      console.error("Cron weekly job error:", err);
    }
  }, { timezone: tz });
  console.log(`⏰ Weekly digest scheduled: Mondays at ${weeklyTime} (${tz})`);
}

// ─── Reschedule cron jobs at runtime (called by /api/settings) ───────────────
export function rescheduleBriefingJobs(): void {
  const tz = process.env.TIMEZONE ?? "America/New_York";
  scheduleMorningJob(tz);
  scheduleEveningJob(tz);
  scheduleWeeklyJob(tz);
}

// ─── Scheduled jobs ────────────────────────────────────────────────────────
export function startScheduledJobs(): void {
  // ── 9am proactive suggestions push ────────────────────────────────────
  const tz = process.env.TIMEZONE ?? "America/New_York";
  const suggestionsCron = timeToCron("SUGGESTIONS_TIME", 9, 0);
  cron.schedule(suggestionsCron, async () => {
    console.log("⏰ Cron: generating proactive suggestions...");
    try {
      const briefing = await getCachedBriefing();
      suggestionsCache = null; // force regeneration
      const suggestions = await generateAiSuggestions(briefing);
      if (suggestions.length > 0) {
        pushNotification({
          type: "suggestion",
          title: "💡 Daily suggestions ready",
          body: suggestions[0], // tease the first one
        });
      }
    } catch (err) {
      console.error("Cron suggestions error:", err);
    }
  }, { timezone: tz });
  console.log(`⏰ Proactive suggestions scheduled: ${suggestionsCron} (${tz})`);

  scheduleMorningJob(tz);
  scheduleEveningJob(tz);
  scheduleWeeklyJob(tz);

  // Start SSE notification polling (calendar event reminders)
  startNotificationPolling();

  // Pre-warm the briefing cache 5 seconds after startup so the first
  // dashboard load hits a warm cache instead of building from scratch.
  setTimeout(() => {
    console.log("🔥 Pre-warming briefing cache on startup...");
    getCachedBriefing()
      .then(() => console.log("✅ Startup briefing cache warm."))
      .catch((err) => console.warn("⚠️  Startup cache warm failed:", err));
  }, 5_000);
}

// ─── Manual trigger: push suggestions notification now ────────────────────────
export async function pushSuggestionsNow(): Promise<string[]> {
  console.log("🔔 Manual trigger: generating proactive suggestions...");
  const briefing = await getCachedBriefing();
  suggestionsCache = null; // force fresh generation
  const suggestions = await generateAiSuggestions(briefing);
  if (suggestions.length > 0) {
    pushNotification({
      type: "suggestion",
      title: "💡 Daily suggestions ready",
      body: suggestions[0],
    });
  }
  return suggestions;
}

// ─── Proactive Suggestions ────────────────────────────────────────────────────
/**
 * Analyzes the morning briefing and returns an array of actionable suggestion strings.
 * These are surfaced as dismissible banners on the dashboard.
 */
function proactiveAnalysis(briefing: MorningBriefing): string[] {
  const suggestions: string[] = [];
  const events = briefing.calendar;
  const tasks  = briefing.googleTasks;
  const weather = briefing.weather;
  const nowMs = Date.now();

  // ── Back-to-back meetings (< 5 min gap, not yet started) ─────────────────
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (!a.startIso || !b.startIso) continue;
    const aEndMs = new Date(a.startIso).getTime() + 60 * 60_000; // rough 1hr estimate
    const bStartMs = new Date(b.startIso).getTime();
    if (bStartMs < nowMs) continue; // both already passed
    if (bStartMs - aEndMs < 5 * 60_000 && bStartMs > aEndMs) {
      suggestions.push(`📆 Back-to-back meetings: "${a.title}" runs into "${b.title}" with little buffer.`);
    }
  }

  // ── Events with location but no preceding travel buffer (not yet started) ─
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev.location || !ev.startIso) continue;
    const evStartMs = new Date(ev.startIso).getTime();
    if (evStartMs < nowMs) continue; // already started
    const prior = events[i - 1];
    if (prior && prior.startIso) {
      const priorEndMs = new Date(prior.startIso).getTime() + 60 * 60_000;
      if (evStartMs - priorEndMs < 30 * 60_000) {
        suggestions.push(`📍 "${ev.title}" is at ${ev.location} — you may need travel time after "${prior.title}".`);
      }
    }
  }

  // ── Overdue tasks (due > 3 days ago) ──────────────────────────────────────
  const todayMs = nowMs;
  const overdue = tasks.filter((t) => {
    if (!t.due || t.status === "completed") return false;
    const dueMs = new Date(t.due).getTime();
    return todayMs - dueMs > 3 * 24 * 60 * 60_000;
  });
  if (overdue.length > 0) {
    const titles = overdue.slice(0, 3).map(t => `"${t.title}"`).join(", ");
    suggestions.push(`⚠️ ${overdue.length} overdue task${overdue.length > 1 ? "s" : ""}: ${titles}${overdue.length > 3 ? " and more" : ""}.`);
  }

  // ── Rain today + outdoor/offsite event (future only) ─────────────────────────
  if (weather && weather.precipChance >= 60) {
    const outdoorEvents = events.filter(e =>
      e.location &&
      e.startIso && new Date(e.startIso).getTime() > nowMs &&
      !e.location.toLowerCase().includes("zoom") &&
      !e.location.toLowerCase().includes("teams") &&
      !e.location.toLowerCase().includes("meet")
    );
    if (outdoorEvents.length > 0) {
      suggestions.push(`🌧️ ${weather.precipChance}% chance of rain — "${outdoorEvents[0].title}" is at an in-person location. Consider an umbrella.`);
    }
  }

  // ── Heavy meeting day — count only future events ────────────────────────
  const futureEvents = events.filter(e => e.startIso && new Date(e.startIso).getTime() > nowMs);
  if (futureEvents.length >= 3) {
    suggestions.push(`🔥 ${futureEvents.length} meetings still ahead today. Block focus time if possible.`);
  }

  return suggestions;
}

// ─── AI-powered suggestions cache (TTL = 15 min, regenerated at 9am) ──────────
let suggestionsCache: { suggestions: string[]; fetchedAt: number } | null = null;
const SUGGESTIONS_TTL_MS = 15 * 60 * 1000;

export function getSuggestionsCacheAge(): string | null {
  return suggestionsCache ? new Date(suggestionsCache.fetchedAt).toISOString() : null;
}

/**
 * Uses the LLM to analyze today's briefing data and generate 3-5 smart,
 * actionable suggestions as a JSON array of short strings.
 */
export async function generateAiSuggestions(briefing: MorningBriefing): Promise<string[]> {
  const now = Date.now();
  if (suggestionsCache && now - suggestionsCache.fetchedAt < SUGGESTIONS_TTL_MS) {
    return suggestionsCache.suggestions;
  }

  // Start with rule-based suggestions as a fast baseline
  const ruleBased = proactiveAnalysis(briefing);

  // Build a compact briefing summary for the LLM prompt
  const tz = process.env.TIMEZONE ?? "America/New_York";
  const nowStr = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
  const calSummary = briefing.calendar.slice(0, 6)
    .map(e => {
      const isPast = e.startIso && new Date(e.startIso).getTime() < Date.now();
      return `- ${e.start}–${e.end}: ${e.title}${e.location ? ` @ ${e.location}` : ""}${isPast ? " [PAST]" : ""}`;
    }).join("\n") || "No events today";
  const taskSummary = briefing.googleTasks.filter(t => t.status !== "completed").slice(0, 8)
    .map(t => `- ${t.title}${t.due ? ` (due ${new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}`).join("\n") || "No open tasks";
  const emailSummary = briefing.importantEmails.slice(0, 5)
    .map(e => `- From ${e.from}: ${e.subject}`).join("\n") || "No important emails";
  const weatherLine = briefing.weather
    ? `${briefing.weather.condition}, ${briefing.weather.temperatureF}°F, rain ${briefing.weather.precipChance}%`
    : "Unknown";

  const prompt = `You are a smart daily planner assistant. Current time is ${nowStr}. Based on today's data, generate 3 to 5 SHORT, specific, actionable suggestions the user should act on RIGHT NOW or later today. Each suggestion should be a single sentence under 12 words. IMPORTANT: ignore any calendar events marked [PAST] — only suggest things that are still upcoming or actionable. Focus on what matters most — upcoming conflicts, urgent emails, overdue tasks, preparation needed, or time blocks to protect.

Today's data:
Current time: ${nowStr}
Weather: ${weatherLine}
Calendar (events marked [PAST] have already happened):\n${calSummary}
Open Tasks:\n${taskSummary}
Important Emails:\n${emailSummary}

Respond with ONLY a valid JSON array of strings, no explanation, no markdown. Example: ["Block focus time before 2pm meeting", "Reply to urgent email from Sarah"]`;

  try {
    const { chatAgent } = await import("./agents/chatAgent.js");
    const raw = await chatAgent("__suggestions__", prompt, undefined, "Assistant", "professional");
    // Extract JSON array from response
    const match = raw.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed: string[] = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Merge with rule-based, deduplicate, cap at 5
        const merged = [...new Set([...parsed, ...ruleBased])].slice(0, 5);
        suggestionsCache = { suggestions: merged, fetchedAt: Date.now() };
        return merged;
      }
    }
  } catch (err) {
    console.warn("AI suggestions failed, falling back to rule-based:", err instanceof Error ? err.message : err);
  }

  // Fallback to rule-based only
  suggestionsCache = { suggestions: ruleBased, fetchedAt: Date.now() };
  return ruleBased;
}

// ─── Morning Briefing ──────────────────────────────────────────────────────
export async function buildMorningBriefing(): Promise<MorningBriefing> {
  const t0 = Date.now();
  console.log("⏳ Fetching morning briefing data...");

  const [calendar, tasks, emails, news, weather, googleTasks] = await Promise.allSettled([
    calendarAgent(),
    taskAgent(),
    emailAgent(),
    newsAgent(),
    getWeather(),
    listTasks(30),
  ]);
  console.log(`⏳ Core fetches done in ${Date.now() - t0}ms`);

  const calendarData    = calendar.status     === "fulfilled" ? calendar.value     : [];
  const tasksData       = tasks.status        === "fulfilled" ? tasks.value        : [];
  const emailsData      = emails.status       === "fulfilled" ? emails.value       : [];
  const newsData        = news.status         === "fulfilled" ? news.value         : [];
  const weatherData     = weather.status      === "fulfilled" ? weather.value      : undefined;
  const googleTasksData = googleTasks.status  === "fulfilled" ? googleTasks.value  : [];

  if (calendar.status    === "rejected") console.error("Calendar error:",     calendar.reason);
  if (tasks.status       === "rejected") console.error("Tasks error:",        tasks.reason);
  if (emails.status      === "rejected") console.error("Email error:",        emails.reason);
  if (news.status        === "rejected") console.error("News error:",         news.reason);
  if (weather.status     === "rejected") console.error("Weather error:",      weather.reason);
  if (googleTasks.status === "rejected") console.error("Google Tasks error:", googleTasks.reason);

  const importantEmails = filterImportant(emailsData);

  // Scan shipping emails for packages arriving/delivered today — uses dedicated shipping search
  // so it catches read emails (delivered confirmations) not just unread
  let packagesToday: import("./types.js").PackageInfo[] = [];
  try {
    const allPackages = await getTrackedPackages(undefined, 2); // last 2 days for briefing
    packagesToday = allPackages.filter((p) => p.arrivingToday);
  } catch (err) {
    console.warn("Package scan error:", err instanceof Error ? err.message : err);
  }

  // Proactive analysis is synchronous — zero extra latency
  const suggestions = proactiveAnalysis({
    calendar: calendarData, emails: emailsData, importantEmails,
    news: newsData, weather: weatherData, googleTasks: googleTasksData,
    llmUsage: getUsageToday(), generatedAt: new Date().toISOString(),
  });

  const briefing: MorningBriefing = {
    calendar:     calendarData,
    emails:       emailsData,
    importantEmails,
    news:         newsData,
    weather:      weatherData,
    googleTasks:  googleTasksData,
    llmUsage:     getUsageToday(),
    generatedAt:  new Date().toISOString(),
    suggestions,
    packages:     packagesToday, // today's arriving packages shown in overview
  };

  console.log(`✅ Morning briefing built in ${Date.now() - t0}ms`);
  return briefing;
}

function formatMorningBriefingText(briefing: MorningBriefing): string {
  const schedule: ScheduleBlock[] = [
    { start: "06:30", end: "07:30", title: "Gym" },
    { start: "18:00", end: "19:00", title: "AWS Learning" },
  ];

  const review = criticAgent(schedule);

  const weatherSection = briefing.weather
    ? `  ${formatWeatherSummary(briefing.weather)}\n  🌅 Sunrise ${briefing.weather.sunrise} · 🌇 Sunset ${briefing.weather.sunset}`
    : "  Weather unavailable.";

  const calSection =
    briefing.calendar.length > 0
      ? briefing.calendar.map((e) => `  ${e.start}–${e.end}  ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n")
      : "  No events today.";

  const importantSection = (() => {
    if (briefing.importantEmails.length === 0) return "  None.";
    const byAccount: Record<string, typeof briefing.importantEmails> = {};
    for (const e of briefing.importantEmails) {
      const key = e.account ?? "personal";
      (byAccount[key] ??= []).push(e);
    }
    return Object.entries(byAccount).map(([acct, emails]) =>
      `  📂 ${acct.charAt(0).toUpperCase() + acct.slice(1)}\n` +
      emails.map(e => {
        const d = e.date ? new Date(e.date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.TIMEZONE || "America/New_York" }) : "";
        const sender = e.from.replace(/<[^>]+>/g, '').trim();
        return `    - [${e.subject}](open-email:${e.id}:${e.account ?? "personal"}) — ${sender}${d ? ` (${d})` : ""}`;
      }).join("\n")
    ).join("\n\n");
  })();

  const emailSection = (() => {
    if (briefing.emails.length === 0) return "  Inbox is clear.";
    const byAccount: Record<string, typeof briefing.emails> = {};
    for (const e of briefing.emails.slice(0, 10)) {
      const key = e.account ?? "personal";
      (byAccount[key] ??= []).push(e);
    }
    return Object.entries(byAccount).map(([acct, emails]) =>
      `  📂 ${acct.charAt(0).toUpperCase() + acct.slice(1)}\n` +
      emails.map(e => {
        const d = e.date ? new Date(e.date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.TIMEZONE || "America/New_York" }) : "";
        const sender = e.from.replace(/<[^>]+>/g, '').trim();
        return `    - [${e.subject}](open-email:${e.id}:${e.account ?? "personal"}) — ${sender}${d ? ` (${d})` : ""}`;
      }).join("\n")
    ).join("\n\n");
  })();

  const taskSection =
    briefing.googleTasks.length > 0
      ? briefing.googleTasks
          .map((t) => `  • ${t.title}${t.due ? ` (due ${new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}`)
          .join("\n")
      : "  No tasks.";

  const newsSection =
    briefing.news.length > 0
      ? briefing.news
          .map(
            (n) =>
              `\n  ${n.topic}:\n` +
              (n.articles.length > 0
                ? n.articles.map((a) => `  • [${a.title}](${a.url})`).join("\n")
                : "  No articles found.")
          )
          .join("\n")
      : "  No news loaded.";

  const usageSection = briefing.llmUsage
    ? `  ${briefing.llmUsage.totalTokens.toLocaleString()} tokens used today across ${briefing.llmUsage.calls} calls · Est. cost: $${briefing.llmUsage.estimatedCostUSD.toFixed(2)}`
    : "  No usage data yet.";

  const scheduleWarning = !review.valid ? "\n⚠️ Schedule conflict detected!\n" : "";

  return `
Good morning! Here's your morning briefing for ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}

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

async function formatEveningBriefingText(briefing: MorningBriefing): Promise<string> {
  const home = process.env.HOME_ADDRESS;
  const work = process.env.WORK_ADDRESS;

  const tz = process.env.TIMEZONE ?? "America/New_York";

  // Compute tomorrow's date in the user's timezone, then use RFC3339 date
  // boundaries so Google Calendar receives correct midnight-to-midnight range.
  const nowUtc = new Date();
  // Get today's local date in the target tz (YYYY-MM-DD)
  const todayLocal = nowUtc.toLocaleDateString("en-CA", { timeZone: tz });
  const [ty, tm, td] = todayLocal.split("-").map(Number);
  // Add 1 day safely (Date.UTC handles month/year rollover)
  const tmrDateUtc = new Date(Date.UTC(ty, tm - 1, td + 1));
  const tmrY = tmrDateUtc.getUTCFullYear();
  const tmrM = String(tmrDateUtc.getUTCMonth() + 1).padStart(2, "0");
  const tmrD = String(tmrDateUtc.getUTCDate()).padStart(2, "0");
  // Get the UTC offset for the tz on that date using Intl (handles DST correctly)
  const anchor = new Date(`${tmrY}-${tmrM}-${tmrD}T12:00:00Z`);
  const tzPart = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, timeZoneName: "shortOffset",
  }).formatToParts(anchor).find(p => p.type === "timeZoneName")?.value ?? "GMT+0";
  // tzPart is e.g. "GMT-5" or "GMT+5:30"
  const tzMatch = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const offsetSign = tzMatch ? tzMatch[1] : "+";
  const offsetH    = tzMatch ? String(tzMatch[2]).padStart(2, "0") : "00";
  const offsetM    = tzMatch ? String(tzMatch[3] ?? "0").padStart(2, "0") : "00";
  const tzOffset   = `${offsetSign}${offsetH}:${offsetM}`;
  // RFC3339 midnight boundaries for tomorrow in the user's tz
  const tmrStart = new Date(`${tmrY}-${tmrM}-${tmrD}T00:00:00${tzOffset}`);
  const tmrEnd   = new Date(`${tmrY}-${tmrM}-${tmrD}T23:59:59${tzOffset}`);
  console.log(`[evening] tz=${tz} offset=${tzOffset} tmrStart=${tmrStart.toISOString()} tmrEnd=${tmrEnd.toISOString()}`);
  const tomorrowStr = tmrStart.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });

  let tomorrowEvents: string;
  try {
    const { getCalendarEventsByRange } = await import("./tools/calendarTools.js");
    const events = await getCalendarEventsByRange(tmrStart.toISOString(), tmrEnd.toISOString());
    tomorrowEvents = events.length > 0
      ? events.map((e) => `  ${e.start}–${e.end}  ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n")
      : "  Nothing scheduled.";
  } catch {
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
    } catch { /* Maps unavailable */ }
  }

  const openTasks = briefing.googleTasks.filter((t) => t.status !== "completed");
  const taskSection = openTasks.length > 0
    ? openTasks.map((t) => `  • ${t.title}${t.due ? ` (due ${new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}`).join("\n")
    : "  All tasks complete! 🎉";

  const usageSection = briefing.llmUsage
    ? `  ${briefing.llmUsage.totalTokens.toLocaleString()} tokens across ${briefing.llmUsage.calls} calls · Est. cost: $${briefing.llmUsage.estimatedCostUSD.toFixed(2)}`
    : "  No usage data.";

  return [
    `Good evening! Here's your end-of-day summary for ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz })}`,
    commuteSection,
    `\n📅 TOMORROW — ${tomorrowStr}\n${tomorrowEvents}`,
    `\n✅ OPEN TASKS\n${taskSection}`,
    `\n🤖 LLM USAGE TODAY\n${usageSection}`,
    `\n💬 Ask me anything before you wrap up!`,
  ].join("\n").trim();
}

// ─── Main coordinator ──────────────────────────────────────────────────────
const MORNING_TRIGGERS = ["/morning", "good morning", "morning briefing", "daily briefing", "start my day"];

export async function coordinatorAgent(message: string, userId = "default", assistantName = "Assistant", tone: AssistantTone = "professional"): Promise<string> {
  const lower = message.toLowerCase().trim();

  // Morning briefing request
  if (MORNING_TRIGGERS.some((t) => lower.includes(t))) {
    try {
      const briefing = await buildMorningBriefing();
      briefingCache.set(userId, briefing);
      return formatMorningBriefingText(briefing);
    } catch (err) {
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
    } catch (err) {
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
  // Use per-user briefing if available; fall back to shared dashboard briefing cache
  let briefing = briefingCache.get(userId);
  if (!briefing) {
    try {
      briefing = await getCachedBriefing();
    } catch {
      // no briefing available — chat will still work, just without briefing context
    }
  }
  try {
    return await chatAgent(userId, message, briefing, assistantName, tone);
  } catch (err: any) {
    console.error("Chat agent error:", err?.status, err?.error ?? err?.message ?? err);
    const status = err?.status ?? err?.code;
    if (status === 401) return "❌ Invalid Grok API key. Check XAI_API_KEY in .env";
    if (status === 429) return "❌ Grok rate limit hit. Try again in a moment.";
    if (status === 404) return `❌ Grok model not found: ${err?.error?.message ?? ""}`;
    return `❌ AI error (${status ?? "unknown"}): ${err?.error?.message ?? err?.message ?? "Please try again."}`;
  }
}

