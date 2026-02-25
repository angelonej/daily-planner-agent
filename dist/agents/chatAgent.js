import OpenAI from "openai";
import { fetchAllAccountEmails, searchEmails, markEmailsAsRead } from "../tools/gmailTools.js";
import { createEvent, updateEvent, deleteEvent, searchEvents, listEventsByRange, } from "./calendarAgent.js";
import { listTasks, createTask, completeTask, deleteTask, findTasksByTitle, } from "../tools/tasksTools.js";
import { suggestRecurringEvents, formatRecurringSuggestions } from "../tools/recurringTools.js";
import { sendDailyDigestEmail } from "../tools/digestEmail.js";
import { getWeatherForecast } from "../tools/weatherTools.js";
import { recordUsage, getUsageToday, getUsageHistory } from "../tools/usageTracker.js";
import { getReminders, addReminder, deleteReminder, describeReminder } from "../tools/remindersTools.js";
import { getTrackedPackages } from "../tools/packageTools.js";
const openai = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: "https://api.x.ai/v1",
});
// In-memory conversation history per user (keyed by chat/user ID)
const conversationHistory = new Map();
const SYSTEM_PROMPT = `You are a sharp, concise personal assistant AI. You help the user manage their day.
You have access to their morning briefing (calendar events, emails, news) and can CREATE, UPDATE, and DELETE calendar events.
When answering questions, reference their actual data when relevant.
Keep responses brief and actionable. Use bullet points for lists.
When including links, always use markdown format: [View Event](https://...) — never paste raw URLs.
Do NOT include Google Calendar event links in responses — just confirm the event title and time.
If asked to summarize emails or news, use the briefing data provided.
When the user asks to add, create, schedule, move, reschedule, cancel, or delete a calendar event, use the appropriate calendar tool.
When the user asks about recurring events, patterns, or regular meetings, use suggest_recurring_events.
When the user asks to send the daily digest, morning summary, or briefing email, use send_digest_email.
When the user asks about weather (today, tomorrow, this week, will it rain, forecast, etc.), ALWAYS call get_weather with the appropriate number of days.
When the user asks to check emails, show today's emails, list unread emails, or get recent emails, ALWAYS call list_emails.
When the user asks for the last email from someone, emails about a topic, or to search emails, ALWAYS call search_emails with the appropriate Gmail query.
When the user asks to mark emails as read, clear unread, or mark today's emails as read, ALWAYS call mark_emails_read.
When the user asks about token usage, LLM usage, API cost, how many tokens used, or AI usage stats, ALWAYS call get_llm_usage.
When the user asks to add a reminder, set a recurring reminder, remind me about, or schedule a recurring alert (e.g. "remind me to pay my Amex bill on the 15th every month"), ALWAYS call add_reminder.
When the user asks to see, list, or show reminders, ALWAYS call list_reminders.
When the user asks to delete, remove, or cancel a reminder, ALWAYS call delete_reminder.
When the user asks to find a free time slot, schedule something, when am I free, or find open time, ALWAYS call find_free_slot with the date and duration.
When the user asks about packages, shipments, tracking, deliveries, or "where is my package", ALWAYS call track_packages.
When the user asks for suggestions, tips, what should I know about today, or proactive advice, ALWAYS call get_suggestions.
For ambiguous requests (e.g. 'move my dentist'), use search_calendar_events first to find the event ID.
Always confirm the action taken with the event title and time.
Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;
// ─── OpenAI tool definitions for calendar actions ──────────────────────────
const CALENDAR_TOOLS = [
    {
        type: "function",
        function: {
            name: "create_calendar_event",
            description: "Create a new event on the user's Google Calendar.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Event title/summary" },
                    startIso: { type: "string", description: "Start datetime in ISO 8601 format, e.g. 2026-02-25T14:00" },
                    endIso: { type: "string", description: "End datetime in ISO 8601 format, e.g. 2026-02-25T15:00" },
                    location: { type: "string", description: "Optional location" },
                    description: { type: "string", description: "Optional description or notes" },
                },
                required: ["title", "startIso", "endIso"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_calendar_event",
            description: "Update an existing calendar event. Requires the eventId. Use search_calendar_events first if you don't have it.",
            parameters: {
                type: "object",
                properties: {
                    eventId: { type: "string", description: "Google Calendar event ID" },
                    title: { type: "string", description: "New title (optional)" },
                    startIso: { type: "string", description: "New start datetime ISO 8601 (optional)" },
                    endIso: { type: "string", description: "New end datetime ISO 8601 (optional)" },
                    location: { type: "string", description: "New location (optional)" },
                    description: { type: "string", description: "New description (optional)" },
                },
                required: ["eventId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_calendar_event",
            description: "Delete a calendar event by its ID. Use search_calendar_events first if you don't have the ID.",
            parameters: {
                type: "object",
                properties: {
                    eventId: { type: "string", description: "Google Calendar event ID to delete" },
                },
                required: ["eventId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_calendar_events",
            description: "List calendar events between two dates. Use for: 'show this week', 'what's on my calendar', 'events this week/month/tomorrow/next week', or any request to VIEW events for a date range. Always call this for calendar viewing requests.",
            parameters: {
                type: "object",
                properties: {
                    startIso: { type: "string", description: "Start of range in ISO 8601, e.g. 2026-02-24T00:00:00" },
                    endIso: { type: "string", description: "End of range in ISO 8601, e.g. 2026-03-02T23:59:59" },
                },
                required: ["startIso", "endIso"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_calendar_events",
            description: "Search for calendar events by title keyword, returns events with their IDs. Use this before update/delete.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search keyword (e.g. 'dentist', 'gym', 'AWS')" },
                    daysToSearch: { type: "number", description: "How many days ahead to search (default 14)" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_tasks",
            description: "List the user's Google Tasks (incomplete tasks). Use this to show their task list or find a task ID.",
            parameters: {
                type: "object",
                properties: {
                    maxResults: { type: "number", description: "Max tasks to return (default 20)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_task",
            description: "Create a new Google Task.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Task title" },
                    notes: { type: "string", description: "Optional notes/description" },
                    due: { type: "string", description: "Optional due date in ISO 8601 format (e.g. 2026-03-01T00:00:00.000Z)" },
                },
                required: ["title"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "complete_task",
            description: "Mark a Google Task as completed. Use list_tasks or find_tasks first to get the task ID and listId.",
            parameters: {
                type: "object",
                properties: {
                    taskId: { type: "string", description: "Task ID" },
                    listId: { type: "string", description: "Task list ID the task belongs to" },
                    title: { type: "string", description: "Task title (for confirmation message)" },
                },
                required: ["taskId", "listId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_task",
            description: "Delete a Google Task permanently.",
            parameters: {
                type: "object",
                properties: {
                    taskId: { type: "string", description: "Task ID" },
                    listId: { type: "string", description: "Task list ID" },
                    title: { type: "string", description: "Task title (for confirmation message)" },
                },
                required: ["taskId", "listId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_tasks",
            description: "Search for tasks by title keyword. Returns matching tasks with their IDs.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keyword to search for in task titles" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "suggest_recurring_events",
            description: "Analyze the user's calendar history to identify events that happen regularly (e.g. weekly meetings, gym sessions) and suggest making them recurring. Use when the user asks about recurring events, patterns in their calendar, or regular meetings.",
            parameters: {
                type: "object",
                properties: {
                    weeksBack: { type: "number", description: "How many weeks of history to analyze (default: 4)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "send_digest_email",
            description: "Build the morning briefing and send it as an HTML email to the user. Use when asked to 'send the digest', 'email me the briefing', or 'send morning summary'.",
            parameters: {
                type: "object",
                properties: {
                    toEmail: { type: "string", description: "Recipient email address (optional, uses DIGEST_EMAIL_TO env var if not provided)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Get the weather forecast for today, tomorrow, or the next several days. Use for any weather question: 'weather tomorrow', 'forecast this week', 'will it rain Friday', 'what's the weather like', etc.",
            parameters: {
                type: "object",
                properties: {
                    days: { type: "number", description: "Number of days to forecast (1=today only, 2=today+tomorrow, 7=full week). Default 3." },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_emails",
            description: "Fetch the latest unread emails from all Gmail accounts. Use for: 'check my emails', 'any new emails', 'show today\'s emails', 'what emails do I have', 'unread emails'.",
            parameters: {
                type: "object",
                properties: {
                    maxResults: { type: "number", description: "Max number of emails to return per account (default 10)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_emails",
            description: "Search Gmail using a query. Use for: 'last email from John', 'emails about invoice', 'emails from Amazon', 'find email about contract', 'most recent email from X'. Build the Gmail query from the user's request.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Gmail search query, e.g. 'from:john@example.com', 'subject:invoice', 'from:amazon', 'newer_than:1d'" },
                    account: { type: "string", description: "Optional: which account to search — 'personal' or 'work'. Omit to search both." },
                    maxResults: { type: "number", description: "Max emails to return (default 5)" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_llm_usage",
            description: "Get LLM token usage and estimated API cost. Use when the user asks about token usage, AI usage, how many tokens used, API cost, or LLM stats.",
            parameters: {
                type: "object",
                properties: {
                    days: { type: "number", description: "Number of days of history to return (default 1 = today only, max 7)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "mark_emails_read",
            description: "Mark emails as read in Gmail. Use when the user asks to 'mark emails as read', 'mark today\'s emails as read', 'clear my unread', or 'mark all as read'. Can target a specific account or all accounts.",
            parameters: {
                type: "object",
                properties: {
                    account: { type: "string", description: "Which account to mark: 'personal', 'work', or omit for both." },
                    query: { type: "string", description: "Gmail query to select which emails to mark as read. Default: 'is:unread' (all unread). Use 'is:unread newer_than:1d' for today only." },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "add_reminder",
            description: "Create a recurring reminder that fires as a push notification. Use for things like 'remind me to pay my bill on the 15th every month', 'remind me every Monday at 9am', 'remind me every day at 8pm to take medication'. Supports daily, weekly, monthly, and yearly frequencies.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "What to remind the user about, e.g. 'Pay Amex bill'" },
                    frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"], description: "How often the reminder repeats" },
                    time: { type: "string", description: "Time of day in 24-hour HH:MM format, e.g. '09:00'" },
                    dayOfWeek: { type: "number", description: "Day of week for weekly reminders: 0=Sunday, 1=Monday … 6=Saturday" },
                    dayOfMonth: { type: "number", description: "Day of month (1-31) for monthly or yearly reminders" },
                    month: { type: "number", description: "Month (1-12) for yearly reminders" },
                    notes: { type: "string", description: "Optional extra context shown in the notification body" },
                },
                required: ["title", "frequency", "time"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_reminders",
            description: "List all active recurring reminders the user has set.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_reminder",
            description: "Delete a recurring reminder by its ID. Use list_reminders first to find the ID if needed.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "The reminder ID to delete" },
                },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_free_slot",
            description: "Find available time slots on the user's calendar for a given date. Use when the user asks 'when am I free', 'find me a free slot', 'schedule a meeting for Tuesday', or any request to find open calendar time.",
            parameters: {
                type: "object",
                properties: {
                    date: { type: "string", description: "Date to check in YYYY-MM-DD format" },
                    durationMinutes: { type: "number", description: "How long the slot needs to be, in minutes (e.g. 60)" },
                    preferredStartHour: { type: "number", description: "Preferred earliest start hour (0-23, e.g. 9 for 9 AM). Default 8." },
                    preferredEndHour: { type: "number", description: "Preferred latest end hour (0-23, e.g. 18 for 6 PM). Default 18." },
                },
                required: ["date", "durationMinutes"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "track_packages",
            description: "Scan emails for shipping tracking numbers (UPS, FedEx, USPS, Amazon) and return package details with tracking links. Use when the user asks about packages, deliveries, shipments, or tracking numbers.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "get_suggestions",
            description: "Get proactive suggestions and insights about today based on the current briefing data. Use when the user asks for advice, suggestions, tips, or 'what should I know about today'.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
];
// ─── Execute a tool call returned by the model ────────────────────────────
async function executeTool(name, args) {
    console.log(`🔧 Tool call: ${name}`, JSON.stringify(args));
    try {
        switch (name) {
            case "create_calendar_event": {
                const result = await createEvent({
                    title: String(args.title),
                    startIso: String(args.startIso),
                    endIso: String(args.endIso),
                    location: args.location ? String(args.location) : undefined,
                    description: args.description ? String(args.description) : undefined,
                });
                return JSON.stringify({ success: true, eventId: result.eventId });
            }
            case "update_calendar_event": {
                await updateEvent({
                    eventId: String(args.eventId),
                    title: args.title ? String(args.title) : undefined,
                    startIso: args.startIso ? String(args.startIso) : undefined,
                    endIso: args.endIso ? String(args.endIso) : undefined,
                    location: args.location ? String(args.location) : undefined,
                    description: args.description ? String(args.description) : undefined,
                });
                return JSON.stringify({ success: true });
            }
            case "delete_calendar_event": {
                await deleteEvent(String(args.eventId));
                return JSON.stringify({ success: true });
            }
            case "list_calendar_events": {
                const events = await listEventsByRange(String(args.startIso), String(args.endIso));
                if (events.length === 0)
                    return JSON.stringify({ message: "No events found in that date range." });
                return JSON.stringify(events);
            }
            case "search_calendar_events": {
                const events = await searchEvents(String(args.query), Number(args.daysToSearch ?? 14));
                return JSON.stringify(events);
            }
            case "list_tasks": {
                const t = await listTasks(Number(args.maxResults ?? 20));
                return JSON.stringify(t);
            }
            case "create_task": {
                const t = await createTask(String(args.title), {
                    notes: args.notes ? String(args.notes) : undefined,
                    due: args.due ? String(args.due) : undefined,
                });
                return JSON.stringify({ success: true, taskId: t.id, title: t.title });
            }
            case "complete_task": {
                await completeTask(String(args.taskId), String(args.listId));
                return JSON.stringify({ success: true, message: `Marked "${args.title ?? args.taskId}" as complete.` });
            }
            case "delete_task": {
                await deleteTask(String(args.taskId), String(args.listId));
                return JSON.stringify({ success: true, message: `Deleted "${args.title ?? args.taskId}".` });
            }
            case "find_tasks": {
                const t = await findTasksByTitle(String(args.query));
                return JSON.stringify(t);
            }
            case "suggest_recurring_events": {
                const weeks = args.weeksBack ? Number(args.weeksBack) : 4;
                const suggestions = await suggestRecurringEvents(weeks);
                return formatRecurringSuggestions(suggestions);
            }
            case "send_digest_email": {
                // Need to build briefing first
                const { buildMorningBriefing } = await import("../coordinator.js");
                const briefing = await buildMorningBriefing();
                const result = await sendDailyDigestEmail(briefing, args.toEmail ? String(args.toEmail) : undefined);
                if (result.success)
                    return JSON.stringify({ success: true, message: `Digest email sent! (id: ${result.messageId})` });
                return JSON.stringify({ success: false, error: result.error });
            }
            case "get_weather": {
                const days = args.days ? Number(args.days) : 3;
                const forecast = await getWeatherForecast(days);
                return JSON.stringify(forecast);
            }
            case "list_emails": {
                const max = args.maxResults ? Number(args.maxResults) : 10;
                const emails = await fetchAllAccountEmails();
                const slice = emails.slice(0, max);
                if (slice.length === 0)
                    return JSON.stringify({ message: "No unread emails found." });
                return JSON.stringify(slice.map((e) => ({
                    subject: e.subject,
                    from: e.from,
                    date: e.date,
                    snippet: e.snippet,
                    account: e.account,
                    isImportant: e.isImportant,
                })));
            }
            case "search_emails": {
                const q = String(args.query);
                const acct = args.account ? String(args.account) : undefined;
                const max = args.maxResults ? Number(args.maxResults) : 5;
                const emails = await searchEmails(q, acct, max);
                if (emails.length === 0)
                    return JSON.stringify({ message: `No emails found for query: "${q}"` });
                return JSON.stringify(emails.map((e) => ({
                    subject: e.subject,
                    from: e.from,
                    date: e.date,
                    snippet: e.snippet,
                    account: e.account,
                    isImportant: e.isImportant,
                })));
            }
            case "get_llm_usage": {
                const days = args.days ? Number(args.days) : 1;
                if (days <= 1) {
                    const usage = getUsageToday();
                    return JSON.stringify(usage);
                }
                else {
                    const history = getUsageHistory(Math.min(days, 7));
                    return JSON.stringify(history);
                }
            }
            case "mark_emails_read": {
                const accounts = args.account
                    ? [String(args.account)]
                    : [
                        process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal",
                        process.env.GMAIL_ACCOUNT_2_ALIAS ?? "work",
                    ];
                const query = args.query ? String(args.query) : "is:unread";
                let totalMarked = 0;
                const details = [];
                for (const alias of accounts) {
                    try {
                        const { marked } = await markEmailsAsRead(alias, query);
                        totalMarked += marked;
                        details.push(`${alias}: ${marked} marked`);
                    }
                    catch (e) {
                        details.push(`${alias}: failed (${e.message})`);
                    }
                }
                return JSON.stringify({ totalMarked, details });
            }
            case "add_reminder": {
                const r = addReminder({
                    title: String(args.title),
                    frequency: String(args.frequency),
                    time: String(args.time),
                    dayOfWeek: args.dayOfWeek !== undefined ? Number(args.dayOfWeek) : undefined,
                    dayOfMonth: args.dayOfMonth !== undefined ? Number(args.dayOfMonth) : undefined,
                    month: args.month !== undefined ? Number(args.month) : undefined,
                    notes: args.notes ? String(args.notes) : undefined,
                });
                return JSON.stringify({ ok: true, reminder: r, description: describeReminder(r) });
            }
            case "list_reminders": {
                const reminders = getReminders();
                if (reminders.length === 0)
                    return JSON.stringify({ message: "No reminders set yet." });
                return JSON.stringify(reminders.map(r => ({
                    id: r.id,
                    title: r.title,
                    schedule: describeReminder(r),
                    notes: r.notes,
                    active: r.active,
                })));
            }
            case "delete_reminder": {
                const ok = deleteReminder(String(args.id));
                return JSON.stringify({ ok, message: ok ? "Reminder deleted." : "Reminder not found." });
            }
            case "find_free_slot": {
                const date = String(args.date);
                const durationMin = Number(args.durationMinutes ?? 60);
                const startHour = Number(args.preferredStartHour ?? 8);
                const endHour = Number(args.preferredEndHour ?? 18);
                const dayStart = new Date(`${date}T00:00:00`);
                const dayEnd = new Date(`${date}T23:59:59`);
                const events = await listEventsByRange(dayStart.toISOString(), dayEnd.toISOString());
                // Build busy blocks from events that have ISO times
                const busy = [];
                for (const ev of events) {
                    if (!ev.startIso)
                        continue;
                    const s = new Date(ev.startIso).getTime();
                    // Estimate end: use next event start or startIso + 1hr
                    const eEnd = s + 60 * 60_000;
                    busy.push({ start: s, end: eEnd });
                }
                busy.sort((a, b) => a.start - b.start);
                // Find gaps
                const freeSlots = [];
                let cursor = new Date(`${date}T${String(startHour).padStart(2, "0")}:00:00`).getTime();
                const windowEnd = new Date(`${date}T${String(endHour).padStart(2, "0")}:00:00`).getTime();
                for (const block of busy) {
                    if (block.start > cursor && block.start - cursor >= durationMin * 60_000) {
                        const slotEnd = Math.min(block.start, cursor + durationMin * 60_000);
                        freeSlots.push({
                            start: new Date(cursor).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
                            end: new Date(slotEnd).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
                        });
                    }
                    cursor = Math.max(cursor, block.end);
                    if (freeSlots.length >= 3)
                        break;
                }
                // Check gap after last event
                if (freeSlots.length < 3 && windowEnd - cursor >= durationMin * 60_000) {
                    freeSlots.push({
                        start: new Date(cursor).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
                        end: new Date(cursor + durationMin * 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
                    });
                }
                if (freeSlots.length === 0) {
                    return JSON.stringify({ message: `No free ${durationMin}-minute slots found on ${date} between ${startHour}:00 and ${endHour}:00.` });
                }
                return JSON.stringify({ date, durationMinutes: durationMin, freeSlots });
            }
            case "track_packages": {
                const packages = await getTrackedPackages();
                if (packages.length === 0)
                    return JSON.stringify({ message: "No tracking numbers found in recent emails." });
                return JSON.stringify(packages.map(p => ({
                    carrier: p.carrier,
                    tracking: p.trackingNumber,
                    url: p.trackingUrl,
                    subject: p.emailSubject,
                    from: p.emailFrom,
                    date: p.emailDate,
                })));
            }
            case "get_suggestions": {
                const { getCachedBriefing } = await import("../coordinator.js");
                const briefing = await getCachedBriefing();
                if (!briefing.suggestions || briefing.suggestions.length === 0) {
                    return JSON.stringify({ message: "No proactive suggestions right now — your day looks well-organized!" });
                }
                return JSON.stringify({ suggestions: briefing.suggestions });
            }
            default:
                return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Tool [${name}] failed:`, err);
        return JSON.stringify({ error: msg });
    }
}
export function formatBriefingContext(briefing) {
    const calSection = briefing.calendar.length > 0
        ? briefing.calendar
            .map((e) => `  • ${e.start}–${e.end}: ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.eventId ? ` [id:${e.eventId}]` : ""}`)
            .join("\n")
        : "  No events today.";
    const importantEmails = briefing.importantEmails.length > 0
        ? briefing.importantEmails.map((e) => `  ⚠️ [${e.account}] ${e.subject} — from ${e.from}`).join("\n")
        : "  None.";
    const allEmails = briefing.emails.length > 0
        ? briefing.emails.slice(0, 10).map((e) => `  • [${e.account}] ${e.subject} — from ${e.from}`).join("\n")
        : "  No unread emails.";
    const newsSection = briefing.news.length > 0
        ? briefing.news
            .map((n) => `  ${n.topic}:\n` +
            (n.articles.length > 0
                ? n.articles.map((a) => `    - ${a.title} (${a.source})`).join("\n")
                : "    No articles found."))
            .join("\n")
        : "  No news loaded.";
    const weatherSection = briefing.weather
        ? `  ${briefing.weather.condition}, ${briefing.weather.temperatureF}°F (feels ${briefing.weather.feelsLikeF}°F), H:${briefing.weather.high}° L:${briefing.weather.low}°, ${briefing.weather.precipChance}% rain chance`
        : "  Not available.";
    const tasksSection = briefing.googleTasks.length > 0
        ? briefing.googleTasks.map((t) => `  • [id:${t.id}][list:${t.listId}] ${t.title}${t.due ? ` (due ${t.due})` : ""}`).join("\n")
        : "  No tasks.";
    return `--- CURRENT BRIEFING DATA ---
🌤️ Weather (${briefing.weather?.location ?? ""}):
${weatherSection}

📅 Calendar (today):
${calSection}

⚠️ Important Emails:
${importantEmails}

📧 All Unread Emails (${briefing.emails.length} total):
${allEmails}

✅ Google Tasks:
${tasksSection}

📰 Morning News:
${newsSection}
--- END BRIEFING DATA ---`;
}
export async function chatAgent(userId, userMessage, briefing) {
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);
    const systemContent = briefing
        ? `${SYSTEM_PROMPT}\n\n${formatBriefingContext(briefing)}`
        : SYSTEM_PROMPT;
    const messages = [
        { role: "system", content: systemContent },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
    ];
    const model = process.env.OPENAI_MODEL ?? "grok-3";
    // ── Agentic loop: keep calling until no more tool calls ──────────────────
    let reply = "";
    for (let turn = 0; turn < 5; turn++) {
        const response = await openai.chat.completions.create({
            model,
            messages,
            tools: CALENDAR_TOOLS,
            tool_choice: "auto",
            max_tokens: 1200,
            temperature: 0.3,
        });
        // Track token usage for billing visibility
        recordUsage(response.usage, model);
        const choice = response.choices[0];
        const assistantMsg = choice.message;
        console.log(`🤖 Grok finish_reason: ${choice.finish_reason}, tool_calls: ${assistantMsg.tool_calls?.length ?? 0}, tokens: ${response.usage?.total_tokens ?? "?"}`);
        messages.push(assistantMsg);
        if (choice.finish_reason === "tool_calls" && assistantMsg.tool_calls) {
            // Execute each tool call and feed results back
            for (const toolCall of assistantMsg.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                const result = await executeTool(toolCall.function.name, args);
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result,
                });
            }
            continue; // loop again so model can compose final reply
        }
        reply = assistantMsg.content?.trim() ?? "Done.";
        break;
    }
    // Save exchange to history (keep last 20 turns)
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: reply });
    if (history.length > 40)
        history.splice(0, 2);
    return reply;
}
export function clearHistory(userId) {
    conversationHistory.delete(userId);
}
