const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 8787);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 300);
const MAX_DIRECT_MESSAGES = Number(process.env.MAX_DIRECT_MESSAGES || 500);
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
let directMessages = [];
let notifications = [];
let reports = [];
let nextMessageId = 1;
let nextDirectMessageId = 1;
let nextNotificationId = 1;

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (Array.isArray(parsed.messages)) {
      messages = parsed.messages.slice(-MAX_MESSAGES);
    }

    if (Array.isArray(parsed.reports)) {
      reports = parsed.reports.slice(-500);
    }

    if (Number.isFinite(parsed.nextMessageId)) {
      nextMessageId = parsed.nextMessageId;
    }

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

      // Direct messages are intentionally not written to disk.
      fs.writeFileSync(
        temp,
        JSON.stringify({
          messages,
          reports,
          nextMessageId,
        }, null, 2),
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

// Server-side racial / ethnic slur censor.
// Keeping this on the backend means modified SINISTER clients still
// receive censored chat from your server.
const SLUR_RULES = [
  {
    pattern: /\bn[\W_]*[i1!|][\W_]*[gq9][\W_]*[gq9][\W_]*[e3][\W_]*r\b/gi,
    replacement: "******",
  },
  {
    pattern: /\bn[\W_]*[i1!|][\W_]*[gq9][\W_]*[gq9][\W_]*[a4@]\b/gi,
    replacement: "******",
  },
  {
    pattern: /\bk[\W_]*[i1!|][\W_]*k[\W_]*[e3]\b/gi,
    replacement: "****",
  },
  {
    pattern: /\bc[\W_]*h[\W_]*[i1!|][\W_]*n[\W_]*k\b/gi,
    replacement: "*****",
  },
  {
    pattern: /\bs[\W_]*p[\W_]*[i1!|][\W_]*c\b/gi,
    replacement: "****",
  },
  {
    pattern: /\bw[\W_]*[e3][\W_]*t[\W_]*b[\W_]*[a4@][\W_]*c[\W_]*k\b/gi,
    replacement: "*******",
  },
];

function censorSlurs(value) {
  let text = cleanMessage(value);

  for (const rule of SLUR_RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }

  return text;
}

function cleanName(value, maxLength = 32) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanRobloxUserId(value) {
  const id = String(value || "").replace(/\D/g, "").slice(0, 20);
  return id || "0";
}

async function resolveRobloxProfile(body) {
  const robloxUserId = cleanRobloxUserId(body && body.robloxUserId);
  const fallbackUsername =
    cleanName(body && body.robloxUsername, 20) || "Unknown";
  const fallbackDisplayName =
    cleanName(body && body.displayName, 50) || fallbackUsername;

  if (robloxUserId === "0") {
    return {
      robloxUserId,
      username: fallbackUsername,
      displayName: fallbackDisplayName,
      verifiedProfile: false,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(
      `https://users.roblox.com/v1/users/${robloxUserId}`,
      {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      }
    );

    clearTimeout(timer);

    if (response.ok) {
      const profile = await response.json();

      return {
        robloxUserId,
        username: cleanName(profile.name, 20) || fallbackUsername,
        displayName:
          cleanName(profile.displayName, 50)
          || cleanName(profile.name, 20)
          || fallbackDisplayName,
        verifiedProfile: true,
      };
    }
  } catch (err) {
    console.warn(
      "[SINISTER CHAT] Roblox profile lookup failed:",
      err.message
    );
  }

  return {
    robloxUserId,
    username: fallbackUsername,
    displayName: fallbackDisplayName,
    verifiedProfile: false,
  };
}

function publicUser(session) {
  return {
    id: session.id,
    robloxUserId: session.robloxUserId,
    username: session.username,
    displayName: session.displayName,
    verifiedProfile: Boolean(session.verifiedProfile),
  };
}

function activeSessions() {
  const now = Date.now();

  return Array
    .from(sessions.values())
    .filter(session => now - session.lastSeen <= ONLINE_WINDOW_MS);
}

function uniqueActiveSessions() {
  const sorted = activeSessions()
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const seen = new Set();
  const result = [];

  for (const session of sorted) {
    const key =
      session.robloxUserId && session.robloxUserId !== "0"
      ? `roblox:${session.robloxUserId}`
      : `session:${session.id}`;

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(session);
  }

  return result;
}

async function createSession(body) {
  const profile = await resolveRobloxProfile(body || {});
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");

  const session = {
    id,
    token,
    robloxUserId: profile.robloxUserId,
    username: profile.username,
    displayName: profile.displayName,
    verifiedProfile: profile.verifiedProfile,
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
    return res.status(401).json({
      error: "Invalid or expired chat session.",
    });
  }

  session.lastSeen = Date.now();
  req.session = session;
  next();
}

function onlineCount() {
  return uniqueActiveSessions().length;
}

function findActiveSessionById(id) {
  const now = Date.now();

  for (const session of sessions.values()) {
    if (
      session.id === id
      && now - session.lastSeen <= ONLINE_WINDOW_MS
    ) {
      return session;
    }
  }

  return null;
}

function enforceCooldown(session, res) {
  const now = Date.now();

  if (now - session.lastMessageAt < MESSAGE_COOLDOWN_MS) {
    const waitMs =
      MESSAGE_COOLDOWN_MS - (now - session.lastMessageAt);

    res.status(429).json({
      error: `Slow down for ${Math.ceil(waitMs / 100) / 10}s.`,
    });

    return false;
  }

  session.lastMessageAt = now;
  session.lastSeen = now;
  return true;
}

function cleanMentionValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function textMentionsUser(text, session) {
  const haystack = cleanMentionValue(text);
  if (!haystack) return false;

  const username =
    cleanMentionValue(session && session.username);

  const displayName =
    cleanMentionValue(session && session.displayName);

  const candidates = [];

  if (username) {
    candidates.push(username);
    candidates.push("@" + username);
  }

  if (displayName) {
    candidates.push(displayName);
    candidates.push("@" + displayName);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;

    const index = haystack.indexOf(candidate);
    if (index < 0) continue;

    const before =
      index <= 0 ? "" : haystack.charAt(index - 1);

    const afterIndex = index + candidate.length;
    const after =
      afterIndex >= haystack.length
      ? ""
      : haystack.charAt(afterIndex);

    const isWord = ch => /[a-z0-9_]/i.test(ch);

    if (
      (!before || !isWord(before))
      && (!after || !isWord(after))
    ) {
      return true;
    }
  }

  return false;
}

function pushNotification(recipientSessionId, type, sender, text, sourceMessageId) {
  if (!recipientSessionId || !sender) return;

  notifications.push({
    id: nextNotificationId++,
    recipientSessionId,
    type,
    senderId: sender.id,
    robloxUserId: sender.robloxUserId,
    username: sender.username,
    displayName: sender.displayName,
    text: cleanMessage(text),
    sourceMessageId: Number(sourceMessageId || 0),
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  });

  if (notifications.length > 1200) {
    notifications = notifications.slice(-1200);
  }
}

setInterval(() => {
  const now = Date.now();

  for (const [token, session] of sessions.entries()) {
    if (now - session.lastSeen > 24 * 60 * 60 * 1000) {
      sessions.delete(token);
    }
  }

  directMessages = directMessages.filter(message => {
    return now - Number(message.createdAtMs || now)
      <= 24 * 60 * 60 * 1000;
  });

  notifications = notifications.filter(event => {
    return now - Number(event.createdAtMs || now)
      <= 24 * 60 * 60 * 1000;
  });
}, 5 * 60 * 1000).unref();

loadData();

app.get("/", (req, res) => {
  res.json({
    service: "SINISTER Network V4",
    ok: true,
    online: onlineCount(),
    features: [
      "global-chat",
      "roblox-names",
      "online-users",
      "private-dm",
      "message-notifications",
      "mention-notifications",
      "racial-slur-filter",
    ],
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "SINISTER Network V4",
  });
});

app.post("/v1/session", async (req, res) => {
  try {
    const session = await createSession(req.body || {});

    res.status(201).json({
      token: session.token,
      user: publicUser(session),
    });
  } catch (err) {
    console.error("[SINISTER CHAT] Session error:", err);

    res.status(500).json({
      error: "Could not create chat session.",
    });
  }
});

app.post("/v1/heartbeat", auth, (req, res) => {
  req.session.lastSeen = Date.now();
  res.json({ ok: true });
});

app.get("/v1/presence", auth, (req, res) => {
  res.json({
    online: onlineCount(),
    you: publicUser(req.session),
  });
});

app.get("/v1/users", auth, (req, res) => {
  const users = uniqueActiveSessions()
    .map(publicUser)
    .sort((a, b) => {
      const an = String(a.displayName || a.username || "").toLowerCase();
      const bn = String(b.displayName || b.username || "").toLowerCase();
      return an.localeCompare(bn);
    });

  res.json({ users });
});

app.get("/v1/notifications", auth, (req, res) => {
  const after = Math.max(0, Number(req.query.after || 0));
  const limit = Math.min(
    100,
    Math.max(1, Number(req.query.limit || 40))
  );

  const result = notifications
    .filter(event => {
      return event.recipientSessionId === req.session.id
        && Number(event.id) > after;
    })
    .slice(-limit);

  res.json({ notifications: result });
});

app.get("/v1/messages", auth, (req, res) => {
  const after = Math.max(0, Number(req.query.after || 0));
  const limit = Math.min(
    100,
    Math.max(1, Number(req.query.limit || 50))
  );

  const result = messages
    .filter(message => Number(message.id) > after)
    .slice(-limit);

  res.json({ messages: result });
});

app.post("/v1/messages", auth, (req, res) => {
  if (!enforceCooldown(req.session, res)) return;

  const text = censorSlurs(req.body && req.body.text);

  if (!text) {
    return res.status(400).json({
      error: "Message cannot be empty.",
    });
  }

  const message = {
    id: nextMessageId++,
    userId: req.session.id,
    senderId: req.session.id,
    robloxUserId: req.session.robloxUserId,
    username: req.session.username,
    displayName: req.session.displayName,
    text,
    createdAt: new Date().toISOString(),
  };

  messages.push(message);

  for (const other of uniqueActiveSessions()) {
    if (other.id === req.session.id) continue;

    if (textMentionsUser(text, other)) {
      pushNotification(
        other.id,
        "mention",
        req.session,
        text,
        message.id
      );
    }
  }

  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES);
  }

  scheduleSave();

  res.status(201).json({
    ok: true,
    message,
  });
});

