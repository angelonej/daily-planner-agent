/**
 * remindersTools.ts
 *
 * User-defined recurring reminders stored in data/reminders.json.
 *
 * Supported frequencies:
 *   daily          — fires every day at HH:MM
 *   weekly         — fires every week on dayOfWeek at HH:MM
 *   monthly        — fires every month on dayOfMonth (1-31) at HH:MM
 *   yearly         — fires every year on month/day at HH:MM
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
const DATA_FILE = path.resolve("data", "reminders.json");
function load() {
    try {
        if (!fs.existsSync(DATA_FILE))
            return [];
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    }
    catch {
        return [];
    }
}
function save(reminders) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(reminders, null, 2), "utf-8");
}
export function getReminders() {
    return load();
}
export function addReminder(input) {
    const reminders = load();
    const reminder = {
        ...input,
        id: randomUUID(),
        active: true,
        createdAt: new Date().toISOString(),
    };
    reminders.push(reminder);
    save(reminders);
    return reminder;
}
export function updateReminder(id, changes) {
    const reminders = load();
    const idx = reminders.findIndex(r => r.id === id);
    if (idx === -1)
        return null;
    reminders[idx] = { ...reminders[idx], ...changes };
    save(reminders);
    return reminders[idx];
}
export function deleteReminder(id) {
    const reminders = load();
    const filtered = reminders.filter(r => r.id !== id);
    if (filtered.length === reminders.length)
        return false;
    save(filtered);
    return true;
}
export function markFired(id, date) {
    const reminders = load();
    const r = reminders.find(x => x.id === id);
    const changes = { lastFiredDate: date };
    if (r?.frequency === "once")
        changes.active = false;
    updateReminder(id, changes);
}
// ─── Check which reminders should fire right now ───────────────────────────
export function getDueReminders(tz) {
    const reminders = load().filter(r => r.active);
    if (reminders.length === 0)
        return [];
    const now = new Date();
    // Current time components in user's timezone
    const tzNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const nowHour = tzNow.getHours();
    const nowMin = tzNow.getMinutes();
    const nowDay = tzNow.getDay(); // 0=Sun
    const nowDate = tzNow.getDate(); // 1-31
    const nowMonth = tzNow.getMonth() + 1; // 1-12
    const todayStr = `${tzNow.getFullYear()}-${String(nowMonth).padStart(2, "0")}-${String(nowDate).padStart(2, "0")}`;
    const due = [];
    for (const r of reminders) {
        // Don't fire twice on the same day
        if (r.lastFiredDate === todayStr)
            continue;
        const [rH, rM] = r.time.split(":").map(Number);
        // Must be within the current minute window
        if (nowHour !== rH || nowMin !== rM)
            continue;
        let matches = false;
        switch (r.frequency) {
            case "once":
                matches = r.fireDate === todayStr;
                break;
            case "daily":
                matches = true;
                break;
            case "weekly":
                matches = r.dayOfWeek === nowDay;
                break;
            case "monthly":
                matches = r.dayOfMonth === nowDate;
                break;
            case "yearly":
                matches = r.month === nowMonth && r.dayOfMonth === nowDate;
                break;
        }
        if (matches)
            due.push(r);
    }
    return due;
}
// ─── Human-readable schedule description ──────────────────────────────────
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function describeReminder(r) {
    const t = r.time;
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const timeStr = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
    switch (r.frequency) {
        case "once": return `Once on ${r.fireDate} at ${timeStr}`;
        case "daily": return `Every day at ${timeStr}`;
        case "weekly": return `Every ${DAY_NAMES[r.dayOfWeek ?? 0]} at ${timeStr}`;
        case "monthly": return `Every month on the ${ordinal(r.dayOfMonth ?? 1)} at ${timeStr}`;
        case "yearly": return `Every year on ${MONTH_NAMES[r.month ?? 1]} ${r.dayOfMonth} at ${timeStr}`;
    }
}
function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
