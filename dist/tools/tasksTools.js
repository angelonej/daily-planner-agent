/**
 * Google Tasks API v1
 * Uses the same OAuth2 tokens as Gmail/Calendar (personal account).
 * Scopes needed: https://www.googleapis.com/auth/tasks
 * Re-run `npm run auth -- personal` after updating scopes.
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";
function buildTasksAuth() {
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    // Use personal account token for tasks
    const alias = process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal";
    const tokenPath = path.resolve("tokens", `${alias}.token.json`);
    if (!fs.existsSync(tokenPath)) {
        throw new Error(`Tasks token not found at ${tokenPath}. Run: npm run auth -- ${alias}`);
    }
    const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    auth.setCredentials(tokens);
    // Auto-save refreshed tokens
    auth.on("tokens", (newTokens) => {
        const existing = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
        const merged = { ...existing, ...newTokens };
        fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    });
    return auth;
}
// ─── Task list cache (10 minutes) ───────────────────────────────────────────
let taskListCache = null;
const TASK_LIST_CACHE_TTL = 10 * 60 * 1000;
/** Get all task lists (cached for 10 minutes) */
export async function getTaskLists() {
    const now = Date.now();
    if (taskListCache && now - taskListCache.fetchedAt < TASK_LIST_CACHE_TTL) {
        return taskListCache.lists;
    }
    const auth = buildTasksAuth();
    const tasks = google.tasks({ version: "v1", auth });
    const res = await tasks.tasklists.list({ maxResults: 20 });
    const lists = (res.data.items ?? []).map((l) => ({
        id: l.id,
        title: l.title ?? "Untitled",
    }));
    taskListCache = { lists, fetchedAt: Date.now() };
    return lists;
}
/** List incomplete tasks (optionally from a specific list, defaults to all lists) */
export async function listTasks(maxResults = 20, listId) {
    const auth = buildTasksAuth();
    const tasks = google.tasks({ version: "v1", auth });
    let listsToFetch;
    if (listId) {
        listsToFetch = [{ id: listId, title: "" }];
    }
    else {
        const allLists = await getTaskLists();
        listsToFetch = allLists;
    }
    const allTasks = [];
    for (const list of listsToFetch) {
        const res = await tasks.tasks.list({
            tasklist: list.id,
            showCompleted: false,
            showHidden: false,
            maxResults,
        });
        for (const t of res.data.items ?? []) {
            allTasks.push({
                id: t.id,
                title: t.title ?? "(no title)",
                status: t.status ?? "needsAction",
                due: t.due ?? undefined,
                notes: t.notes ?? undefined,
                completed: t.completed ?? undefined,
                listId: list.id,
                listTitle: list.title,
            });
        }
    }
    return allTasks;
}
/** Create a new task */
export async function createTask(title, options = {}) {
    const auth = buildTasksAuth();
    const tasks = google.tasks({ version: "v1", auth });
    // Default to first task list if none specified
    let taskListId = options.listId;
    if (!taskListId) {
        const lists = await getTaskLists();
        taskListId = lists[0]?.id ?? "@default";
    }
    const res = await tasks.tasks.insert({
        tasklist: taskListId,
        requestBody: {
            title,
            notes: options.notes,
            due: options.due, // Must be RFC 3339 with time at midnight: "2026-03-01T00:00:00.000Z"
        },
    });
    const t = res.data;
    return {
        id: t.id,
        title: t.title ?? title,
        status: "needsAction",
        due: t.due ?? undefined,
        notes: t.notes ?? undefined,
        listId: taskListId,
        listTitle: "",
    };
}
/** Mark a task as completed */
export async function completeTask(taskId, listId) {
    const auth = buildTasksAuth();
    const tasks = google.tasks({ version: "v1", auth });
    await tasks.tasks.update({
        tasklist: listId,
        task: taskId,
        requestBody: {
            id: taskId,
            status: "completed",
        },
    });
}
/** Delete a task */
export async function deleteTask(taskId, listId) {
    const auth = buildTasksAuth();
    const tasks = google.tasks({ version: "v1", auth });
    await tasks.tasks.delete({ tasklist: listId, task: taskId });
}
/** Find tasks by title keyword */
export async function findTasksByTitle(query) {
    const all = await listTasks(100);
    const q = query.toLowerCase();
    return all.filter((t) => t.title.toLowerCase().includes(q));
}
