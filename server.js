// WhatsApp AI agent (WhatsApp Cloud API + Claude)
// Receives messages through Meta's webhook, asks Claude, and replies.
// Requirements: Node.js 18+ (uses built-in fetch). No external dependencies.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Load the .env file ----------
// Format: NAME=value, one per line; lines starting with # are comments.
// The .env file takes priority over system environment variables; if a name repeats, the last line wins.
(function loadEnvFile() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) {
    const others = fs.readdirSync(__dirname).filter((f) => /env/i.test(f) && f !== ".env.example");
    console.warn(`[config] ${file} not found.` + (others.length ? ` Similar files in this folder: ${others.join(", ")}` : ""));
    return;
  }
  const seenKeys = new Set();
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (seenKeys.has(m[1])) console.warn(`[config] ${m[1]} appears more than once in .env; using the last line.`);
    else if (process.env[m[1]] !== undefined && process.env[m[1]] !== value) {
      console.warn(`[config] ${m[1]} is also set as a system variable; using the value from .env.`);
    }
    seenKeys.add(m[1]);
    process.env[m[1]] = value;
  }
  console.log(`[config] Loaded ${file} (${seenKeys.size} variables)`);
})();

// ---------- Configuration ----------
const allowedRaw = (process.env.ALLOWED_NUMBERS || "").split(",").map((n) => n.trim());
const allowAll = allowedRaw.includes("*");

const cfg = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "127.0.0.1", // only accept local connections (the tunnel connects here)
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,      // secret word you choose (webhook verification)
  appSecret: process.env.META_APP_SECRET,              // Meta app secret (verifies request signatures)
  waToken: process.env.WHATSAPP_TOKEN,                 // permanent system user token
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, // phone number ID (API Setup)
  graphVersion: process.env.GRAPH_API_VERSION || "v23.0",
  graphBase: process.env.GRAPH_API_BASE || "https://graph.facebook.com",
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  anthropicBase: process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com",
  model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  maxTokens: Number(process.env.CLAUDE_MAX_TOKENS || 1024),
  allowAll,
  allowed: allowedRaw.map((n) => n.replace(/[^\d]/g, "")).filter(Boolean),
  // Max replies per number per day (0 = no limit). Default: 50 with ALLOWED_NUMBERS=*, otherwise no limit.
  dailyLimit: Number(process.env.MAX_MESSAGES_PER_DAY ?? (allowAll ? 50 : 0)),
  historySize: Number(process.env.HISTORY_SIZE || 12),
};

