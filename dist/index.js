import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import dotenv from "dotenv";
import readline from "readline";
import twilio from "twilio";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { coordinatorAgent, buildMorningBriefing, startScheduledJobs } from "./coordinator.js";
import { addNotificationClient } from "./tools/notificationTools.js";
import { sendDailyDigestEmail } from "./tools/digestEmail.js";
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
    app.use(express.json());
    app.use(express.urlencoded({ extended: false })); // needed for Twilio form posts
    // ─── Session & Auth ────────────────────────────────────────────────────
    const APP_PASSWORD = process.env.APP_PASSWORD;
    const SESSION_SECRET = process.env.SESSION_SECRET ?? "change-me-please";
    app.use(session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax" }
    }));
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
            return req.session.save(() => res.redirect("/"));
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
    const OPEN_PATHS = new Set(["/login", "/health", "/webhook", "/whatsapp", "/voice/incoming", "/voice/respond"]);
    app.use((req, res, next) => {
        if (!APP_PASSWORD)
            return next(); // no password set = open
        if (OPEN_PATHS.has(req.path))
            return next(); // public endpoints
        if (req.session.authenticated)
            return next(); // logged in
        // API / fetch calls → return 401 JSON so the client can handle it gracefully
        const isApiCall = req.xhr || (req.headers.accept ?? "").includes("application/json") || req.path.startsWith("/voice-chat") || req.path.startsWith("/send-digest") || req.path.startsWith("/notifications");
        if (isApiCall)
            return res.status(401).json({ error: "Session expired. Please log in again.", redirect: "/login" });
        return res.redirect("/login");
    });
    // Serve the web UI (after auth guard)
    const publicDir = path.join(__dirname, "..", "public");
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
            const reply = await coordinatorAgent(text, userId);
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
            const reply = await coordinatorAgent(speechResult, userId);
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
                const reply = await coordinatorAgent(bodyText.trim(), userId);
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
    // ─── SSE: real-time push notifications ────────────────────────────────
    app.get("/notifications", (req, res) => {
        addNotificationClient(res);
        // When client disconnects, res "close" event cleans it up inside addNotificationClient
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
    // ─── Health check ──────────────────────────────────────────────────────
    app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
    const PORT = Number(process.env.PORT ?? 3000);
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
        // Start cron jobs and notification polling
        startScheduledJobs();
    });
}
