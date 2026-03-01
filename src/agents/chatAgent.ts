import OpenAI from "openai";
import { ChatMessage, MorningBriefing } from "../types.js";
import { fetchAllAccountEmails, searchEmails, markEmailsAsRead } from "../tools/gmailTools.js";
import {
  createEvent,
  updateEvent,
  deleteEvent,
  searchEvents,
  listEventsByRange,
} from "./calendarAgent.js";
import {
  listTasks,
  createTask,
  completeTask,
  deleteTask,
  findTasksByTitle,
} from "../tools/tasksTools.js";
import { suggestRecurringEvents, formatRecurringSuggestions } from "../tools/recurringTools.js";
import { sendDailyDigestEmail } from "../tools/digestEmail.js";
import { getWeatherForecast } from "../tools/weatherTools.js";
import { recordUsage, getUsageToday, getUsageHistory } from "../tools/usageTracker.js";
import { getReminders, addReminder, deleteReminder, describeReminder } from "../tools/remindersTools.js";
import { getTrackedPackages } from "../tools/packageTools.js";
import { getAwsCostSummary, formatAwsCostSummary } from "../tools/awsCostTools.js";
import { searchContacts, formatContacts } from "../tools/contactsTools.js";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
  }
  return _openai;
}

// In-memory conversation history per user (keyed by chat/user ID)
const conversationHistory = new Map<string, ChatMessage[]>();

export type AssistantTone = "professional" | "friendly" | "casual" | "coach" | "witty";

const TONE_INSTRUCTIONS: Record<AssistantTone, string> = {
  professional: "Be professional, concise, and precise. Use clear structured responses. Keep a formal but warm tone.",
  friendly:     "Be warm, encouraging, and conversational. Feel free to use a friendly tone and light positivity.",
  casual:       "Keep it totally chill and relaxed. Short sentences, natural language, no corporate-speak. Like texting a smart friend.",
  coach:        "Be motivating and energetic like a personal productivity coach. Celebrate wins, encourage action, push the user to crush their goals.",
  witty:        "Be clever and a little funny. Add wit, dry humor, or playful observations where appropriate — but always stay helpful.",
};

