import OpenAI from "openai";
import { ChatMessage, MorningBriefing } from "../types.js";
import { fetchAllAccountEmails, searchEmails } from "../tools/gmailTools.js";
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

const openai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

// In-memory conversation history per user (keyed by chat/user ID)
const conversationHistory = new Map<string, ChatMessage[]>();

const SYSTEM_PROMPT = `You are a sharp, concise personal assistant AI. You help the user manage their day.
You have access to their morning briefing (calendar events, emails, news) and can CREATE, UPDATE, and DELETE calendar events.
When answering questions, reference their actual data when relevant.
Keep responses brief and actionable. Use bullet points for lists.
If asked to summarize emails or news, use the briefing data provided.
When the user asks to add, create, schedule, move, reschedule, cancel, or delete a calendar event, use the appropriate calendar tool.
When the user asks about recurring events, patterns, or regular meetings, use suggest_recurring_events.
When the user asks to send the daily digest, morning summary, or briefing email, use send_digest_email.
When the user asks about weather (today, tomorrow, this week, will it rain, forecast, etc.), ALWAYS call get_weather with the appropriate number of days.
When the user asks to check emails, show today's emails, list unread emails, or get recent emails, ALWAYS call list_emails.
When the user asks for the last email from someone, emails about a topic, or to search emails, ALWAYS call search_emails with the appropriate Gmail query.
For ambiguous requests (e.g. 'move my dentist'), use search_calendar_events first to find the event ID.
Always confirm the action taken with the event title and time.
Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

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
      description: "List calendar events between two dates. Use for: 'show this week', 'what's on my calendar', 'events this week/month/tomorrow/next week', or any request to VIEW events for a date range. Always call this for calendar viewing requests.",
      parameters: {
        type: "object",
        properties: {
          startIso: { type: "string", description: "Start of range in ISO 8601, e.g. 2026-02-24T00:00:00" },
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
      description: "Search for calendar events by title keyword, returns events with their IDs. Use this before update/delete.",
      parameters: {
        type: "object",
        properties: {
          query:         { type: "string",  description: "Search keyword (e.g. 'dentist', 'gym', 'AWS')" },
          daysToSearch:  { type: "number",  description: "How many days ahead to search (default 14)" },
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
        return JSON.stringify({ success: true, eventId: result.eventId, link: result.link });
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
        const events = await listEventsByRange(String(args.startIso), String(args.endIso));
        if (events.length === 0) return JSON.stringify({ message: "No events found in that date range." });
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
        if (slice.length === 0) return JSON.stringify({ message: "No unread emails found." });
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
        if (emails.length === 0) return JSON.stringify({ message: `No emails found for query: "${q}"` });
        return JSON.stringify(emails.map((e) => ({
          subject: e.subject,
          from: e.from,
          date: e.date,
          snippet: e.snippet,
          account: e.account,
          isImportant: e.isImportant,
        })));
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

  const importantEmails =
    briefing.importantEmails.length > 0
      ? briefing.importantEmails.map((e) => `  ⚠️ [${e.account}] ${e.subject} — from ${e.from}`).join("\n")
      : "  None.";

  const allEmails =
    briefing.emails.length > 0
      ? briefing.emails.slice(0, 10).map((e) => `  • [${e.account}] ${e.subject} — from ${e.from}`).join("\n")
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
  briefing?: MorningBriefing
): Promise<string> {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId)!;

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
    const response = await openai.chat.completions.create({
      model,
      messages,
      tools: CALENDAR_TOOLS,
      tool_choice: "auto",
      max_tokens: 1200,
      temperature: 0.3,
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    console.log(`🤖 Grok finish_reason: ${choice.finish_reason}, tool_calls: ${assistantMsg.tool_calls?.length ?? 0}`);
    messages.push(assistantMsg);

    if (choice.finish_reason === "tool_calls" && assistantMsg.tool_calls) {
      // Execute each tool call and feed results back
      for (const toolCall of assistantMsg.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
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
  if (history.length > 40) history.splice(0, 2);

  return reply;
}

export function clearHistory(userId: string): void {
  conversationHistory.delete(userId);
}
