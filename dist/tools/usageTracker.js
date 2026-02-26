/**
 * usageTracker.ts
 * Persists daily LLM token usage to a JSON file on disk.
 * File: data/usage.json  (relative to cwd, i.e. /home/ec2-user/daily-planner-agent/data/usage.json)
 *
 * Grok pricing (as of 2025):
 *   grok-3          $3.00 / 1M input tokens   $15.00 / 1M output tokens
 *   grok-3-mini     $0.30 / 1M input tokens   $0.50 / 1M output tokens
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve to project root / data / usage.json
const DATA_DIR = path.resolve(__dirname, "../../data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
// Pricing per 1M tokens
const PRICING = {
    "grok-3": { input: 3.00, output: 15.00 },
    "grok-3-mini": { input: 0.30, output: 0.50 },
};
const DEFAULT_PRICING = { input: 3.00, output: 15.00 };
function todayStr() {
    return new Date().toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE ?? "America/New_York" });
}
function loadFile() {
    try {
        if (!fs.existsSync(DATA_DIR))
            fs.mkdirSync(DATA_DIR, { recursive: true });
        if (!fs.existsSync(USAGE_FILE))
            return { days: [] };
        const raw = fs.readFileSync(USAGE_FILE, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return { days: [] };
    }
}
function saveFile(data) {
    try {
        if (!fs.existsSync(DATA_DIR))
            fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
    }
    catch (err) {
        console.error("usageTracker: failed to save usage file:", err);
    }
}
/** Record token usage from a single API response */
export function recordUsage(usage, model = "grok-3") {
    if (!usage)
        return;
    const pricing = PRICING[model] ?? DEFAULT_PRICING;
    const cost = (usage.prompt_tokens / 1_000_000) * pricing.input +
        (usage.completion_tokens / 1_000_000) * pricing.output;
    const data = loadFile();
    const today = todayStr();
    let day = data.days.find((d) => d.date === today);
    if (!day) {
        day = { date: today, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, estimatedCostUSD: 0 };
        data.days.push(day);
    }
    day.promptTokens += usage.prompt_tokens;
    day.completionTokens += usage.completion_tokens;
    day.totalTokens += usage.total_tokens;
    day.calls += 1;
    day.estimatedCostUSD += cost;
    // Keep last 30 days
    if (data.days.length > 30) {
        data.days.sort((a, b) => a.date.localeCompare(b.date));
        data.days.splice(0, data.days.length - 30);
    }
    saveFile(data);
}
/** Get today's usage summary */
export function getUsageToday() {
    const data = loadFile();
    const today = todayStr();
    const day = data.days.find((d) => d.date === today);
    return day ?? {
        date: today,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        calls: 0,
        estimatedCostUSD: 0,
    };
}
/** Get usage for the last N days */
export function getUsageHistory(days = 7) {
    const data = loadFile();
    return data.days
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, days);
}