function buildSystemPrompt(assistantName = "Assistant", tone: AssistantTone = "professional"): string {
  const toneInstruction = TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS.professional;
  return `You are ${assistantName}, a personal assistant AI. You help the user manage their day.
${toneInstruction}
You have access to their morning briefing (calendar events, emails, news) and can CREATE, UPDATE, and DELETE calendar events.
When answering questions, reference their actual data when relevant.
Keep responses brief and actionable. Use bullet points for lists.
When including links, always use markdown format: [View Event](https://...) — never paste raw URLs.
Do NOT include Google Calendar event links in responses — just confirm the event title and time.
If asked about news, what's in the news, today's headlines, or any news topic, ALWAYS use the 📰 Morning News section from the briefing data provided — never say you cannot access news.
When the user asks to add, create, schedule, move, reschedule, cancel, or delete a calendar event, use the appropriate calendar tool.
When the user asks WHEN something is, WHERE an event is, WHAT TIME an event starts, or ANY question about upcoming events on their calendar (e.g. "when does X play", "is Y scheduled", "do I have Z coming up"), ALWAYS call search_calendar_events — NEVER answer from memory or make up dates.
When the user asks about recurring events, patterns, or regular meetings, use suggest_recurring_events.
When the user asks to send the daily digest, morning summary, or briefing email, use send_digest_email.
When the user asks about weather (today, tomorrow, this week, will it rain, forecast, etc.), ALWAYS call get_weather with the appropriate number of days.
When the user asks to check emails, show today's emails, list unread emails, or get recent emails, ALWAYS call list_emails.
When the user asks for the last email from someone, emails about a topic, or to search emails, ALWAYS call search_emails with the appropriate Gmail query.
When list_emails or search_emails returns a result, output it VERBATIM — do NOT rewrite, reformat, or summarize it. The result already contains properly formatted clickable markdown links that must be preserved exactly.
When the user asks to mark emails as read, clear unread, or mark today's emails as read, ALWAYS call mark_emails_read.
When the user asks about token usage, LLM usage, API cost, how many tokens used, or AI usage stats, ALWAYS call get_llm_usage.
When the user asks to set a reminder — whether one-time ("remind me tonight", "remind me tomorrow at 3") or recurring ("every Monday", "every month on the 15th") — ALWAYS call add_reminder. For one-time reminders use frequency="once" and set fireDate to the specific YYYY-MM-DD date. For recurring use daily/weekly/monthly/yearly.
When the user asks to see, list, or show reminders, ALWAYS call list_reminders.
When the user asks to delete, remove, or cancel a reminder, ALWAYS call delete_reminder.
When the user asks to find a free time slot, schedule something, when am I free, or find open time, ALWAYS call find_free_slot with the date and duration.
When the user asks about packages, shipments, tracking, deliveries, "where is my package", "any packages coming", "packages coming soon", "expecting a package", "what packages", "when will my order", or anything about orders being shipped or delivered, ALWAYS call track_packages.
When the user asks for suggestions, tips, what should I know about today, or proactive advice, ALWAYS call get_suggestions.
When the user asks about AWS costs, cloud spend, monthly bill, EC2 charges, or how much AWS is costing, ALWAYS call get_aws_cost.
When the user asks about commute time, drive time, traffic, how long to get home or to work, or how's the traffic, ALWAYS call get_traffic.
When the user asks for someone's phone number, contact info, or to call/text someone, ALWAYS call lookup_contact. NEVER invent or guess contact details — only report what the tool actually returns. If the tool returns no contacts found, tell the user exactly that.
When showing a phone number, ALWAYS format it as a markdown tel: link: [+15555551234](tel:+15555551234)
When showing an address or location, ALWAYS format it as a clickable Maps link: [123 Main St, City ST](https://maps.google.com/?q=123+Main+St+City+ST) — encode spaces as +.
For ambiguous requests (e.g. 'move my dentist'), use search_calendar_events first to find the event ID.
Always confirm the action taken with the event title and time.
Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: process.env.TIMEZONE ?? "America/New_York" })}. Today's YYYY-MM-DD: ${new Date().toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE ?? "America/New_York" })}. User timezone: ${process.env.TIMEZONE ?? "America/New_York"}. When setting fireDate for a "once" reminder, always use the YYYY-MM-DD date in the user's timezone above.`;
}

