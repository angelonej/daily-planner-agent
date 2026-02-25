export interface CalendarEvent {
  start: string;       // formatted display string e.g. "9:00 AM"
  end: string;
  startIso?: string;   // raw ISO datetime e.g. "2026-02-25T09:00:00-05:00" for traffic/timing
  endIso?: string;     // raw ISO end datetime
  title: string;
  location?: string;
  description?: string;
  eventId?: string;  // Google Calendar event ID, needed for edits/deletes
}

export interface Task {
  name: string;
  priority: number;
  estimatedMinutes: number;
}

export interface WeatherData {
  location: string;
  temperatureF: number;
  feelsLikeF: number;
  humidity: number;
  windSpeedMph: number;
  condition: string;
  conditionCode: number;
  precipitationInch: number;
  isDay: boolean;
  high: number;
  low: number;
  precipChance: number;
  uvIndex: number;
  sunrise: string;
  sunset: string;
  hourly: Array<{
    time: string;
    tempF: number;
    precipChance: number;
    condition: string;
  }>;
}

export interface GoogleTask {
  id: string;
  title: string;
  status: "needsAction" | "completed";
  due?: string;
  notes?: string;
  listId: string;
  listTitle: string;
}

export interface ScheduleBlock {
  start: string;
  end: string;
  title: string;
}

export interface Email {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
  account: string;       // which Gmail account this came from
  isImportant: boolean;
  labels: string[];
  isHighlighted?: boolean;   // matched a filter keyword or highlight sender
  isVip?: boolean;            // sender is in VIP list
}

export interface PackageInfo {
  trackingNumber: string;
  carrier: "UPS" | "FedEx" | "USPS" | "Amazon" | "Unknown";
  trackingUrl: string;
  emailSubject: string;
  emailFrom: string;
  emailDate: string;
  arrivingToday?: boolean;  // true when email strongly suggests delivery today
}

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  description: string;
}

export interface NewsResult {
  topic: string;
  articles: NewsArticle[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ─── Notifications ─────────────────────────────────────────────────────────
export interface NotificationAlert {
  id: string;
  type: "event_soon" | "event_starting" | "digest_ready" | "important_email" | "task_reminder" | "vip_email" | "aws_cost_alert";
  title: string;
  body: string;
  eventId?: string;
  timestamp: string;
}

// ─── Recurring Suggestions ─────────────────────────────────────────────────
export interface RecurringSuggestion {
  title: string;                  // Inferred event name / pattern
  dayOfWeek: string;              // e.g. "Monday"
  typicalStart: string;           // e.g. "09:00"
  typicalEnd: string;             // e.g. "10:00"
  occurrences: number;            // How many times seen in lookback window
  confidence: "high" | "medium" | "low";
  suggestedRule: string;          // Human-readable: "Weekly on Monday at 9am"
}

export interface LlmUsage {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCostUSD: number;
}

export interface MorningBriefing {
  calendar: CalendarEvent[];
  emails: Email[];
  importantEmails: Email[];
  news: NewsResult[];
  weather?: WeatherData;
  googleTasks: GoogleTask[];
  llmUsage?: LlmUsage;
  generatedAt: string;
  suggestions?: string[];
  packages?: PackageInfo[];
}
