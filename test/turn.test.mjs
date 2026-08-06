/**
 * TURN wiring. Runs against a stub credential provider, so it needs no account
 * and no real TURN service:
 *
 *   npm run test:turn
 *
 * What matters here is not that a relay works — that needs a real provider and a
 * genuinely blocked network — but that the credentials reach the browser at all,
 * are minted once rather than per session, never end up in the web bundle, and
 * that a provider outage degrades to STUN instead of taking transfers down.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";

const SERVER_DIR = new URL("../server", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SECRET = "super-secret-turn-token-do-not-ship";
const STUB_PORT = 4310;

/** Stands in for Cloudflare's generate-ice-servers endpoint. */
let mintCount = 0;
let mintShouldFail = false;
let lastAuth = null;
let lastTtl = null;
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (!req.url.includes("/credentials/generate-ice-servers")) {
      res.writeHead(404).end();
      return;
    }
    mintCount++;
    lastAuth = req.headers.authorization;
    try {
      lastTtl = JSON.parse(body).ttl;
    } catch {
      lastTtl = null;
    }
    if (mintShouldFail) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
      return;
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        iceServers: {
          urls: ["stun:stub.turn:3478", "turn:stub.turn:3478?transport=udp"],
          username: "minted-user",
          credential: "minted-pass",
        },
      }),
    );
  });
});
await new Promise((r) => stub.listen(STUB_PORT, r));

const children = [];
function boot(port, env) {
  const child = spawn("node", ["index.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push(child);
  return () => log;
}

const connect = (port) => {
  const s = io(`http://localhost:${port}`, { transports: ["websocket"] });
  return new Promise((res, rej) => {
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
  });
};
const emit = (s, ev, arg) => new Promise((res) => s.emit(ev, arg, res));

const file = { name: "a.bin", size: 1024, type: "application/octet-stream" };
const device = { kind: "laptop", label: "Mac" };
const flatUrls = (servers) =>
  (servers || []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

const logMinted = boot(4301, {
  TURN_KEY_ID: "test-key",
  TURN_API_TOKEN: SECRET,
  TURN_API_BASE: `http://localhost:${STUB_PORT}`,
  TURN_TTL_SECONDS: "600",
});
const logStatic = boot(4302, {
  TURN_URLS: "turn:openrelay.example:80,turns:openrelay.example:443",
  TURN_USERNAME: "openrelayproject",
  TURN_CREDENTIAL: "openrelayproject",
});
const logNone = boot(4303, {});
await sleep(2200);

try {
  // ---------------------------------------------- minted (Cloudflare-style)
  const sender = await connect(4301);
  const created = await emit(sender, "create", { file, device });
  const urls = flatUrls(created.iceServers);
  check(
    "sender is handed TURN servers with its session",
    urls.some((u) => u.startsWith("turn:")),
    urls.join(" "),
  );
  check("minted credentials are included",
    created.iceServers.some((s) => s.username === "minted-user"));
  check("STUN is still offered alongside TURN", urls.some((u) => u.startsWith("stun:")));
  check("the provider was called with the bearer token", lastAuth === `Bearer ${SECRET}`);
  check("the requested TTL is passed through", lastTtl === 600, String(lastTtl));

  const receiver = await connect(4301);
  const joined = await emit(receiver, "join", created.sessionId);
  check(
    "receiver is handed TURN servers too",
    flatUrls(joined.iceServers).some((u) => u.startsWith("turn:")),
  );
  const accepted = await emit(receiver, "accept", { device });
  check(
    "the accept ack carries them as well",
    flatUrls(accepted.iceServers).some((u) => u.startsWith("turn:")),
  );

  // Credentials are per-account, so one mint should serve every session.
  const before = mintCount;
  for (let i = 0; i < 3; i++) {
    const s = await connect(4301);
    await emit(s, "create", { file, device });
    s.disconnect();
  }
  check(
    "credentials are cached, not minted per session",
    mintCount === before,
    `${mintCount} total mints for 5 sessions`,
  );

  sender.disconnect();
  receiver.disconnect();

  // ------------------------------------------------------ static (any provider)
  const s2 = await connect(4302);
  const created2 = await emit(s2, "create", { file, device });
  const urls2 = flatUrls(created2.iceServers);
  check(
    "static TURN_URLS are served as-is",
    urls2.includes("turn:openrelay.example:80") &&
      urls2.includes("turns:openrelay.example:443"),
    urls2.join(" "),
  );
  check(
    "static credentials are attached",
    created2.iceServers.some((s) => s.credential === "openrelayproject"),
  );
  s2.disconnect();

  // -------------------------------------------------------- no TURN configured
  const s3 = await connect(4303);
  const created3 = await emit(s3, "create", { file, device });
  const urls3 = flatUrls(created3.iceServers);
  check("without TURN configured, STUN is still provided", urls3.some((u) => u.startsWith("stun:")));
  check("and no TURN server is claimed", !urls3.some((u) => u.startsWith("turn")));
  s3.disconnect();

  // ------------------------------------ provider outage degrades, not breaks
  mintShouldFail = true;
  const logOut = boot(4304, {
    TURN_KEY_ID: "test-key",
    TURN_API_TOKEN: SECRET,
    TURN_API_BASE: `http://localhost:${STUB_PORT}`,
  });
  await sleep(1800);
  const s4 = await connect(4304);
  const created4 = await emit(s4, "create", { file, device });
  check(
    "a provider outage still yields a usable session",
    !!created4.sessionId,
    "sessions must not depend on TURN",
  );
  check(
    "and falls back to STUN only",
    flatUrls(created4.iceServers).some((u) => u.startsWith("stun:")) &&
      !flatUrls(created4.iceServers).some((u) => u.startsWith("turn")),
  );
  check("the fallback is logged", /Could not mint TURN credentials/.test(logOut()));
  s4.disconnect();
  mintShouldFail = false;

  // --------------------------------------- the secret must not reach the browser
  const buildDir = path.join(ROOT, ".next");
  if (fs.existsSync(buildDir)) {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|json|html|txt|map)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes(SECRET) || text.includes("minted-pass")) hits.push(full);
        }
      }
    };
    walk(buildDir);
    check(
      "no TURN credential appears anywhere in the web build",
      hits.length === 0,
      hits.length ? hits.slice(0, 3).join(", ") : "checked .next",
    );
  } else {
    check("web build present to scan for leaked credentials", false, "run `npm run build` first");
  }

  void logMinted, logStatic, logNone;
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  for (const c of children) c.kill();
  stub.close();
}

console.log(failed ? "\nTURN FAILED" : "\nTURN PASSED");
process.exit(failed ? 1 : 0);