app.get("/v1/dm", auth, (req, res) => {
  const otherId = cleanName(req.query.with, 80);
  const after = Math.max(0, Number(req.query.after || 0));
  const limit = Math.min(
    100,
    Math.max(1, Number(req.query.limit || 50))
  );

  if (!otherId) {
    return res.status(400).json({
      error: "Choose a user first.",
    });
  }

  const mine = req.session.id;

  const result = directMessages
    .filter(message => {
      const pair =
        (
          message.senderId === mine
          && message.recipientId === otherId
        )
        || (
          message.senderId === otherId
          && message.recipientId === mine
        );

      return pair && Number(message.id) > after;
    })
    .slice(-limit);

  res.json({ messages: result });
});

app.post("/v1/dm", auth, (req, res) => {
  if (!enforceCooldown(req.session, res)) return;

  const recipientId =
    cleanName(req.body && req.body.recipientId, 80);

  const text = censorSlurs(req.body && req.body.text);

  if (!recipientId) {
    return res.status(400).json({
      error: "Choose somebody to message.",
    });
  }

  if (recipientId === req.session.id) {
    return res.status(400).json({
      error: "You cannot private-message yourself.",
    });
  }

  if (!text) {
    return res.status(400).json({
      error: "Message cannot be empty.",
    });
  }

  const recipient =
    findActiveSessionById(recipientId);

  if (!recipient) {
    return res.status(404).json({
      error: "That user is no longer online.",
    });
  }

  const message = {
    id: nextDirectMessageId++,
    senderId: req.session.id,
    recipientId: recipient.id,
    senderRobloxUserId: req.session.robloxUserId,
    recipientRobloxUserId: recipient.robloxUserId,
    username: req.session.username,
    displayName: req.session.displayName,
    recipientUsername: recipient.username,
    recipientDisplayName: recipient.displayName,
    text,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  };

  directMessages.push(message);

  pushNotification(
    recipient.id,
    "dm",
    req.session,
    text,
    message.id
  );

  if (directMessages.length > MAX_DIRECT_MESSAGES) {
    directMessages =
      directMessages.slice(-MAX_DIRECT_MESSAGES);
  }

  // DMs are intentionally kept in memory only.
  res.status(201).json({
    ok: true,
    message,
  });
});

app.post("/v1/report", auth, (req, res) => {
  const messageId = Number(req.body && req.body.messageId);
  const reason =
    cleanMessage(req.body && req.body.reason).slice(0, 160);

  if (!Number.isFinite(messageId) || messageId <= 0) {
    return res.status(400).json({
      error: "Invalid message id.",
    });
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
  console.log(
    `[SINISTER CHAT V4] Listening on port ${PORT}`
  );
});
