import express from "express";
import session from "express-session";
import FileStore from "session-file-store";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";
import readline from "readline";
import twilio from "twilio";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { coordinatorAgent, buildMorningBriefing, getCachedBriefing, invalidateDashboardCache, patchCacheRemoveEmails, dashboardCacheFetchedAt, startScheduledJobs, rescheduleBriefingJobs, generateAiSuggestions, pushSuggestionsNow } from "./coordinator.js";
import { addNotificationClient, updateUserLocation, addPushSubscription } from "./tools/notificationTools.js";
import { sendDailyDigestEmail } from "./tools/digestEmail.js";
import { completeTask as completeGoogleTask, createTask as createGoogleTask, getTaskLists, listTasks } from "./tools/tasksTools.js";
import { getReminders, addReminder, updateReminder, deleteReminder } from "./tools/remindersTools.js";
import { getTrackedPackages } from "./tools/packageTools.js";
import { fetchEmailBody, markSingleEmailRead } from "./tools/gmailTools.js";
import { getAwsCostSummary, getCostThreshold, setCostThreshold } from "./tools/awsCostTools.js";
import { getVipSenders, setVipSenders, getFilterKeywords, setFilterKeywords } from "./tools/notificationTools.js";
import { getSettingsFromDynamo, saveSettingsToDynamo, isDynamoConfigured } from "./tools/dynamoTools.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();
// ─── CLI mode: run `node dist/index.js --cli` ─────────────────────────────
if (process.argv.includes("--cli")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const userId = "cli-user";
    console.log("🤖 Daily Planner Agent (CLI mode)");
    console.log('   Type "/morning" for your daily briefing, "/clear" to reset, Ctrl+C to quit.\n');
    const ask = () => {
        rl.question("You: ", async (input) => {
            const msg = input.trim();
            if (!msg)
                return ask();
            try {
                const reply = await coordinatorAgent(msg, userId);
                console.log(`\nAssistant: ${reply}\n`);
            }
            catch (err) {
                console.error("Error:", err);
            }
            ask();
        });
    };
    ask();
}
else {
    const app = express();
    app.set('trust proxy', 1); // trust nginx reverse proxy
    app.use(express.json());
    app.use(express.urlencoded({ extended: false })); // needed for Twilio form posts
    // ─── Session & Auth ────────────────────────────────────────────────────
    const APP_PASSWORD = process.env.APP_PASSWORD;
    const SESSION_SECRET = process.env.SESSION_SECRET ?? "change-me-please";
    const SessionFileStore = FileStore(session);
    const sessionsDir = path.resolve("sessions");
    if (!fs.existsSync(sessionsDir))
        fs.mkdirSync(sessionsDir, { recursive: true });
    app.use(session({
        store: new SessionFileStore({ path: sessionsDir, ttl: 30 * 24 * 60 * 60, retries: 1, logFn: () => { } }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
            httpOnly: true,
            sameSite: 'lax',
            secure: 'auto', // secure on HTTPS (nip.io), not on plain HTTP
        }
    }));
    // ─── Token store: fallback for mobile browsers that drop cookies on HTTP IPs ─
    const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const TOKEN_FILE = path.join(__dirname, '..', '.tokens.json');
    const validTokens = new Map(); // token → expiry timestamp
    // Persist tokens across restarts so mobile sessions survive PM2 restarts
    (function loadTokens() {
        try {
            const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
            const obj = JSON.parse(raw);
            const now = Date.now();
            for (const [t, exp] of Object.entries(obj)) {
                if (exp > now)
                    validTokens.set(t, exp);
            }
        }
        catch { }
    })();
    function saveTokens() {
        try {
            const obj = {};
            validTokens.forEach((exp, t) => { obj[t] = exp; });
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj));
        }
        catch { }
    }
    function issueToken() {
        const tok = crypto.randomBytes(32).toString('hex');
        validTokens.set(tok, Date.now() + TOKEN_TTL_MS);
        saveTokens();
        return tok;
    }
    function checkToken(tok) {
        if (!tok)
            return false;
        const exp = validTokens.get(tok);
        if (!exp || Date.now() > exp) {
            if (tok)
                validTokens.delete(tok);
            return false;
        }
        return true;
    }
    // Login page
    app.get("/login", (_req, res) => {
        res.send(`<!DOCTYPE html><html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Login – Daily Planner</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f1117;color:#e1e4e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 28px;width:100%;max-width:340px;}
    h1{font-size:20px;margin-bottom:24px;text-align:center;}  
    input{width:100%;background:#21262d;border:1px solid #30363d;border-radius:8px;
      color:#e1e4e8;padding:12px 14px;font-size:16px;outline:none;margin-bottom:16px;}
    input:focus{border-color:#1f6feb;}
    button{width:100%;background:#1f6feb;color:#fff;border:none;border-radius:8px;
      padding:12px;font-size:15px;font-weight:600;cursor:pointer;}
    .err{color:#f85149;font-size:13px;margin-bottom:12px;text-align:center;}
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 Daily Planner</h1>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"/>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body></html>`);
    });
    app.post("/login", (req, res) => {
        const { password } = req.body;
        if (!APP_PASSWORD || password === APP_PASSWORD) {
            req.session.authenticated = true;
            const tok = issueToken();
            // Use absolute URL so HTTPS proxy domains redirect correctly
            const proto = req.headers['x-forwarded-proto'] || req.protocol;
            const host = req.headers['x-forwarded-host'] || req.headers.host || '';
            const base = `${proto}://${host}`;
            // Detect mobile — send to index.html (mobile chat view), desktop to dashboard.html
            const ua = req.headers['user-agent'] || '';
            const isMobile = /Mobile|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(ua);
            const dest = isMobile ? `${base}/?tok=${tok}` : `${base}/dashboard.html?tok=${tok}`;
            return req.session.save(() => res.redirect(303, dest));
        }
        res.send(`<!DOCTYPE html><html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Login – Daily Planner</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f1117;color:#e1e4e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 28px;width:100%;max-width:340px;}
    h1{font-size:20px;margin-bottom:24px;text-align:center;}
    input{width:100%;background:#21262d;border:1px solid #30363d;border-radius:8px;
      color:#e1e4e8;padding:12px 14px;font-size:16px;outline:none;margin-bottom:16px;}
    input:focus{border-color:#1f6feb;}
    button{width:100%;background:#1f6feb;color:#fff;border:none;border-radius:8px;
      padding:12px;font-size:15px;font-weight:600;cursor:pointer;}
    .err{color:#f85149;font-size:13px;margin-bottom:12px;text-align:center;}
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 Daily Planner</h1>
    <p class="err">❌ Incorrect password</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"/>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body></html>`);
    });
    app.get("/logout", (req, res) => {
        req.session.destroy(() => res.redirect("/login"));
    });
    // Auth guard — skip for Twilio webhooks and health check
    const OPEN_PATHS = new Set(["/login", "/health", "/webhook", "/whatsapp", "/voice/incoming", "/voice/respond", "/vapid-public-key", "/api/briefing", "/api/calendar", "/api/suggestions", "/api/suggestions/push"]);
    app.use((req, res, next) => {
        if (!APP_PASSWORD)
            return next();
        if (OPEN_PATHS.has(req.path))
            return next();
        if (req.session.authenticated)
            return next();
        // Token fallback: check X-Auth-Token header or tok query param
        const headerTok = req.headers['x-auth-token'];
        const queryTok = req.query['tok'];
        if (checkToken(headerTok) || checkToken(queryTok)) {
            req.session.authenticated = true; // re-hydrate cookie session
            return next();
        }
        const isApiCall = req.xhr || (req.headers.accept ?? "").includes("application/json") || req.path.startsWith("/voice-chat") || req.path.startsWith("/send-digest") || req.path.startsWith("/notifications") || req.path.startsWith("/api/");
        if (isApiCall)
            return res.status(401).json({ error: "Session expired. Please log in again.", redirect: "/login" });
        return res.redirect("/login");
    });
    // Serve the web UI (after auth guard)
    const publicDir = path.join(__dirname, "..", "public");
    app.get("/dashboard", (_req, res) => {
        res.sendFile(path.join(publicDir, "dashboard.html"));
    });
    app.use(express.static(publicDir));
    // Multer: kept for potential future use
    const upload = multer({ dest: "/tmp/" });
    const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
    const AUTHORIZED_CHAT_ID = process.env.TELEGRAM_AUTHORIZED_CHAT_ID;
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const AUTHORIZED_WHATSAPP_NUMBER = process.env.AUTHORIZED_WHATSAPP_NUMBER; // e.g. whatsapp:+15551234567
    // ─── Telegram webhook ──────────────────────────────────────────────────
    app.post("/webhook", async (req, res) => {
        try {
            const message = req.body.message;
            if (!message)
                return res.sendStatus(200);
            const chatId = String(message.chat?.id ?? "");
            const text = message.text ?? "";
            if (!text)
                return res.sendStatus(200);
            if (AUTHORIZED_CHAT_ID && chatId !== AUTHORIZED_CHAT_ID) {
                console.warn(`Unauthorized Telegram access from chat ${chatId}`);
                return res.sendStatus(403);
            }
            const reply = await coordinatorAgent(text, `telegram-${chatId}`);
            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: "HTML" }),
            });
        }
        catch (err) {
            console.error("Telegram webhook error:", err);
        }
        res.sendStatus(200);
    });
    // ─── WhatsApp webhook (Twilio) ─────────────────────────────────────────
    // Twilio sends a POST with form-encoded body: Body, From, To, etc.
    app.post("/whatsapp", async (req, res) => {
        try {
            // Validate the request is genuinely from Twilio
            if (TWILIO_AUTH_TOKEN) {
                const twilioSig = req.headers["x-twilio-signature"];
                const url = `${process.env.PUBLIC_URL}/whatsapp`;
                const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSig, url, req.body);
                if (!isValid) {
                    console.warn("Invalid Twilio signature on /whatsapp");
                    return res.sendStatus(403);
                }
            }
            const from = req.body.From ?? ""; // e.g. "whatsapp:+15551234567"
            const text = req.body.Body ?? "";
            if (!text)
                return res.sendStatus(200);
            // Optional: restrict to your own WhatsApp number
            if (AUTHORIZED_WHATSAPP_NUMBER && from !== AUTHORIZED_WHATSAPP_NUMBER) {
                console.warn(`Unauthorized WhatsApp message from ${from}`);
                return res.sendStatus(403);
            }
            const userId = `whatsapp-${from}`;
            const reply = await coordinatorAgent(text, userId, runtimeAssistantName, runtimeTone);
            // Respond with TwiML
            const twiml = new twilio.twiml.MessagingResponse();
            twiml.message(reply);
            res.type("text/xml").send(twiml.toString());
        }
        catch (err) {
            console.error("WhatsApp webhook error:", err);
            res.sendStatus(500);
        }
    });
    // ─── Voice webhook (Twilio) ────────────────────────────────────────────
    // Flow: Twilio calls POST /voice/incoming → we return TwiML to gather speech
    //       Twilio POSTs transcription to /voice/respond → we reply with TTS
    app.post("/voice/incoming", (_req, res) => {
        // Prompt Twilio to record speech and transcribe it
        const twiml = new twilio.twiml.VoiceResponse();
        const gather = twiml.gather({
            input: ["speech"],
            action: "/voice/respond",
            method: "POST",
            speechTimeout: "auto",
            language: "en-US",
        });
        gather.say({ voice: "Polly.Joanna" }, "Hi! I'm your daily planning assistant. What can I help you with?");
        // Fallback if no speech detected
        twiml.say({ voice: "Polly.Joanna" }, "I didn't catch that. Please try again.");
        twiml.redirect("/voice/incoming");
        res.type("text/xml").send(twiml.toString());
    });
    app.post("/voice/respond", async (req, res) => {
        try {
            const speechResult = req.body.SpeechResult ?? "";
            const callerId = req.body.From ?? "voice-user";
            const userId = `voice-${callerId}`;
            const twiml = new twilio.twiml.VoiceResponse();
            if (!speechResult.trim()) {
                twiml.say({ voice: "Polly.Joanna" }, "Sorry, I didn't catch that.");
                twiml.redirect("/voice/incoming");
                return res.type("text/xml").send(twiml.toString());
            }
            console.log(`Voice [${callerId}]: ${speechResult}`);
            const reply = await coordinatorAgent(speechResult, userId, runtimeAssistantName, runtimeTone);
            // Speak the response, then offer another turn
            twiml.say({ voice: "Polly.Joanna" }, reply);
            const gather = twiml.gather({
                input: ["speech"],
                action: "/voice/respond",
                method: "POST",
                speechTimeout: "auto",
                language: "en-US",
            });
            gather.say({ voice: "Polly.Joanna" }, "Is there anything else?");
            twiml.hangup();
            res.type("text/xml").send(twiml.toString());
        }
        catch (err) {
            console.error("Voice webhook error:", err);
            const twiml = new twilio.twiml.VoiceResponse();
            twiml.say("Sorry, something went wrong. Please try again.");
            res.type("text/xml").send(twiml.toString());
        }
    });
    // ─── Web voice chat: STT → agent → response ───────────────────────────
    // Accepts either:
    //   multipart/form-data with field "audio" (webm/ogg/wav) — mic recording
    //   application/json with { text, userId }                — text message
    app.post("/voice-chat", upload.single("audio"), async (req, res) => {
        const userId = req.body?.userId || "web-user";
        // ── text path ──────────────────────────────────────────────────────
        const bodyText = req.body?.text;
        if (bodyText) {
            try {
                const reply = await coordinatorAgent(bodyText.trim(), userId, runtimeAssistantName, runtimeTone);
                return res.json({ transcript: bodyText.trim(), reply });
            }
            catch (err) {
                console.error("Voice-chat (text) error:", err);
                return res.status(500).json({ error: "Processing failed", details: String(err) });
            }
        }
        // ── audio path: STT is handled in the browser (Web Speech API) ──────
        // If audio blob is sent anyway, reject cleanly
        return res.status(400).json({ error: "Audio upload not supported. Use browser Web Speech API for STT." });
    });
    // ─── TTS: handled by browser speechSynthesis (no server needed) ────────
    app.post("/tts", (_req, res) => {
        res.status(501).json({ message: "TTS is handled client-side via Web Speech API" });
    });
    // ─── SSE: real-time push notifications ────────────────────────────────────
    app.get("/notifications", (req, res) => {
        addNotificationClient(res);
        // When client disconnects, res "close" event cleans it up inside addNotificationClient
    });
    // ─── GPS location update from mobile client ──────────────────────────
    app.post("/update-location", (req, res) => {
        const { lat, lng } = req.body;
        if (typeof lat === "number" && typeof lng === "number") {
            updateUserLocation(lat, lng);
            res.json({ ok: true });
        }
        else {
            res.status(400).json({ ok: false, error: "lat and lng required" });
        }
    });
    // ─── Send digest email on demand ──────────────────────────────────────
    app.post("/send-digest", async (_req, res) => {
        try {
            const briefing = await buildMorningBriefing();
            const result = await sendDailyDigestEmail(briefing);
            if (result.success) {
                res.json({ ok: true, messageId: result.messageId });
            }
            else {
                res.status(500).json({ ok: false, error: result.error });
            }
        }
        catch (err) {
            res.status(500).json({ ok: false, error: String(err) });
        }
    });
    // ─── Settings: persist to settings.json so they survive restarts ──────────
    const SETTINGS_FILE = path.resolve("settings.json");
    function loadPersistedSettings() {
        try {
            if (fs.existsSync(SETTINGS_FILE)) {
                return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
            }
        }
        catch { /* ignore parse errors */ }
        return {};
    }
    function savePersistedSettings(s) {
        // Always write local file as backup
        try {
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
        }
        catch (e) {
            console.error("Failed to save settings.json:", e);
        }
        // Also write to DynamoDB if configured (async — don't block response)
        if (isDynamoConfigured()) {
            saveSettingsToDynamo(s).catch(e => console.error("DynamoDB saveSettings failed:", e));
        }
    }
    // Apply persisted settings on startup — prefer DynamoDB, fall back to file
    async function initSettings() {
        if (isDynamoConfigured()) {
            const dynamo = await getSettingsFromDynamo().catch(() => null);
            if (dynamo && Object.keys(dynamo).length > 0) {
                console.log("⚙️  Settings loaded from DynamoDB");
                // Keep local file in sync
                try {
                    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(dynamo, null, 2));
                }
                catch { }
                return dynamo;
            }
        }
        return loadPersistedSettings();
    }
    // Runtime settings — populated by initSettings() before server starts listening
    let runtimeNewsTopics = (process.env.NEWS_TOPICS ?? "Artificial Intelligence,AWS Cloud,Florida real estate market")
        .split(",").map(t => t.trim()).filter(Boolean);
    let runtimeAssistantName = process.env.ASSISTANT_NAME ?? "Assistant";
    let runtimeTone = "professional";
    function applySettings(s) {
        if (s.newsTopics?.length)
            runtimeNewsTopics = s.newsTopics;
        if (s.assistantName)
            runtimeAssistantName = s.assistantName;
        if (s.tone)
            runtimeTone = s.tone;
        if (s.vipSenders)
            setVipSenders(s.vipSenders);
        if (s.filterKeywords)
            setFilterKeywords(s.filterKeywords);
        if (s.awsCostThreshold)
            setCostThreshold(s.awsCostThreshold);
        if (s.morningBriefingTime)
            process.env.MORNING_BRIEFING_TIME = s.morningBriefingTime;
        if (s.eveningBriefingTime)
            process.env.EVENING_BRIEFING_TIME = s.eveningBriefingTime;
    }
    app.get("/api/settings", (_req, res) => {
        res.json({
            newsTopics: runtimeNewsTopics,
            assistantName: runtimeAssistantName,
            tone: runtimeTone,
            timezone: process.env.TIMEZONE ?? "America/New_York",
            digestEmail: process.env.DIGEST_EMAIL_TO ?? "",
            accounts: [
                process.env.GMAIL_ACCOUNT_1_ALIAS ?? "personal",
                process.env.GMAIL_ACCOUNT_2_ALIAS ?? "work",
            ],
            morningBriefingTime: process.env.MORNING_BRIEFING_TIME ?? "07:00",
            eveningBriefingTime: process.env.EVENING_BRIEFING_TIME ?? "17:00",
            vipSenders: getVipSenders(),
            filterKeywords: getFilterKeywords(),
            awsCostThreshold: getCostThreshold(),
        });
    });
    app.post("/api/settings", (req, res) => {
        const { newsTopics, morningBriefingTime, eveningBriefingTime, vipSenders, filterKeywords, awsCostThreshold, assistantName, tone } = req.body;
        if (typeof assistantName === "string" && assistantName.trim()) {
            runtimeAssistantName = assistantName.trim();
        }
        const VALID_TONES = ["professional", "friendly", "casual", "coach", "witty"];
        if (typeof tone === "string" && VALID_TONES.includes(tone)) {
            runtimeTone = tone;
        }
        if (Array.isArray(newsTopics)) {
            runtimeNewsTopics = newsTopics.map((t) => t.trim()).filter(Boolean);
            process.env.NEWS_TOPICS = runtimeNewsTopics.join(",");
        }
        if (Array.isArray(vipSenders)) {
            setVipSenders(vipSenders.map((s) => s.trim().toLowerCase()).filter(Boolean));
        }
        if (Array.isArray(filterKeywords)) {
            setFilterKeywords(filterKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
        }
        if (typeof awsCostThreshold === "number" && awsCostThreshold > 0) {
            setCostThreshold(awsCostThreshold);
        }
        let rescheduled = false;
        if (morningBriefingTime && /^\d{1,2}:\d{2}$/.test(morningBriefingTime)) {
            process.env.MORNING_BRIEFING_TIME = morningBriefingTime;
            rescheduled = true;
        }
        if (eveningBriefingTime && /^\d{1,2}:\d{2}$/.test(eveningBriefingTime)) {
            process.env.EVENING_BRIEFING_TIME = eveningBriefingTime;
            rescheduled = true;
        }
        if (rescheduled)
            rescheduleBriefingJobs();
        // Persist everything to disk so it survives restarts
        savePersistedSettings({
            newsTopics: runtimeNewsTopics,
            assistantName: runtimeAssistantName,
            tone: runtimeTone,
            morningBriefingTime: process.env.MORNING_BRIEFING_TIME ?? "07:00",
            eveningBriefingTime: process.env.EVENING_BRIEFING_TIME ?? "17:00",
            vipSenders: getVipSenders(),
            filterKeywords: getFilterKeywords(),
            awsCostThreshold: getCostThreshold(),
        });
        invalidateDashboardCache();
        res.json({
            ok: true,
            newsTopics: runtimeNewsTopics,
            morningBriefingTime: process.env.MORNING_BRIEFING_TIME ?? "07:00",
            eveningBriefingTime: process.env.EVENING_BRIEFING_TIME ?? "17:00",
            vipSenders: getVipSenders(),
            filterKeywords: getFilterKeywords(),
            awsCostThreshold: getCostThreshold(),
        });
    });
    // ─── Agent Memory API ──────────────────────────────────────────────────
    app.get("/api/memory", async (_req, res) => {
        try {
            const { getMemoryFacts } = await import("./tools/dynamoTools.js");
            const facts = await getMemoryFacts();
            res.json({ facts, configured: isDynamoConfigured() });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.post("/api/memory", async (req, res) => {
        const { facts } = req.body;
        if (!Array.isArray(facts))
            return res.status(400).json({ error: "facts must be an array of strings" });
        try {
            const { appendMemoryFacts } = await import("./tools/dynamoTools.js");
            const merged = await appendMemoryFacts(facts.map((f) => f.trim()).filter(Boolean));
            res.json({ ok: true, facts: merged });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.delete("/api/memory", async (_req, res) => {
        try {
            const { clearMemoryFacts } = await import("./tools/dynamoTools.js");
            await clearMemoryFacts();
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.delete("/api/memory/:index", async (req, res) => {
        const idx = parseInt(req.params.index);
        if (isNaN(idx))
            return res.status(400).json({ error: "Invalid index" });
        try {
            const { removeMemoryFacts } = await import("./tools/dynamoTools.js");
            const remaining = await removeMemoryFacts([idx]);
            res.json({ ok: true, facts: remaining });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // ─── Live briefing JSON for dashboard widgets ──────────────────────────
    app.get("/api/briefing", async (req, res) => {
        const t0 = Date.now();
        try {
            const force = req.query?.refresh === "1";
            if (force)
                invalidateDashboardCache();
            const briefing = await getCachedBriefing();
            // Attach the fetchedAt timestamp from the cache for the "last updated" indicator
            const fetchedAt = dashboardCacheFetchedAt();
            const elapsed = Date.now() - t0;
            if (elapsed > 500)
                console.log(`⏱ /api/briefing took ${elapsed}ms (force=${force})`);
            res.json({ ...briefing, _fetchedAt: fetchedAt });
        }
        catch (err) {
            console.error(`❌ /api/briefing error after ${Date.now() - t0}ms:`, err);
            res.status(500).json({ error: String(err) });
        }
    });
    // ─── AI-powered suggestions ───────────────────────────────────────────
    app.get("/api/suggestions", async (_req, res) => {
        try {
            const briefing = await getCachedBriefing();
            const suggestions = await generateAiSuggestions(briefing);
            res.json({ suggestions });
        }
        catch (err) {
            console.error("❌ /api/suggestions error:", err);
            res.status(500).json({ suggestions: [], error: String(err) });
        }
    });
    // ─── Manual trigger: push suggestion notification now ──────────────────
    app.post("/api/suggestions/push", async (_req, res) => {
        try {
            const suggestions = await pushSuggestionsNow();
            res.json({ ok: true, suggestions });
        }
        catch (err) {
            console.error("❌ /api/suggestions/push error:", err);
            res.status(500).json({ ok: false, error: String(err) });
        }
    });
    // ─── Calendar events (for sidebar badge counts) ────────────────────────
    app.get("/api/calendar", async (req, res) => {
        try {
            const days = Math.min(Number(req.query?.days ?? 1), 30);
            const { getCalendarEvents } = await import("./tools/calendarTools.js");
            const events = await getCalendarEvents(days);
            res.json({ events });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // ─── Direct task actions (bypasses AI for instant response) ────────────
    app.post("/api/complete-task", async (req, res) => {
        const { taskId, listId } = req.body;
        if (!taskId || !listId)
            return res.status(400).json({ error: "taskId and listId are required" });
        try {
            await completeGoogleTask(taskId, listId);
            invalidateDashboardCache();
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.get("/api/task-lists", async (_req, res) => {
        try {
            const lists = await getTaskLists();
            res.json({ lists });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.get("/api/tasks", async (_req, res) => {
        try {
            const tasks = await listTasks(50);
            res.json({ tasks });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.post("/api/create-task", async (req, res) => {
        const { title, notes, due, listId } = req.body;
        if (!title)
            return res.status(400).json({ error: "title is required" });
        try {
            const task = await createGoogleTask(title, { notes, due, listId });
            invalidateDashboardCache();
            res.json({ ok: true, task });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // ─── Recurring Reminders CRUD ────────────────────────────────────────────────────
    app.get("/api/reminders", (_req, res) => {
        res.json({ reminders: getReminders() });
    });
    app.post("/api/reminders", (req, res) => {
        const { title, frequency, time, dayOfWeek, dayOfMonth, month, notes } = req.body;
        if (!title || !frequency || !time)
            return res.status(400).json({ error: "title, frequency, and time are required" });
        const reminder = addReminder({ title, frequency, time, dayOfWeek, dayOfMonth, month, notes });
        res.json({ ok: true, reminder });
    });
    app.patch("/api/reminders/:id", (req, res) => {
        const updated = updateReminder(req.params.id, req.body);
        if (!updated)
            return res.status(404).json({ error: "Reminder not found" });
        res.json({ ok: true, reminder: updated });
    });
    app.delete("/api/reminders/:id", (req, res) => {
        const ok = deleteReminder(req.params.id);
        if (!ok)
            return res.status(404).json({ error: "Reminder not found" });
        res.json({ ok: true });
    });
    // ─── Full email body ───────────────────────────────────────────────────────────
    app.get("/api/email/:account/:id", async (req, res) => {
        try {
            const { account, id } = req.params;
            const body = await fetchEmailBody(id, account);
            res.json(body);
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.post("/api/email/:account/:id/read", async (req, res) => {
        try {
            const { account, id } = req.params;
            await markSingleEmailRead(account, id);
            patchCacheRemoveEmails([id]);
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // ─── Package tracking ─────────────────────────────────────────────────────────
    app.get("/api/packages", async (req, res) => {
        try {
            const daysBack = Math.min(Number(req.query?.daysBack ?? 7), 30);
            // For short lookbacks, try to reuse briefing cache emails; for longer ones always do a fresh shipping search
            const packages = await getTrackedPackages(undefined, daysBack);
            res.json({ packages, daysBack });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // ─── AWS Cost Explorer ───────────────────────────────────────────────────────
    // Simple 1-hour in-memory cache to limit Cost Explorer API calls ($0.01/1000)
    let awsCostCache = null;
    const AWS_COST_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
    app.get("/api/aws-cost", async (req, res) => {
        const forceRefresh = req.query.refresh === "1";
        if (!forceRefresh && awsCostCache && Date.now() - awsCostCache.fetchedAt < AWS_COST_CACHE_TTL_MS) {
            return res.json({ ...awsCostCache.data, threshold: getCostThreshold(), cached: true });
        }
        try {
            const costData = await getAwsCostSummary();
            awsCostCache = { data: costData, fetchedAt: Date.now() };
            res.json({ ...costData, cached: false });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isIam = msg.includes("AccessDenied") || msg.includes("is not authorized");
            res.status(isIam ? 403 : 500).json({
                error: msg,
                ...(isIam && {
                    hint: "Add ce:GetCostAndUsage and ce:GetCostForecast to the EC2 instance role. Also ensure Cost Explorer is enabled in AWS Console → Billing → Cost Explorer.",
                }),
            });
        }
    });
    // ─── Health check ────────────────────────────────────────────────────────────
    app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
    // ─── Web Push: VAPID public key + subscription endpoint ────────────────────
    app.get("/vapid-public-key", (_req, res) => {
        const key = process.env.VAPID_PUBLIC_KEY;
        if (!key)
            return res.status(503).json({ error: "Push notifications not configured" });
        res.json({ key });
    });
    app.post("/push-subscribe", (req, res) => {
        const sub = req.body;
        if (!sub?.endpoint)
            return res.status(400).json({ error: "Invalid subscription" });
        addPushSubscription(sub);
        res.json({ ok: true });
    });
    const PORT = Number(process.env.PORT ?? 3000);
    // Load settings from DynamoDB (or fall back to file) before starting
    initSettings().then(saved => {
        applySettings(saved);
        app.listen(PORT, () => {
            console.log(`🤖 Daily Planner Agent running on port ${PORT}`);
            console.log(`   Web UI           → http://localhost:${PORT}`);
            console.log(`   Voice API        → POST /voice-chat`);
            console.log(`   Notifications    → GET  /notifications  (SSE)`);
            console.log(`   Digest Email     → POST /send-digest`);
            console.log(`   Telegram         → POST /webhook`);
            console.log(`   WhatsApp         → POST /whatsapp  (Twilio)`);
            console.log(`   Voice            → POST /voice/incoming  (Twilio)`);
            console.log(`   Health           → GET  /health`);
            console.log(`   DynamoDB         → ${isDynamoConfigured() ? process.env.DYNAMO_TABLE : "not configured (using settings.json)"}`);
            // Start cron jobs and notification polling
            startScheduledJobs();
        });
    });
}
