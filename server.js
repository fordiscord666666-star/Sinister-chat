const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 8787);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 300);
const ONLINE_WINDOW_MS = Number(process.env.ONLINE_WINDOW_MS || 60000);
const MESSAGE_COOLDOWN_MS = Number(process.env.MESSAGE_COOLDOWN_MS || 1200);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "chat.json");

app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const sessions = new Map();
let messages = [];
let reports = [];
let nextMessageId = 1;

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (Array.isArray(parsed.messages)) messages = parsed.messages.slice(-MAX_MESSAGES);
    if (Array.isArray(parsed.reports)) reports = parsed.reports.slice(-500);
    if (Number.isFinite(parsed.nextMessageId)) nextMessageId = parsed.nextMessageId;
    if (messages.length) {
      const maxId = Math.max(...messages.map(m => Number(m.id) || 0));
      nextMessageId = Math.max(nextMessageId, maxId + 1);
    }
  } catch (err) {
    console.warn("[SINISTER CHAT] Could not load data:", err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const temp = DATA_FILE + ".tmp";
      fs.writeFileSync(
        temp,
        JSON.stringify({ messages, reports, nextMessageId }, null, 2),
        "utf8"
      );
      fs.renameSync(temp, DATA_FILE);
    } catch (err) {
      console.warn("[SINISTER CHAT] Could not save data:", err.message);
    }
  }, 250);
}

function cleanMessage(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function randomCultName() {
  return "Cultist-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function createSession() {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    id,
    token,
    name: randomCultName(),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    lastMessageAt: 0,
  };
  sessions.set(token, session);
  return session;
}

function auth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);

  if (!session) {
    return res.status(401).json({ error: "Invalid or expired chat session." });
  }

  session.lastSeen = Date.now();
  req.session = session;
  next();
}

function onlineCount() {
  const now = Date.now();
  let count = 0;

  for (const session of sessions.values()) {
    if (now - session.lastSeen <= ONLINE_WINDOW_MS) count += 1;
  }

  return count;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now - session.lastSeen > 24 * 60 * 60 * 1000) {
      sessions.delete(token);
    }
  }
}, 5 * 60 * 1000).unref();

loadData();

app.get("/", (req, res) => {
  res.json({
    service: "SINISTER Network",
    ok: true,
    online: onlineCount(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "SINISTER Network" });
});

app.post("/v1/session", (req, res) => {
  const session = createSession();

  res.status(201).json({
    token: session.token,
    user: {
      id: session.id,
      name: session.name,
    },
  });
});

app.post("/v1/heartbeat", auth, (req, res) => {
  req.session.lastSeen = Date.now();
  res.json({ ok: true });
});

app.get("/v1/presence", auth, (req, res) => {
  res.json({
    online: onlineCount(),
    you: {
      id: req.session.id,
      name: req.session.name,
    },
  });
});

app.get("/v1/messages", auth, (req, res) => {
  const after = Math.max(0, Number(req.query.after || 0));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

  const result = messages
    .filter(m => Number(m.id) > after)
    .slice(-limit);

  res.json({ messages: result });
});

app.post("/v1/messages", auth, (req, res) => {
  const now = Date.now();

  if (now - req.session.lastMessageAt < MESSAGE_COOLDOWN_MS) {
    const waitMs = MESSAGE_COOLDOWN_MS - (now - req.session.lastMessageAt);
    return res.status(429).json({
      error: `Slow down for ${Math.ceil(waitMs / 100) / 10}s.`,
    });
  }

  const text = cleanMessage(req.body && req.body.text);

  if (!text) {
    return res.status(400).json({ error: "Message cannot be empty." });
  }

  const message = {
    id: nextMessageId++,
    userId: req.session.id,
    username: req.session.name,
    text,
    createdAt: new Date().toISOString(),
  };

  req.session.lastMessageAt = now;
  req.session.lastSeen = now;

  messages.push(message);
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES);
  }

  scheduleSave();
  res.status(201).json({ ok: true, message });
});

app.post("/v1/report", auth, (req, res) => {
  const messageId = Number(req.body && req.body.messageId);
  const reason = cleanMessage(req.body && req.body.reason).slice(0, 160);

  if (!Number.isFinite(messageId) || messageId <= 0) {
    return res.status(400).json({ error: "Invalid message id." });
  }

  reports.push({
    id: crypto.randomUUID(),
    reporterUserId: req.session.id,
    messageId,
    reason: reason || "No reason provided.",
    createdAt: new Date().toISOString(),
  });

  reports = reports.slice(-500);
  scheduleSave();

  res.status(201).json({ ok: true });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SINISTER CHAT] Listening on port ${PORT}`);
});