// ─── OpenAI tool definitions for calendar actions ──────────────────────────
const CALENDAR_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Create a new event on the user's Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          title:       { type: "string", description: "Event title/summary" },
          startIso:    { type: "string", description: "Start datetime in ISO 8601 format, e.g. 2026-02-25T14:00" },
          endIso:      { type: "string", description: "End datetime in ISO 8601 format, e.g. 2026-02-25T15:00" },
          location:    { type: "string", description: "Optional location" },
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
          eventId:     { type: "string", description: "Google Calendar event ID" },
          title:       { type: "string", description: "New title (optional)" },
          startIso:    { type: "string", description: "New start datetime ISO 8601 (optional)" },
          endIso:      { type: "string", description: "New end datetime ISO 8601 (optional)" },
          location:    { type: "string", description: "New location (optional)" },
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
      description: "List calendar events between two dates. Use for: 'show this week', 'what's on my calendar', 'events this week/month/tomorrow/next week', or any request to VIEW events for a date range. Always call this for calendar viewing requests. IMPORTANT: startIso must NEVER be before today's date — always use today as the start when the period has already begun (e.g. for 'this week' use today not the start of the week).",
      parameters: {
        type: "object",
        properties: {
          startIso: { type: "string", description: "Start of range in ISO 8601. Must be today or in the future — never use a past date. For 'this week' or 'this month', use today's date as the start." },
          endIso:   { type: "string", description: "End of range in ISO 8601, e.g. 2026-03-02T23:59:59" },
        },
        required: ["startIso", "endIso"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_calendar_events",
      description: "Search for calendar events by title keyword, returns events with their IDs. Use this before update/delete, and ALWAYS use this to answer any question about when/where an event is — never guess. For questions about upcoming events, use daysToSearch=180 or more to look several months ahead.",
      parameters: {
        type: "object",
        properties: {
          query:         { type: "string",  description: "Search keyword (e.g. 'dentist', 'gym', 'Turnstiles')" },
          daysToSearch:  { type: "number",  description: "How many days ahead to search. Default 30, use 180+ for events that may be months away." },
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
          due:   { type: "string", description: "Optional due date in ISO 8601 format (e.g. 2026-03-01T00:00:00.000Z)" },
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
          title:  { type: "string", description: "Task title (for confirmation message)" },
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
          title:  { type: "string", description: "Task title (for confirmation message)" },
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
          query:   { type: "string", description: "Gmail search query, e.g. 'from:john@example.com', 'subject:invoice', 'from:amazon', 'newer_than:1d'" },
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
          query:   { type: "string", description: "Gmail query to select which emails to mark as read. Default: 'is:unread' (all unread). Use 'is:unread newer_than:1d' for today only." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_reminder",
      description: "Create a reminder that fires as a push notification. Use for one-time reminders ('remind me tonight', 'remind me tomorrow at 3pm') and recurring ones ('every Monday at 9am', 'every month on the 15th'). For one-time use frequency='once' with fireDate='YYYY-MM-DD'. For recurring use daily/weekly/monthly/yearly.",
      parameters: {
        type: "object",
        properties: {
          title:      { type: "string",  description: "What to remind the user about, e.g. 'Call dentist'" },
          frequency:  { type: "string",  enum: ["once","daily","weekly","monthly","yearly"], description: "'once' for a one-time reminder on a specific date; 'daily/weekly/monthly/yearly' for recurring" },
          time:       { type: "string",  description: "Time of day in 24-hour HH:MM format, e.g. '21:00'" },
          fireDate:   { type: "string",  description: "REQUIRED for frequency='once': the exact date in YYYY-MM-DD format, e.g. '2026-02-25'" },
          dayOfWeek:  { type: "number",  description: "Day of week for weekly reminders: 0=Sunday, 1=Monday … 6=Saturday" },
          dayOfMonth: { type: "number",  description: "Day of month (1-31) for monthly or yearly reminders" },
          month:      { type: "number",  description: "Month (1-12) for yearly reminders" },
          notes:      { type: "string",  description: "Optional extra context shown in the notification body" },
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
          date:               { type: "string", description: "Date to check in YYYY-MM-DD format" },
          durationMinutes:    { type: "number", description: "How long the slot needs to be, in minutes (e.g. 60)" },
          preferredStartHour: { type: "number", description: "Preferred earliest start hour (0-23, e.g. 9 for 9 AM). Default 8." },
          preferredEndHour:   { type: "number", description: "Preferred latest end hour (0-23, e.g. 18 for 6 PM). Default 18." },
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
  {
    type: "function",
    function: {
      name: "get_aws_cost",
      description: "Retrieve this month's AWS cloud spend: month-to-date total, projected end-of-month cost, yesterday's spend, daily average, and a breakdown by AWS service.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_traffic",
      description: "Get live drive time and traffic conditions between two locations using Google Maps. Use when the user asks about commute time, drive time, traffic, 'how long to get home', 'traffic on the way to work', 'how's my commute', etc. If origin or destination is not specified, use HOME_ADDRESS and WORK_ADDRESS from env.",
      parameters: {
        type: "object",
        properties: {
          origin:      { type: "string", description: "Starting address or location, e.g. '123 Main St, Orlando FL' or 'work'" },
          destination: { type: "string", description: "Destination address or location, e.g. '456 Oak Ave, Orlando FL' or 'home'" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_contact",
      description: "Search Google Contacts by name. Returns phone numbers (as tap-to-call links), email addresses, company, and job title. Use when the user asks for someone's number, phone, contact info, email address, or says 'call X', 'text X', 'find X's number'.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name (or partial name) to search for, e.g. 'John', 'Sarah Smith'" },
          maxResults: { type: "number", description: "Max contacts to return (default 3)" },
        },
        required: ["name"],
      },
    },
  },
];

// ─── Execute a tool call returned by the model ────────────────────────────
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  console.log(`🔧 Tool call: ${name}`, JSON.stringify(args));
  try {
    switch (name) {
      case "create_calendar_event": {
        const result = await createEvent({
          title:       String(args.title),
          startIso:    String(args.startIso),
          endIso:      String(args.endIso),
          location:    args.location ? String(args.location) : undefined,
          description: args.description ? String(args.description) : undefined,
        });
        return JSON.stringify({ success: true, eventId: result.eventId });
      }
      case "update_calendar_event": {
        await updateEvent({
          eventId:     String(args.eventId),
          title:       args.title ? String(args.title) : undefined,
          startIso:    args.startIso ? String(args.startIso) : undefined,
          endIso:      args.endIso ? String(args.endIso) : undefined,
          location:    args.location ? String(args.location) : undefined,
          description: args.description ? String(args.description) : undefined,
        });
        return JSON.stringify({ success: true });
      }
      case "delete_calendar_event": {
        await deleteEvent(String(args.eventId));
        return JSON.stringify({ success: true });
      }
      case "list_calendar_events": {
        const tz = process.env.TIMEZONE ?? "America/New_York";
        const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: tz }) + "T00:00:00";
        // Never return past events — clamp start to today if LLM passed an earlier date
        const rawStart = String(args.startIso);
        const clampedStart = rawStart < todayIso ? todayIso : rawStart;
        const events = await listEventsByRange(clampedStart, String(args.endIso));
        if (events.length === 0) return JSON.stringify({ message: "No events found in that date range." });
        return JSON.stringify(events);
      }
      case "search_calendar_events": {
        const events = await searchEvents(String(args.query), Number(args.daysToSearch ?? 90));
        if (!events || (Array.isArray(events) && events.length === 0)) {
          return JSON.stringify({ message: `No calendar events found matching "${args.query}" in the next ${args.daysToSearch ?? 90} days.` });
        }
        return JSON.stringify(events);
      }
      case "list_tasks": {
        const t = await listTasks(Number(args.maxResults ?? 20));
        return JSON.stringify(t);
      }
      case "create_task": {
        const t = await createTask(String(args.title), {
          notes: args.notes ? String(args.notes) : undefined,
          due:   args.due   ? String(args.due)   : undefined,
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
        if (result.success) return JSON.stringify({ success: true, message: `Digest email sent! (id: ${result.messageId})` });
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
        if (slice.length === 0) return "No unread emails found.";
        // Pre-format as markdown so the AI passes links through unchanged
        const byAccount: Record<string, typeof slice> = {};
        for (const e of slice) { (byAccount[e.account ?? "personal"] ??= []).push(e); }
        const sections = Object.entries(byAccount).map(([acct, list]) => {
          const header = `**${acct.charAt(0).toUpperCase() + acct.slice(1)}** (${list.length} emails)`;
          const lines = list.map(e => {
            const d = e.date ? new Date(e.date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.TIMEZONE || "America/New_York" }) : "";
            const sender = e.from.replace(/<[^>]+>/g, '').trim();
            return `- [${e.subject}](open-email:${e.id}:${e.account ?? "personal"}) — ${sender}${d ? ` (${d})` : ""}`;
          });
          return [header, ...lines].join("\n");
        }).join("\n\n");
        return `${emails.length} unread emails (showing ${slice.length}):\n\n${sections}`;
      }
      case "search_emails": {
        const q = String(args.query);
        const acct = args.account ? String(args.account) : undefined;
        const max = args.maxResults ? Number(args.maxResults) : 5;
        const emails = await searchEmails(q, acct, max);
        if (emails.length === 0) return `No emails found for query: "${q}"`;
        const rows = emails.map(e => {
          const d = e.date ? new Date(e.date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.TIMEZONE || "America/New_York" }) : "";
          const sender = e.from.replace(/<[^>]+>/g, '').trim();
          return `- [${e.subject}](open-email:${e.id}:${e.account}) \u2014 ${sender}${d ? ` (${d})` : ""}`;
        });
        return `Found ${emails.length} email${emails.length === 1 ? "" : "s"}:\n\n${rows.join("\n")}`;
      }
      case "get_llm_usage": {
        const days = args.days ? Number(args.days) : 1;
        if (days <= 1) {
          const usage = getUsageToday();
          return JSON.stringify(usage);
        } else {
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
        const details: string[] = [];
        for (const alias of accounts) {
          try {
            const { marked } = await markEmailsAsRead(alias, query);
            totalMarked += marked;
            details.push(`${alias}: ${marked} marked`);
          } catch (e: any) {
            details.push(`${alias}: failed (${e.message})`);
          }
        }
        return JSON.stringify({ totalMarked, details });
      }
      case "add_reminder": {
        const r = addReminder({
          title:      String(args.title),
          frequency:  String(args.frequency) as any,
          time:       String(args.time),
          fireDate:   args.fireDate ? String(args.fireDate) : undefined,
          dayOfWeek:  args.dayOfWeek !== undefined ? Number(args.dayOfWeek) : undefined,
          dayOfMonth: args.dayOfMonth !== undefined ? Number(args.dayOfMonth) : undefined,
          month:      args.month !== undefined ? Number(args.month) : undefined,
          notes:      args.notes ? String(args.notes) : undefined,
        });
        return JSON.stringify({ ok: true, reminder: r, description: describeReminder(r) });
      }
      case "list_reminders": {
        const reminders = getReminders();
        if (reminders.length === 0) return JSON.stringify({ message: "No reminders set yet." });
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
        const endHour   = Number(args.preferredEndHour ?? 18);
        const tz        = process.env.TIMEZONE ?? "America/New_York";
        const dayStart  = new Date(`${date}T00:00:00`);
        const dayEnd    = new Date(`${date}T23:59:59`);
        const events    = await listEventsByRange(dayStart.toISOString(), dayEnd.toISOString());

        // Build busy blocks from events that have ISO times
        const busy: Array<{ start: number; end: number }> = [];
        for (const ev of events) {
          if (!ev.startIso) continue;
          const s = new Date(ev.startIso).getTime();
          // Use actual endIso if available, otherwise estimate 1hr
          const e = ev.endIso ? new Date(ev.endIso).getTime() : s + 60 * 60_000;
          busy.push({ start: s, end: e });
        }
        busy.sort((a, b) => a.start - b.start);

        // Start cursor at preferredStartHour, but never before now (for today)
        const windowStart = new Date(`${date}T${String(startHour).padStart(2, "0")}:00:00`).getTime();
        const windowEnd   = new Date(`${date}T${String(endHour).padStart(2, "0")}:00:00`).getTime();
        const todayStr    = new Date().toLocaleDateString("en-CA", { timeZone: tz });
        const nowMs       = Date.now();
        // Round now up to next 15-minute boundary for cleaner suggestions
        const nowRounded  = Math.ceil(nowMs / (15 * 60_000)) * (15 * 60_000);
        let cursor = date === todayStr ? Math.max(windowStart, nowRounded) : windowStart;

        // Find gaps between busy blocks
        const freeSlots: Array<{ start: string; end: string }> = [];
        for (const block of busy) {
          if (block.start > cursor && block.start - cursor >= durationMin * 60_000) {
            const slotEnd = Math.min(block.start, cursor + durationMin * 60_000);
            freeSlots.push({
              start: new Date(cursor).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
              end:   new Date(slotEnd).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
            });
          }
          cursor = Math.max(cursor, block.end);
          if (freeSlots.length >= 3) break;
        }
        // Check gap after last event
        if (freeSlots.length < 3 && windowEnd - cursor >= durationMin * 60_000) {
          freeSlots.push({
            start: new Date(cursor).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
            end:   new Date(cursor + durationMin * 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
          });
        }

        if (freeSlots.length === 0) {
          return JSON.stringify({ message: `No free ${durationMin}-minute slots found on ${date} between ${startHour}:00 and ${endHour}:00.` });
        }
        return JSON.stringify({ date, durationMinutes: durationMin, freeSlots });
      }
      case "track_packages": {
        const packages = await getTrackedPackages();
        if (packages.length === 0) return JSON.stringify({ message: "No shipping emails found in recent emails. Either nothing is currently in transit, or orders haven't shipped yet." });
        return JSON.stringify(packages.map(p => ({
          carrier: p.carrier,
          tracking: p.trackingNumber,
          url: p.trackingUrl,
          subject: p.emailSubject,
          from: p.emailFrom,
          date: p.emailDate,
          status: p.arrivingToday ? "arriving/delivered today" : "in transit / coming soon",
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
      case "get_aws_cost": {
        const costData = await getAwsCostSummary();
        return formatAwsCostSummary(costData);
      }
      case "lookup_contact": {
        const name = String(args.name ?? "");
        const max  = args.maxResults ? Number(args.maxResults) : 3;
        const contacts = await searchContacts(name, max);
        return formatContacts(contacts);
      }
      case "get_traffic": {
        const home = process.env.HOME_ADDRESS;
        const work = process.env.WORK_ADDRESS;
        let origin      = args.origin      ? String(args.origin)      : null;
        let destination = args.destination ? String(args.destination) : null;
        // Resolve "home" / "work" keywords
        if (!origin || origin.toLowerCase() === "work")           origin      = work ?? null;
        if (!destination || destination.toLowerCase() === "home") destination = home ?? null;
        if (!origin || !destination) {
          if (!home && !work) return JSON.stringify({ error: "HOME_ADDRESS and WORK_ADDRESS are not set. Please configure them in Settings." });
          if (!origin)      return JSON.stringify({ error: "Could not determine origin. Please specify a starting address." });
          if (!destination) return JSON.stringify({ error: "Could not determine destination. Please specify a destination address." });
        }
        const { getTrafficDuration } = await import("../tools/trafficTools.js");
        const result = await getTrafficDuration(origin!, destination!);
        if (!result) return JSON.stringify({ error: "Traffic data unavailable. Check that GOOGLE_MAPS_API_KEY is set." });
        return JSON.stringify(result);
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Tool [${name}] failed:`, err);
    return JSON.stringify({ error: msg });
  }
}

export function formatBriefingContext(briefing: MorningBriefing): string {
  const calSection =
    briefing.calendar.length > 0
      ? briefing.calendar
          .map((e) => `  • ${e.start}–${e.end}: ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.eventId ? ` [id:${e.eventId}]` : ""}`)
          .join("\n")
      : "  No events today.";

  const importantEmails = briefing.importantEmails.length > 0
    ? `  ${briefing.importantEmails.length} important email(s) flagged. Call list_emails to show them with clickable links.`
    : "  None.";

  const allEmails = briefing.emails.length > 0
    ? `  ${briefing.emails.length} unread email(s). ALWAYS call list_emails tool to display them — never list from this context.`
    : "  No unread emails.";

  const newsSection =
    briefing.news.length > 0
      ? briefing.news
          .map(
            (n) =>
              `  ${n.topic}:\n` +
              (n.articles.length > 0
                ? n.articles.map((a) => `    - ${a.title} (${a.source})`).join("\n")
                : "    No articles found.")
          )
          .join("\n")
      : "  No news loaded.";

  const weatherSection = briefing.weather
    ? `  ${briefing.weather.condition}, ${briefing.weather.temperatureF}°F (feels ${briefing.weather.feelsLikeF}°F), H:${briefing.weather.high}° L:${briefing.weather.low}°, ${briefing.weather.precipChance}% rain chance`
    : "  Not available.";

  const tasksSection =
    briefing.googleTasks.length > 0
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

export async function chatAgent(
  userId: string,
  userMessage: string,
  briefing?: MorningBriefing,
  assistantName = "Assistant",
  tone: AssistantTone = "professional"
): Promise<string> {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId)!;

  const SYSTEM_PROMPT = buildSystemPrompt(assistantName, tone);
  const systemContent = briefing
    ? `${SYSTEM_PROMPT}\n\n${formatBriefingContext(briefing)}`
    : SYSTEM_PROMPT;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemContent },
    ...history.map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
    { role: "user", content: userMessage },
  ];

  const model = process.env.OPENAI_MODEL ?? "grok-3";

  // ── Agentic loop: keep calling until no more tool calls ──────────────────
  let reply = "";
  for (let turn = 0; turn < 5; turn++) {
    const response = await getOpenAI().chat.completions.create({
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
      let directReply: string | null = null;
      for (const toolCall of assistantMsg.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        const result = await executeTool(toolCall.function.name, args);
        // For email list/search, capture result and return directly — never let LLM reformat
        if (toolCall.function.name === "list_emails" || toolCall.function.name === "search_emails") {
          directReply = result;
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
      if (directReply !== null) {
        reply = directReply;
        break; // skip LLM entirely — return pre-formatted markdown with open-email links intact
      }
      continue; // loop again so model can compose final reply
    }

    reply = assistantMsg.content?.trim() ?? "Done.";
    break;
  }

  // Save exchange to history (keep last 20 turns)
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: reply });
  if (history.length > 40) history.splice(0, 2);

  return reply;
}

export function clearHistory(userId: string): void {
  conversationHistory.delete(userId);
}
