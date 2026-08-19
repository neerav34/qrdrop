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
/*
 * Two ceilings, because one is not enough.
 *
 * The first reaps a session that is sitting around not moving data. The second
 * is an absolute backstop against a leak. A single 60-minute ceiling killed
 * transfers that were still healthily running — rare on a fast LAN, where an
 * hour is tens of gigabytes, but reachable on weak Wi-Fi, and easily reachable
 * by a transfer that keeps pausing while a phone sleeps, since the ceiling
 * counts wall-clock time rather than time spent transferring.
 *
 * Overridable so the sweep can be tested without waiting an hour.
 */
const MAX_LIFETIME_MS = Number(process.env.SESSION_MAX_LIFETIME_MS || 60 * 60 * 1000);
const MAX_ACTIVE_LIFETIME_MS = Number(
  process.env.SESSION_MAX_ACTIVE_LIFETIME_MS || 6 * 60 * 60 * 1000,
);
// Overridable alongside the ceilings above, so the sweep is testable in seconds.
const SWEEP_MS = Number(process.env.SESSION_SWEEP_MS || 15 * 1000);
// Raised from 10: a session is a few hundred bytes and expires in ten minutes,
// while this bucket is shared by everyone behind one address — an office, a
// university, or a mobile carrier's CGNAT. Being stingy here refuses real people.
const MAX_SESSIONS_PER_IP_PER_MIN = Number(
  process.env.MAX_SESSIONS_PER_IP_PER_MIN || 30,
);
// HTTP routes are trivial to serve, so this only exists to stop somebody sitting
// on /stats in a loop. It must comfortably clear one /healthz per page load,
// which Prewarm sends, plus an uptime pinger.
const MAX_HTTP_REQ_PER_IP_PER_MIN = Number(
  process.env.MAX_HTTP_REQ_PER_IP_PER_MIN || 300,
);
const MAX_NAME_LEN = 260;
const MAX_FILES = 100; // keep in step with MAX_FILES in lib/protocol.ts
const MAX_PIN_ATTEMPTS = 5; // keep in step with lib/protocol.ts
const MAX_LABEL_LEN = 40;
const MAX_SIZE_BYTES = 100 * 1024 * 1024 * 1024; // sanity bound on claimed size
const MAX_SIGNAL_BYTES = 16 * 1024; // an SDP blob is a few KB at most

// ---------------------------------------------------------------- ICE / TURN

/**
 * STUN alone lets two devices find each other when a direct path exists. TURN is
 * the fallback that relays the bytes when it doesn't — different networks, or a
 * Wi-Fi that blocks device-to-device traffic.
 *
 * TURN credentials are minted here and handed to clients over the existing
 * socket, never embedded in the web bundle: a long-lived credential shipped to
 * the browser is a credential anyone can lift and spend your free quota on.
 *
 * Relay is a last resort, not a default — ICE ranks relay candidates below host
 * and reflexive ones, so a transfer that can go direct still does, and relay
 * bandwidth is only consumed by transfers that would otherwise have failed.
 */
const STUN_ONLY = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 43200); // 12h
// Overridable so tests can point at a stub instead of the real provider.
const TURN_API_BASE =
  process.env.TURN_API_BASE || "https://rtc.live.cloudflare.com";

/** Any provider with fixed credentials: Metered's Open Relay, self-hosted coturn. */
function staticTurn() {
  const urls = (process.env.TURN_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) return null;
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (!username || !credential) {
    console.warn(
      "TURN_URLS is set but TURN_USERNAME/TURN_CREDENTIAL are missing — ignoring it.",
    );
    return null;
  }
  return [...STUN_ONLY, { urls, username, credential }];
}

