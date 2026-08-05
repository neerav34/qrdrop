/**
 * QRDrop signaling server.
 *
 * Its only job is to introduce two browsers to each other. It relays SDP and ICE
 * candidates — a few kilobytes of text — and then it is out of the picture. No
 * file bytes pass through here, and nothing is written to disk.
 *
 * Sessions outlive a dropped connection on purpose. When a phone's screen sleeps
 * or its browser backgrounds the tab, the socket dies but the transfer is not
 * over: the session is held for RESUME_GRACE_MS so the peer can `rejoin` with
 * its token and pick up from the byte it left off at.
 */

const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

// Coerce to a number deliberately: Node reads a non-numeric string as a Unix
// socket path, so a stray character in the host's PORT variable would silently
// open no TCP port at all and the platform would report "no open ports".
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw === undefined || raw === "") return 4000;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(
      `PORT="${raw}" is not a valid port number — falling back to 4000. ` +
        `Check for stray characters in the environment variable.`,
    );
    return 4000;
  }
  return n;
})();
const WAITING_TTL_MS = 10 * 60 * 1000; // unscanned QR code lifetime
const RESUME_GRACE_MS = 2 * 60 * 1000; // how long a half-dead transfer is held
const MAX_LIFETIME_MS = 60 * 60 * 1000; // hard ceiling on any session
const SWEEP_MS = 15 * 1000;
const MAX_SESSIONS_PER_IP_PER_MIN = 10;
const MAX_NAME_LEN = 260;
const MAX_LABEL_LEN = 40;
const MAX_SIZE_BYTES = 100 * 1024 * 1024 * 1024; // sanity bound on claimed size
const MAX_SIGNAL_BYTES = 16 * 1024; // an SDP blob is a few KB at most

/**
 * An `Origin` header is always scheme + host + optional port, with no path and no
 * trailing slash. Dashboards show site URLs *with* a trailing slash though, so
 * copying one into ALLOWED_ORIGINS used to reject every browser while curl (which
 * sends no Origin) still passed — a maddening way to fail. Normalise both sides.
 */
function normaliseOrigin(value) {
  return String(value).trim().replace(/\/+$/, "").toLowerCase();
}

// Comma-separated list, e.g. "https://qrdrop.vercel.app,http://localhost:3000".
// A leading "*." allows any subdomain, e.g. "https://*.vercel.app" for previews.
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(normaliseOrigin)
  .filter(Boolean);

function matchesAllowList(origin) {
  return ALLOWED.some((entry) => {
    if (!entry.includes("*")) return entry === origin;
    const pattern = new RegExp(
      `^${entry.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.]+")}$`,
    );
    return pattern.test(origin);
  });
}

const originCheck = (rawOrigin, callback) => {
  // Same-origin/native fetches send no Origin header; QR-scanned browsers always do.
  if (!rawOrigin) return callback(null, true);
  if (ALLOWED.length === 0) return callback(null, true); // dev default: open

  const origin = normaliseOrigin(rawOrigin);
  if (matchesAllowList(origin)) return callback(null, true);

  // LAN testing convenience: allow private-network origins in dev only.
  if (
    process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      origin,
    )
  ) {
    return callback(null, true);
  }

  // Say exactly what was refused. Rejection surfaces to the browser as an opaque
  // 400, so without this line the cause is invisible in the host's logs.
  console.warn(
    `Refused origin "${rawOrigin}" — ALLOWED_ORIGINS is [${ALLOWED.join(", ")}]. ` +
      `Values must be scheme + host with no trailing slash or path.`,
  );
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