const required = ["verifyToken", "appSecret", "waToken", "phoneNumberId", "anthropicKey"];
const missing = required.filter((k) => !cfg[k]);
if (missing.length) {
  console.error(`[config] Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
if (!cfg.allowAll && !cfg.allowed.length) {
  console.warn("[config] ALLOWED_NUMBERS is empty: the agent will not reply to anyone.");
}

const systemPrompt = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8");

// Fixed messages sent to users (the AI's own replies follow the user's language).
const TEXT = {
  limit: process.env.MSG_LIMIT || "You've reached today's message limit. Please try again tomorrow.",
  mediaError: process.env.MSG_MEDIA_ERROR || "I couldn't open that file. Could you try sending it again?",
  aiError: process.env.MSG_AI_ERROR || "I'm having a technical problem right now. Please try again in a moment.",
  empty: process.env.MSG_EMPTY || "Sorry, I couldn't come up with a reply. Could you rephrase?",
};

// ---------- In-memory state (pilot) ----------
// Lost on restart. For production, replace with a database.
const seen = new Map();      // message id -> timestamp (prevents duplicate replies)
const history = new Map();   // number -> [{role, content}]
const queues = new Map();    // number -> Promise (one message at a time per person)
const usage = new Map();     // number -> { day, count, warned } (daily limit)

function overDailyLimit(user) {
  if (!cfg.dailyLimit) return false;
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(user);
  if (!u || u.day !== day) { usage.set(user, { day, count: 1, warned: false }); return false; }
  u.count++;
  return u.count > cfg.dailyLimit;
}

function alreadySeen(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 24 * 3600 * 1000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

function pushHistory(user, entry) {
  const h = history.get(user) || [];
  h.push(entry);
  while (h.length > cfg.historySize) h.shift();
  // The conversation must start with a user message.
  while (h.length && h[0].role !== "user") h.shift();
  history.set(user, h);
}

// ---------- WhatsApp Cloud API ----------
const graph = (p) => `${cfg.graphBase}/${cfg.graphVersion}/${p}`;
const authHeader = () => ({ Authorization: `Bearer ${cfg.waToken}` });

async function waPost(body) {
  const res = await fetch(graph(`${cfg.phoneNumberId}/messages`), {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (txt.includes("131030")) {
      console.warn(
        `[meta] Meta refused to send to ${body.to}: the app is in development mode and this number ` +
        `is not in the "To" list in API Setup. Add it there or switch the app to Live.`
      );
    }
    throw new Error(`WhatsApp ${res.status}: ${txt}`);
  }
  return res.json();
}

async function markRead(messageId) {
  try {
    await waPost({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  } catch {
    // The typing indicator is optional; if it fails, just mark as read.
    try { await waPost({ status: "read", message_id: messageId }); } catch {}
  }
}

async function sendText(to, text, replyTo) {
  const body = text.length > 4000 ? text.slice(0, 3990) + "…" : text;
  return waPost({
    to,
    type: "text",
    text: { body, preview_url: false },
    ...(replyTo ? { context: { message_id: replyTo } } : {}),
  });
}

async function downloadMedia(mediaId) {
  const meta = await fetch(graph(mediaId), { headers: authHeader() });
  if (!meta.ok) throw new Error(`Media info ${meta.status}: ${await meta.text()}`);
  const { url, mime_type } = await meta.json();
  const file = await fetch(url, { headers: authHeader() });
  if (!file.ok) throw new Error(`Media download ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  return { data: buf.toString("base64"), mime: (mime_type || "").split(";")[0], size: buf.length };
}

// ---------- Claude ----------
async function askClaude(messages) {
  const res = await fetch(`${cfg.anthropicBase}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const out = await res.json();
  return out.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Turns a WhatsApp message into the content Claude receives.
async function toClaudeContent(msg) {
  const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  switch (msg.type) {
    case "text":
      return [{ type: "text", text: msg.text.body }];
    case "image": {
      const m = await downloadMedia(msg.image.id);
      if (!IMAGE_TYPES.includes(m.mime)) return [{ type: "text", text: "[Image in an unsupported format]" }];
      return [
        { type: "image", source: { type: "base64", media_type: m.mime, data: m.data } },
        { type: "text", text: msg.image.caption || "[The user sent this photo without a caption.]" },
      ];
    }
    case "document": {
      const m = await downloadMedia(msg.document.id);
      const caption = msg.document.caption || `[The user sent this document without a caption: ${msg.document.filename || "untitled"}]`;
      if (m.mime === "application/pdf") {
        return [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: m.data } },
          { type: "text", text: caption },
        ];
      }
      if (IMAGE_TYPES.includes(m.mime)) {
        return [
          { type: "image", source: { type: "base64", media_type: m.mime, data: m.data } },
          { type: "text", text: caption },
        ];
      }
      return [{ type: "text", text: `[The user sent a document (${msg.document.filename || "untitled"}, ${m.mime}) in an unsupported format. Ask for a photo or a PDF instead.]` }];
    }
    case "location":
      return [{ type: "text", text: `[Location shared: ${msg.location.latitude}, ${msg.location.longitude}${msg.location.name ? " – " + msg.location.name : ""}]` }];
    case "audio":
      return [{ type: "text", text: "[The user sent a voice note. You can't listen to audio yet: kindly ask them to type their message.]" }];
    case "interactive":
      return [{ type: "text", text: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[interactive reply]" }];
    case "button":
      return [{ type: "text", text: msg.button?.text || "[button]" }];
    default:
      return [{ type: "text", text: `[Unsupported message type "${msg.type}". Reply that you can only read text, photos and PDFs.]` }];
  }
}

// Only text is kept in history; images and PDFs are large and only sent with the current message.
function historyText(content) {
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[photo]" : "[PDF document]"))
    .join(" ");
}

async function handleMessage(msg, contactName) {
  const from = msg.from; // international format, without "+"
  if (!cfg.allowAll && !cfg.allowed.includes(from)) {
    console.log(`[ignored] message from unauthorized number +${from} (add ${from} to ALLOWED_NUMBERS in .env and restart)`);
    return;
  }
  if (overDailyLimit(from)) {
    const u = usage.get(from);
    console.warn(`[limit] +${from} passed the limit of ${cfg.dailyLimit} messages today; message ignored.`);
    if (!u.warned) {
      u.warned = true;
      await sendText(from, TEXT.limit, msg.id);
    }
    return;
  }
  await markRead(msg.id);

  let content;
  try {
    content = await toClaudeContent(msg);
  } catch (e) {
    console.error("[media]", e.message);
    await sendText(from, TEXT.mediaError, msg.id);
    return;
  }

  const prefix = contactName ? `[${contactName}] ` : "";
  const prior = history.get(from) || [];
  const current = { role: "user", content: [{ type: "text", text: prefix }, ...content].filter((b) => b.type !== "text" || b.text) };

  let reply;
  try {
    reply = await askClaude([...prior, current]);
  } catch (e) {
    console.error("[claude]", e.message);
    await sendText(from, TEXT.aiError, msg.id);
    return;
  }
  if (!reply) reply = TEXT.empty;

  await sendText(from, reply, msg.id);
  pushHistory(from, { role: "user", content: prefix + historyText(content) });
  pushHistory(from, { role: "assistant", content: reply });
  console.log(`[ok] replied to ${from} (${msg.type})`);
}

function enqueue(user, task) {
  const prev = queues.get(user) || Promise.resolve();
  const next = prev.then(task).catch((e) => console.error("[error]", e.message));
  queues.set(user, next);
  next.finally(() => { if (queues.get(user) === next) queues.delete(user); });
}

// ---------- HTTP server ----------
function send(res, status, body = "", type = "text/plain") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validSignature(raw, header) {
  const sig = header || "";
  const expected = "sha256=" + crypto.createHmac("sha256", cfg.appSecret).update(raw).digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function processPayload(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const pnid = value.metadata?.phone_number_id;
      const msgs = value.messages || [];
      const statuses = value.statuses || [];
      console.log(
        `[webhook] field=${change.field} number=${value.metadata?.display_phone_number || "?"} ` +
        `phone_number_id=${pnid || "?"} messages=${msgs.length} statuses=${statuses.length}`
      );
      if (pnid && pnid !== cfg.phoneNumberId) {
        console.warn(
          `[ignored] message for phone_number_id ${pnid}, but .env has WHATSAPP_PHONE_NUMBER_ID=${cfg.phoneNumberId}. ` +
          `Fix .env if this is the number you want to use.`
        );
        continue;
      }
      for (const s of statuses) {
        if (s.status === "failed") console.warn(`[status] delivery failed to ${s.recipient_id}: ${JSON.stringify(s.errors || [])}`);
      }
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of msgs) {
        if (alreadySeen(msg.id)) { console.log(`[ignored] duplicate message ${msg.id}`); continue; }
        console.log(`[received] ${msg.type} from ${msg.from}`);
        enqueue(msg.from, () => handleMessage(msg, names[msg.from]));
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, JSON.stringify({ ok: true }), "application/json");
  }

  // 1) Webhook verification (Meta calls this once when you save the URL)
  if (req.method === "GET" && url.pathname === "/webhook") {
    const q = url.searchParams;
    if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === cfg.verifyToken) {
      return send(res, 200, q.get("hub.challenge") || "");
    }
    return send(res, 403, "Forbidden");
  }

  // 2) Incoming messages
  if (req.method === "POST" && url.pathname === "/webhook") {
    let raw;
    try { raw = await readBody(req); } catch { return send(res, 413, "Too large"); }
    if (!validSignature(raw, req.headers["x-hub-signature-256"])) {
      console.warn("[security] invalid signature, request rejected");
      return send(res, 401, "Unauthorized");
    }
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, "Bad JSON"); }
    send(res, 200, "OK"); // reply right away; processing continues in the background
    processPayload(payload);
    return;
  }

  send(res, 404, "Not found");
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`WhatsApp agent running on http://${cfg.host}:${cfg.port} (${new Date().toISOString()})`);
  console.log(`[config] Business number (phone_number_id): ${cfg.phoneNumberId}`);
  if (cfg.allowAll) {
    console.warn("[config] WARNING: ALLOWED_NUMBERS=* — the agent replies to ANY number.");
  } else if (cfg.allowed.length) {
    console.log(`[config] ${cfg.allowed.length} allowed number(s):`);
    for (const n of cfg.allowed) console.log(`         +${n}`);
  } else {
    console.log("[config] No allowed numbers (ALLOWED_NUMBERS is empty).");
  }
  console.log(`[config] Daily limit per number: ${cfg.dailyLimit ? cfg.dailyLimit + " messages" : "none"}`);
});

// Shut down cleanly when the service is stopped.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { console.log(`[system] ${sig} received, stopping.`); server.close(() => process.exit(0)); });
}
// Don't let an unexpected error in one message bring the server down.
process.on("unhandledRejection", (e) => console.error("[unhandled error]", e?.message || e));