/** Cloudflare mints short-lived credentials from a key that stays server-side. */
async function cloudflareTurn() {
  const keyId = process.env.TURN_KEY_ID;
  const token = process.env.TURN_API_TOKEN;
  if (!keyId || !token) return null;
  const res = await fetch(
    `${TURN_API_BASE}/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    },
  );
  if (!res.ok) {
    throw new Error(`TURN credential request failed: ${res.status}`);
  }
  const body = await res.json();
  const servers = body?.iceServers;
  const list = Array.isArray(servers) ? servers : servers ? [servers] : [];
  if (!list.length) throw new Error("TURN credential response had no iceServers");
  return list;
}

const turnMode = process.env.TURN_URLS
  ? "static"
  : process.env.TURN_KEY_ID
    ? "cloudflare"
    : "none";

/**
 * Cached because credentials are per-account, not per-session — one mint serves
 * every transfer until it nears expiry. Refreshed early so no client is ever
 * handed something about to die mid-transfer.
 */
let iceCache = { servers: null, expiresAt: 0 };

async function getIceServers() {
  if (turnMode === "none") return STUN_ONLY;
  if (turnMode === "static") {
    if (!iceCache.servers) iceCache = { servers: staticTurn(), expiresAt: Infinity };
    return iceCache.servers || STUN_ONLY;
  }
  if (iceCache.servers && Date.now() < iceCache.expiresAt) return iceCache.servers;
  try {
    const servers = await cloudflareTurn();
    iceCache = {
      servers,
      // Refresh at 80% of the TTL, so a handover never lands on an expiry.
      expiresAt: Date.now() + TURN_TTL_SECONDS * 1000 * 0.8,
    };
    return servers;
  } catch (e) {
    // A TURN outage must not take the whole app down — direct transfers still
    // work, which is the majority case. Retry on the next request.
    console.warn(`Could not mint TURN credentials (${e.message}) — using STUN only.`);
    iceCache = { servers: null, expiresAt: 0 };
    return STUN_ONLY;
  }
}

/**
 * An `Origin` header is always scheme + host + optional port, with no path and no
 * trailing slash. Dashboards show site URLs *with* a trailing slash though, so
 * copying one into ALLOWED_ORIGINS used to reject every browser while curl (which
 * sends no Origin) still passed — a maddening way to fail. Normalise both sides.
 */
function normaliseOrigin(value) {
  return String(value).trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * An entry written without a scheme ("qrdrop.vercel.app") can only have been
 * meant as "that host, however it's reached", so expand it to both schemes
 * rather than silently matching nothing.
 */
function expandEntry(entry) {
  if (!entry) return [];
  if (entry.includes("://")) return [entry];
  return [`https://${entry}`, `http://${entry}`];
}

// Comma-separated list, e.g. "https://qrdrop.vercel.app,http://localhost:3000".
// A leading "*." allows any subdomain, e.g. "https://*.vercel.app" for previews.
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(normaliseOrigin)
  .flatMap(expandEntry);

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

// Nothing here needs to advertise the framework, and no response of this
// server's should ever be framed or content-sniffed. Cheap, and cannot break a
// JSON API or a stats page.
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  });
  next();
});

app.use((req, res, next) => {
  const ip = clientIp(req.headers, req.socket.remoteAddress);
  if (overLimit(httpLog, ip, MAX_HTTP_REQ_PER_IP_PER_MIN)) {
    return res.status(429).type("text").send("Too many requests");
  }
  next();
});
app.get("/", (_req, res) => res.type("text").send("QRDrop signaling: ok"));
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, sessions: sessions.size, turn: turnMode }),
);

function snapshot() {
  const uptimeHours = (Date.now() - stats.since) / 3_600_000;
  return {
    ...stats,
    live: sessions.size,
    rateLimitPerMinute: MAX_SESSIONS_PER_IP_PER_MIN,
    uptimeHours: Number(uptimeHours.toFixed(2)),
    completionRate: stats.sessionsCreated
      ? Number((stats.sessionsCompleted / stats.sessionsCreated).toFixed(3))
      : null,
    note:
      "Aggregate totals only — no IPs, filenames or per-session records. " +
      "bytesOffered is what senders declared; the server never sees file bytes. " +
      "Resets when the process restarts.",
  };
}

function humanBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Same numbers, two shapes: a readable page for a browser, JSON for anything
 * else. Raw JSON is a miserable way to check on your own project from a phone.
 * Every value below is a number generated here, so there is nothing to escape.
 */
