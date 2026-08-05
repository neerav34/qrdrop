/**
 * QRDrop signaling server.
 *
 * Its only job is to introduce two browsers to each other. It relays SDP and ICE
 * candidates — a few kilobytes of text — and then it is out of the picture. No
 * file bytes pass through here, and nothing is written to disk.
 */

const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 4000;
const SESSION_TTL_MS = 10 * 60 * 1000; // QR code lifetime
const SWEEP_MS = 30 * 1000;
const MAX_SESSIONS_PER_IP_PER_MIN = 10;
const MAX_NAME_LEN = 260;
const MAX_SIZE_BYTES = 100 * 1024 * 1024 * 1024; // sanity bound on claimed size
const MAX_SIGNAL_BYTES = 16 * 1024; // an SDP blob is a few KB at most

// Comma-separated list, e.g. "https://qrdrop.vercel.app,http://localhost:3000"
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const originCheck = (origin, callback) => {
  // Same-origin/native fetches send no Origin header; QR-scanned browsers always do.
  if (!origin) return callback(null, true);
  if (ALLOWED.length === 0) return callback(null, true); // dev default: open
  if (ALLOWED.includes(origin)) return callback(null, true);
  // LAN testing convenience: allow private-network origins in dev only.
  if (
    process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      origin,
    )
  ) {
    return callback(null, true);
  }
  return callback(new Error("Origin not allowed"));
};

const app = express();
app.get("/", (_req, res) => res.type("text").send("QRDrop signaling: ok"));
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, sessions: sessions.size }),
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: originCheck, methods: ["GET", "POST"] },
  maxHttpBufferSize: MAX_SIGNAL_BYTES,
});

/** sessionId -> session. In memory only; wiped on completion or expiry. */
const sessions = new Map();
/** socketId -> sessionId, so we can route a signal without trusting the client. */
const socketSession = new Map();
/** ip -> array of creation timestamps, for the per-minute rate limit. */
const createLog = new Map();

function ipOf(socket) {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return socket.handshake.address;
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (createLog.get(ip) || []).filter((t) => now - t < 60_000);
  if (hits.length >= MAX_SESSIONS_PER_IP_PER_MIN) {
    createLog.set(ip, hits);
    return true;
  }
  hits.push(now);
  createLog.set(ip, hits);
  return false;
}

function validMeta(m) {
  return (
    m &&
    typeof m === "object" &&
    typeof m.name === "string" &&
    m.name.length > 0 &&
    m.name.length <= MAX_NAME_LEN &&
    typeof m.size === "number" &&
    Number.isFinite(m.size) &&
    m.size >= 0 &&
    m.size <= MAX_SIZE_BYTES &&
    typeof m.type === "string" &&
    m.type.length <= 128
  );
}

function validSignal(p) {
  if (!p || typeof p !== "object") return false;
  if (p.kind === "desc") {
    return (
      p.desc &&
      typeof p.desc === "object" &&
      typeof p.desc.type === "string" &&
      ["offer", "answer", "pranswer", "rollback"].includes(p.desc.type) &&
      (p.desc.sdp === undefined || typeof p.desc.sdp === "string")
    );
  }
  if (p.kind === "candidate") {
    return p.candidate && typeof p.candidate === "object";
  }
  return false;
}

function peerOf(session, socketId) {
  if (session.senderId === socketId) return session.receiverId;
  if (session.receiverId === socketId) return session.senderId;
  return null;
}

function destroy(sessionId, reason) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  for (const id of [s.senderId, s.receiverId]) {
    if (!id) continue;
    socketSession.delete(id);
    if (reason) io.to(id).emit(reason);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS && s.status !== "transferring") {
      destroy(id, "expired");
    }
  }
  for (const [ip, hits] of createLog) {
    const live = hits.filter((t) => now - t < 60_000);
    if (live.length) createLog.set(ip, live);
    else createLog.delete(ip);
  }
}, SWEEP_MS).unref?.();

io.on("connection", (socket) => {
  socket.on("create", (meta, ack) => {
    if (typeof ack !== "function") return;
    if (socketSession.has(socket.id)) {
      return ack({ error: "This connection already has a session." });
    }
    if (!validMeta(meta)) return ack({ error: "Invalid file details." });
    if (rateLimited(ipOf(socket))) {
      return ack({ error: "Too many transfers started. Wait a minute." });
    }

    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    sessions.set(sessionId, {
      sessionId,
      createdAt,
      senderId: socket.id,
      receiverId: null,
      file: { name: meta.name, size: meta.size, type: meta.type },
      status: "waiting",
    });
    socketSession.set(socket.id, sessionId);
    ack({ sessionId, expiresAt: createdAt + SESSION_TTL_MS });
  });

  socket.on("join", (sessionId, ack) => {
    if (typeof ack !== "function") return;
    if (typeof sessionId !== "string" || sessionId.length > 64) {
      return ack({ error: "Invalid session." });
    }
    const s = sessions.get(sessionId);
    if (!s) return ack({ error: "This transfer has expired or already finished." });
    // Single use: once a receiver is bound, a third device gets nothing.
    if (s.receiverId && s.receiverId !== socket.id) {
      return ack({ error: "Someone else already claimed this transfer." });
    }
    if (s.senderId === socket.id) return ack({ error: "You are the sender." });
    // Remember the peek so `accept` needn't take an id from the client again.
    socket.data.joined = sessionId;
    ack({ file: s.file });
  });

  socket.on("accept", () => {
    const s = sessions.get(socket.data.joined);
    if (!s || s.receiverId) return;
    s.receiverId = socket.id;
    s.status = "connected";
    socketSession.set(socket.id, s.sessionId);
    io.to(s.senderId).emit("receiver-ready");
  });

  socket.on("signal", (payload) => {
    const sessionId = socketSession.get(socket.id);
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    if (!validSignal(payload)) return;
    const target = peerOf(s, socket.id);
    if (!target) return;
    if (s.status === "connected") s.status = "transferring";
    io.to(target).emit("signal", payload);
  });

  socket.on("complete", () => {
    const sessionId = socketSession.get(socket.id);
    if (sessionId) destroy(sessionId, null);
  });

  socket.on("disconnect", () => {
    const sessionId = socketSession.get(socket.id);
    socketSession.delete(socket.id);
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    const peer = peerOf(s, socket.id);
    destroy(sessionId, null);
    if (peer) io.to(peer).emit("peer-gone");
  });
});

server.listen(PORT, () => {
  console.log(`QRDrop signaling on :${PORT}`);
  console.log(
    ALLOWED.length
      ? `Allowed origins: ${ALLOWED.join(", ")}`
      : "ALLOWED_ORIGINS unset — accepting any origin (fine for local dev).",
  );
});