/** Device labels are shown verbatim in the peer's UI, so keep them boring. */
function cleanDevice(d) {
  if (!d || typeof d !== "object") return null;
  const kind = ["phone", "tablet", "laptop"].includes(d.kind) ? d.kind : "laptop";
  const label =
    typeof d.label === "string"
      ? d.label.replace(/[^\w \-().]/g, "").slice(0, MAX_LABEL_LEN)
      : "";
  return { kind, label: label || "device" };
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

function sideOf(session, socketId) {
  if (session.sender.socketId === socketId) return "sender";
  if (session.receiver && session.receiver.socketId === socketId) return "receiver";
  return null;
}

function peerSocketOf(session, socketId) {
  const side = sideOf(session, socketId);
  if (side === "sender") return session.receiver?.socketId || null;
  if (side === "receiver") return session.sender.socketId;
  return null;
}

function destroy(sessionId, reason) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  for (const side of [s.sender, s.receiver]) {
    if (!side?.socketId) continue;
    socketSession.delete(side.socketId);
    if (reason) io.to(side.socketId).emit(reason);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const age = now - s.createdAt;
    if (age > MAX_LIFETIME_MS) {
      destroy(id, "expired");
      continue;
    }
    // An unscanned QR code goes stale on the schedule the sender was shown.
    if (s.status === "waiting" && age > WAITING_TTL_MS) {
      destroy(id, "expired");
      continue;
    }
    // Both ends gone for longer than the resume window: nobody is coming back.
    const senderOff = s.sender.offlineSince;
    const receiverOff = s.receiver ? s.receiver.offlineSince : now;
    if (
      senderOff &&
      receiverOff &&
      now - senderOff > RESUME_GRACE_MS &&
      now - receiverOff > RESUME_GRACE_MS
    ) {
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
  socket.on("create", (payload, ack) => {
    if (typeof ack !== "function") return;
    if (socketSession.has(socket.id)) {
      return ack({ error: "This connection already has a session." });
    }
    const meta = payload && payload.file;
    if (!validMeta(meta)) return ack({ error: "Invalid file details." });
    if (rateLimited(ipOf(socket))) {
      return ack({ error: "Too many transfers started. Wait a minute." });
    }

    const sessionId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const createdAt = Date.now();
    sessions.set(sessionId, {
      sessionId,
      createdAt,
      file: { name: meta.name, size: meta.size, type: meta.type },
      sender: {
        socketId: socket.id,
        token,
        device: cleanDevice(payload.device),
        offlineSince: null,
      },
      receiver: null,
      status: "waiting",
    });
    socketSession.set(socket.id, sessionId);
    ack({ sessionId, token, expiresAt: createdAt + WAITING_TTL_MS });
  });

  socket.on("join", (sessionId, ack) => {
    if (typeof ack !== "function") return;
    if (typeof sessionId !== "string" || sessionId.length > 64) {
      return ack({ error: "Invalid session." });
    }
    const s = sessions.get(sessionId);
    if (!s) return ack({ error: "This transfer has expired or already finished." });
    // Single use: once a receiver is bound, a third device gets nothing.
    if (s.receiver && s.receiver.socketId !== socket.id) {
      return ack({ error: "Someone else already claimed this transfer." });
    }
    if (s.sender.socketId === socket.id) return ack({ error: "You are the sender." });
    // Remember the peek so `accept` needn't take an id from the client again.
    socket.data.joined = sessionId;
    ack({ file: s.file, peerDevice: s.sender.device });
  });

  socket.on("accept", (payload, ack) => {
    const s = sessions.get(socket.data.joined);
    if (!s || s.receiver) {
      if (typeof ack === "function") ack({ error: "Transfer no longer available." });
      return;
    }
    const token = crypto.randomUUID();
    s.receiver = {
      socketId: socket.id,
      token,
      device: cleanDevice(payload && payload.device),
      offlineSince: null,
    };
    s.status = "connected";
    socketSession.set(socket.id, s.sessionId);
    if (typeof ack === "function") ack({ token });
    io.to(s.sender.socketId).emit("receiver-ready", { device: s.receiver.device });
  });

  /**
   * Re-attach a reconnected socket to its session. The token proves the caller
   * is the same participant, so a new socket id does not lose the transfer.
   */
  socket.on("rejoin", (payload, ack) => {
    if (typeof ack !== "function") return;
    const { sessionId, token, role } = payload || {};
    if (typeof sessionId !== "string" || typeof token !== "string") {
      return ack({ error: "Invalid resume request." });
    }
    const s = sessions.get(sessionId);
    if (!s) return ack({ error: "This transfer expired while you were away." });

    const side = role === "sender" ? s.sender : s.receiver;
    if (!side || side.token !== token) return ack({ error: "Invalid resume token." });

    if (side.socketId) socketSession.delete(side.socketId);
    side.socketId = socket.id;
    side.offlineSince = null;
    socketSession.set(socket.id, sessionId);
    socket.data.joined = sessionId;

    const peer = role === "sender" ? s.receiver : s.sender;
    const peerOnline = !!peer && !peer.offlineSince;
    ack({
      file: s.file,
      peerDevice: peer ? peer.device : null,
      peerOnline,
    });

    // The sender is always the offerer, so a receiver coming back asks it to
    // renegotiate; a sender coming back starts the offer off its own ack.
    if (role === "receiver" && peerOnline) {
      io.to(s.sender.socketId).emit("receiver-ready", { device: s.receiver.device });
    }
    if (role === "sender" && peerOnline) {
      io.to(peer.socketId).emit("peer-back");
    }
  });

  socket.on("signal", (payload) => {
    const sessionId = socketSession.get(socket.id);
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    if (!validSignal(payload)) return;
    const target = peerSocketOf(s, socket.id);
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
    const side = sideOf(s, socket.id);
    const peer = peerSocketOf(s, socket.id);

    // A session that never got a receiver has nothing to resume — drop it.
    if (!s.receiver) {
      destroy(sessionId, null);
      return;
    }
    if (side === "sender") s.sender.offlineSince = Date.now();
    if (side === "receiver") s.receiver.offlineSince = Date.now();
    // Hold the session open and let the peer know the wait is temporary.
    if (peer) io.to(peer).emit("peer-offline");
  });
});

// Bind on all interfaces explicitly — containers route in from outside.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`QRDrop signaling listening on 0.0.0.0:${PORT}`);
  console.log(
    ALLOWED.length
      ? `Allowed origins: ${ALLOWED.join(", ")}`
      : "ALLOWED_ORIGINS unset — accepting any origin (fine for local dev).",
  );
});