app.get("/stats", (req, res) => {
  const s = snapshot();
  // JSON is the default; HTML only when the client actually prefers it.
  // Listing json first matters: curl and fetch send a wildcard Accept header,
  // which matches html when asked about in isolation, so accepts("html") on
  // its own would hand an HTML page to every script — including this
  // project's own test suite. A browser names text/html and still gets the page.
  const preferred = req.accepts(["json", "html"]);
  if (preferred !== "html" || req.query.json !== undefined) {
    return res.json(s);
  }

  const rate =
    s.completionRate === null ? "—" : `${Math.round(s.completionRate * 100)}%`;
  const rows = [
    ["Transfers completed", s.sessionsCompleted],
    ["Sessions created", s.sessionsCreated],
    ["Never scanned (expired)", s.sessionsExpired],
    ["Cancelled", s.sessionsCancelled],
    ["Files offered", s.filesOffered],
    ["Declared volume", humanBytes(s.bytesOffered)],
    ["PIN-protected", s.pinProtected],
    ["PIN lockouts", s.pinLockouts],
    ["Peak concurrent", s.peakConcurrent],
    ["Live right now", s.live],
  ];

  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QRDrop — usage</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:40px 20px;background:#06090f;color:#e9eef8;
    font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
    display:flex;justify-content:center}
  main{width:100%;max-width:460px}
  h1{font-size:19px;font-weight:600;margin:0 0 4px}
  .sub{color:#5d6d88;font-size:12.5px;margin:0 0 26px}
  .hero{border:1px solid #1b2740;border-radius:18px;padding:22px;text-align:center;
    background:linear-gradient(180deg,#0b1220,rgba(11,18,32,.6));margin-bottom:14px}
  .hero b{display:block;font-size:46px;font-weight:600;color:#00d4ff;
    letter-spacing:-.03em;font-variant-numeric:tabular-nums}
  .hero span{color:#8b9bb8;font-size:13px}
  table{width:100%;border-collapse:collapse}
  td{padding:9px 2px;border-bottom:1px solid #131c2e;font-size:14px}
  td:last-child{text-align:right;font-variant-numeric:tabular-nums;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  tr:last-child td{border-bottom:none}
  .k{color:#8b9bb8}
  footer{margin-top:22px;color:#5d6d88;font-size:12px;line-height:1.6}
  a{color:#00d4ff}
</style></head><body><main>
  <h1>QRDrop usage</h1>
  <p class="sub">Counting since this server last restarted — ${s.uptimeHours} hours ago.</p>
  <div class="hero"><b>${rate}</b><span>of sessions completed a transfer</span></div>
  <table>${rows
    .map((r) => `<tr><td class="k">${r[0]}</td><td>${r[1]}</td></tr>`)
    .join("")}</table>
  <footer>
    Aggregate totals only — no IPs, no filenames, no per-session records, no
    cookies. Declared volume is what senders said they were sending; this server
    never sees a file byte, so it cannot measure what actually moved.
    <br><br><a href="?json">Same data as JSON</a>
  </footer>
</main></body></html>`);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: originCheck, methods: ["GET", "POST"] },
  maxHttpBufferSize: MAX_SIGNAL_BYTES,
});

/**
 * Aggregate counters, so "did anyone actually use it?" has an answer.
 *
 * Deliberately nothing identifying: no IPs, no filenames, no timestamps per
 * session, nothing that could be tied back to a person or a transfer. Totals
 * only. `bytesOffered` is the size senders *declared* — the server never sees a
 * single file byte, so it cannot measure what actually moved.
 *
 * These live in memory, so they reset on restart, and a free-tier host that
 * sleeps when idle restarts often. `since` says how far back the numbers go.
 */
const stats = {
  since: Date.now(),
  sessionsCreated: 0,
  sessionsCompleted: 0,
  sessionsCancelled: 0,
  sessionsExpired: 0,
  pinProtected: 0,
  pinLockouts: 0,
  filesOffered: 0,
  bytesOffered: 0,
  peakConcurrent: 0,
};

/** sessionId -> session. In memory only; wiped on completion or expiry. */
const sessions = new Map();
/** socketId -> sessionId, so we can route a signal without trusting the client. */
const socketSession = new Map();
/** ip -> array of creation timestamps, for the per-minute rate limit. */
const createLog = new Map();
/** ip -> timestamps of plain HTTP requests, so /stats can't be sat on. */
const httpLog = new Map();

/*
 * Which address to hold responsible.
 *
 * The naive version read the *first* entry of X-Forwarded-For, which is exactly
 * the part a client controls: proxies append to that header, so anybody could
 * send "X-Forwarded-For: 203.0.113.1" and land in a fresh rate-limit bucket on
 * every request. Measured against the live deployment, that took the limiter from
 * refusing 4 of 14 session creations to refusing none.
 *
 * Cloudflare fronts this service and *overwrites* CF-Connecting-IP with the true
 * client address, so a client cannot forge it. That is the primary source.
 *
 * Without it, X-Forwarded-For is only usable if we know how many proxies append
 * to it — the client IP sits that many entries from the *right*. Guessing is
 * worse than not trying: too few hops trusts the client, too many buckets every
 * user together and rate-limits the whole world as one. So unless the operator
 * states the hop count, the header is ignored entirely and the socket address is
 * used, which cannot be spoofed.
 */
// `??` rather than `||` on purpose: TRUSTED_IP_HEADER="" must mean "trust no
// header at all", and `||` would silently restore the default instead.
const TRUSTED_IP_HEADER = (
  process.env.TRUSTED_IP_HEADER ?? "cf-connecting-ip"
).toLowerCase();
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS || 0);

function ipOf(socket) {
  return clientIp(socket.handshake.headers, socket.handshake.address);
}

function clientIp(headers, fallback) {
  const trusted = TRUSTED_IP_HEADER ? headers[TRUSTED_IP_HEADER] : undefined;
  if (typeof trusted === "string" && trusted.trim()) return trusted.trim();

  if (TRUSTED_PROXY_HOPS > 0) {
    const fwd = headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) {
      const parts = fwd.split(",").map((v) => v.trim()).filter(Boolean);
      const idx = parts.length - TRUSTED_PROXY_HOPS;
      if (idx >= 0 && parts[idx]) return parts[idx];
    }
  }
  return fallback;
}

/** Sliding one-minute window, shared by the session and HTTP limiters. */
function overLimit(log, key, max) {
  const now = Date.now();
  const hits = (log.get(key) || []).filter((t) => now - t < 60_000);
  if (hits.length >= max) {
    log.set(key, hits);
    return true;
  }
  hits.push(now);
  log.set(key, hits);
  return false;
}

function rateLimited(ip) {
  return overLimit(createLog, ip, MAX_SESSIONS_PER_IP_PER_MIN);
}

/** One file's declared details. Nothing here is trusted for anything but display. */
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

/**
 * An optional PIN, held only as a salted digest. The sender salts and hashes it in
 * the browser, so the PIN itself never crosses the wire or lands in a log here.
 *
 * That is hygiene rather than a defence against this server — six digits behind a
 * known salt is brute-forceable in milliseconds by anyone holding the digest, and
 * a signaling server can already see every SDP it relays. The control that gives
 * a short PIN real value is the attempt limit below, which is enforced per
 * session so reconnecting cannot reset it.
 */
function validPin(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.salt === "string" &&
    /^[0-9a-f]{32}$/.test(p.salt) &&
    typeof p.hash === "string" &&
    /^[0-9a-f]{64}$/.test(p.hash)
  );
}

/** Constant-time compare, so a digest can't be probed a byte at a time. */
function digestsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
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

    // "Still going" means negotiated and with someone still connected. The
    // server never sees file bytes, so this is the closest signal it has —
    // hence the absolute backstop above it.
    const senderHere = !s.sender.offlineSince;
    const receiverHere = !!s.receiver && !s.receiver.offlineSince;
    const inFlight = s.status === "transferring" && (senderHere || receiverHere);

    if (age > MAX_ACTIVE_LIFETIME_MS || (age > MAX_LIFETIME_MS && !inFlight)) {
      if (!s.counted) { s.counted = true; stats.sessionsExpired += 1; }
      destroy(id, "expired");
      continue;
    }
    // An unscanned QR code goes stale on the schedule the sender was shown.
    if (s.status === "waiting" && age > WAITING_TTL_MS) {
      if (!s.counted) { s.counted = true; stats.sessionsExpired += 1; }
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
      if (!s.counted) { s.counted = true; stats.sessionsExpired += 1; }
      destroy(id, "expired");
    }
  }
  for (const log of [createLog, httpLog]) {
    for (const [ip, hits] of log) {
      const live = hits.filter((t) => now - t < 60_000);
      if (live.length) log.set(ip, live);
      else log.delete(ip);
    }
  }
}, SWEEP_MS).unref?.();

io.on("connection", (socket) => {
  socket.on("create", async (payload, ack) => {
    if (typeof ack !== "function") return;
    if (socketSession.has(socket.id)) {
      return ack({ error: "This connection already has a session." });
    }
    const files = payload && payload.files;
    if (!Array.isArray(files) || files.length === 0) {
      return ack({ error: "No files offered." });
    }
    if (files.length > MAX_FILES) {
      return ack({ error: `Too many files — the limit is ${MAX_FILES}.` });
    }
    if (!files.every(validMeta)) return ack({ error: "Invalid file details." });
    const total = files.reduce((n, f) => n + f.size, 0);
    if (!Number.isFinite(total) || total > MAX_SIZE_BYTES) {
      return ack({ error: "Those files are too large." });
    }
    if (rateLimited(ipOf(socket))) {
      return ack({ error: "Too many transfers started. Wait a minute." });
    }

    const pin = payload.pin;
    if (pin !== undefined && pin !== null && !validPin(pin)) {
      return ack({ error: "Invalid PIN details." });
    }

    const sessionId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const createdAt = Date.now();
    sessions.set(sessionId, {
      sessionId,
      createdAt,
      files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      sender: {
        socketId: socket.id,
        token,
        device: cleanDevice(payload.device),
        offlineSince: null,
      },
      receiver: null,
      pin: pin ? { salt: pin.salt, hash: pin.hash, attempts: 0 } : null,
      status: "waiting",
    });
    socketSession.set(socket.id, sessionId);

    stats.sessionsCreated += 1;
    stats.filesOffered += files.length;
    stats.bytesOffered += total;
    if (pin) stats.pinProtected += 1;
    if (sessions.size > stats.peakConcurrent) stats.peakConcurrent = sessions.size;

    ack({
      sessionId,
      token,
      expiresAt: createdAt + WAITING_TTL_MS,
      iceServers: await getIceServers(),
    });
  });

  socket.on("join", async (sessionId, ack) => {
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

    /*
     * Behind a PIN, this reply carries nothing worth having. Not the file names,
     * not the sizes, not even the sender's device — if a snooped QR still leaked
     * "3 files, 1.2 GB, from an iPhone", the PIN would be protecting the bytes
     * while giving away what they are.
     */
    if (s.pin && socket.data.verified !== sessionId) {
      return ack({ needsPin: true, pinSalt: s.pin.salt });
    }

    ack({
      files: s.files,
      peerDevice: s.sender.device,
      iceServers: await getIceServers(),
    });
  });

  /**
   * Exchange a PIN digest for the manifest. Attempts are counted on the session,
   * not the socket, so reconnecting cannot buy a fresh five guesses — and running
   * out destroys the session rather than merely refusing, so a burned code cannot
   * be ground down at leisure.
   */
  socket.on("verify", async (payload, ack) => {
    if (typeof ack !== "function") return;
    const sessionId = payload && payload.sessionId;
    const hash = payload && payload.hash;
    if (typeof sessionId !== "string" || sessionId.length > 64) {
      return ack({ error: "Invalid session." });
    }
    const s = sessions.get(sessionId);
    if (!s) return ack({ error: "This transfer has expired or already finished." });
    if (!s.pin) {
      // Nothing to verify; hand over the manifest as `join` would have.
      socket.data.joined = sessionId;
      return ack({ files: s.files, peerDevice: s.sender.device, iceServers: await getIceServers() });
    }
    if (s.receiver && s.receiver.socketId !== socket.id) {
      return ack({ error: "Someone else already claimed this transfer." });
    }
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      return ack({ error: "Invalid PIN." });
    }

    if (!digestsMatch(hash, s.pin.hash)) {
      s.pin.attempts += 1;
      const left = MAX_PIN_ATTEMPTS - s.pin.attempts;
      io.to(s.sender.socketId).emit("pin-attempt", { remaining: Math.max(0, left) });
      if (left <= 0) {
        stats.pinLockouts += 1;
        if (!s.counted) {
          s.counted = true;
          stats.sessionsCancelled += 1;
        }
        destroy(sessionId, "pin-locked");
        return ack({ error: "Too many wrong PINs. This transfer has been cancelled." });
      }
      return ack({ error: "Wrong PIN.", attemptsLeft: left });
    }

    socket.data.verified = sessionId;
    socket.data.joined = sessionId;
    io.to(s.sender.socketId).emit("pin-ok");
    ack({
      files: s.files,
      peerDevice: s.sender.device,
      iceServers: await getIceServers(),
    });
  });

  socket.on("accept", async (payload, ack) => {
    const s = sessions.get(socket.data.joined);
    if (!s || s.receiver) {
      if (typeof ack === "function") ack({ error: "Transfer no longer available." });
      return;
    }
    // The PIN gate is enforced here too, not just at `join` — otherwise a client
    // could simply skip straight to accepting.
    if (s.pin && socket.data.verified !== s.sessionId) {
      if (typeof ack === "function") ack({ error: "Enter the PIN first." });
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
    if (typeof ack === "function") {
      ack({ token, iceServers: await getIceServers() });
    }
    io.to(s.sender.socketId).emit("receiver-ready", { device: s.receiver.device });
  });

  /**
   * Re-attach a reconnected socket to its session. The token proves the caller
   * is the same participant, so a new socket id does not lose the transfer.
   */
  socket.on("rejoin", async (payload, ack) => {
    if (typeof ack !== "function") return;
    const { sessionId, token, role } = payload || {};
    if (typeof sessionId !== "string" || typeof token !== "string") {
      return ack({ error: "Invalid resume request." });
    }
    const s = sessions.get(sessionId);
    if (!s) return ack({ error: "This transfer expired while you were away." });

    const side = role === "sender" ? s.sender : s.receiver;
    if (!side || side.token !== token) return ack({ error: "Invalid resume token." });

    // The resume token already proves this is the same participant, so a
    // reconnecting receiver does not re-enter the PIN.
    if (role === "receiver") socket.data.verified = sessionId;
    if (side.socketId) socketSession.delete(side.socketId);
    side.socketId = socket.id;
    side.offlineSince = null;
    socketSession.set(socket.id, sessionId);
    socket.data.joined = sessionId;

    const peer = role === "sender" ? s.receiver : s.sender;
    const peerOnline = !!peer && !peer.offlineSince;
    ack({
      files: s.files,
      peerDevice: peer ? peer.device : null,
      peerOnline,
      iceServers: await getIceServers(),
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

  /**
   * A deliberate cancel, which must not look like a dropped connection. Without
   * this the peer sits through the whole resume window waiting for someone who
   * has already walked away.
   */
  socket.on("cancel", (ack) => {
    const done = typeof ack === "function" ? ack : () => {};
    const sessionId = socketSession.get(socket.id);
    if (!sessionId) return done();
    const s = sessions.get(sessionId);
    if (!s) return done();
    const side = sideOf(s, socket.id);
    const peer = peerSocketOf(s, socket.id);
    if (!s.counted) {
      s.counted = true;
      stats.sessionsCancelled += 1;
    }
    destroy(sessionId, null);
    if (peer) io.to(peer).emit("peer-cancelled", { by: side });
    // Acknowledge so the canceller knows the message landed before it drops the
    // socket; otherwise the disconnect can outrun the packet.
    done();
  });

  socket.on("complete", () => {
    const sessionId = socketSession.get(socket.id);
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    // Both peers report completion; count the transfer once.
    if (s && !s.counted) {
      s.counted = true;
      stats.sessionsCompleted += 1;
    }
    destroy(sessionId, null);
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
  console.log(
    `Limits: ${MAX_SESSIONS_PER_IP_PER_MIN} sessions/IP/min, ` +
      `${MAX_HTTP_REQ_PER_IP_PER_MIN} HTTP req/IP/min. Client IP from ` +
      `${TRUSTED_IP_HEADER} when present` +
      (TRUSTED_PROXY_HOPS > 0
        ? `, else X-Forwarded-For at ${TRUSTED_PROXY_HOPS} hop(s) from the right.`
        : ", else the socket address (X-Forwarded-For is not trusted)."),
  );
  console.log(
    turnMode === "none"
      ? "No TURN configured — transfers need a direct path (same network or hotspot)."
      : `TURN: ${turnMode}. Relay is a fallback; direct paths are still preferred.`,
  );
});
