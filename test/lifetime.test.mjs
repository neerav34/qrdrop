/**
 * Session sweep behaviour. Spawns its own servers with the lifetime ceilings
 * shortened, so an hour's worth of behaviour is testable in seconds:
 *
 *   npm run test:lifetime
 *
 * The case that matters: a transfer still in flight must survive the ceiling that
 * reaps idle sessions. A single unconditional ceiling killed live transfers —
 * rarely on a fast LAN, but reachably on weak Wi-Fi, and easily for a transfer
 * that keeps pausing while a phone sleeps, since the clock counts wall time.
 */
import { spawn } from "node:child_process";
import { io } from "socket.io-client";

const SERVER_DIR = new URL("../server", import.meta.url).pathname;

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function boot(port, env) {
  const child = spawn("node", ["index.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), NODE_ENV: "production", ...env },
    stdio: "ignore",
  });
  children.push(child);
}

const connect = (port) => {
  const s = io(`http://localhost:${port}`, { transports: ["websocket"] });
  return new Promise((res, rej) => {
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
  });
};
const emit = (s, ev, arg) => new Promise((res) => s.emit(ev, arg, res));

const files = [{ name: "big.bin", size: 8_000_000_000, type: "application/octet-stream" }];
const laptop = { kind: "laptop", label: "Mac" };
const phone = { kind: "phone", label: "iPhone" };

// Idle ceiling 3s, active backstop 60s, sweeping every second.
boot(4401, {
  SESSION_MAX_LIFETIME_MS: "3000",
  SESSION_MAX_ACTIVE_LIFETIME_MS: "60000",
  SESSION_SWEEP_MS: "1000",
});

// Poll rather than guess: a fixed sleep is how this failed the first time.
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch("http://localhost:4401/healthz");
    if (res.ok) { ready = true; break; }
  } catch {}
  await sleep(250);
}
if (!ready) {
  console.log("  ✗ server never came up on 4401");
  process.exit(1);
}

try {
  // ---- a session that got connected and is transferring must survive
  const sender = await connect(4401);
  const created = await emit(sender, "create", { files, device: laptop });
  const receiver = await connect(4401);
  await emit(receiver, "join", created.sessionId);
  await emit(receiver, "accept", { device: phone });
  // A signal is what flips the session to "transferring" — the same thing a real
  // negotiation does.
  sender.emit("signal", { kind: "desc", desc: { type: "offer", sdp: "v=0\r\n" } });
  await sleep(300);

  let expired = false;
  sender.on("expired", () => (expired = true));

  await sleep(5000); // well past the 3s idle ceiling
  check(
    "a transfer in flight outlives the idle ceiling",
    !expired,
    "a long transfer on weak Wi-Fi must not be killed mid-file",
  );
  const still = await emit(await connect(4401), "join", created.sessionId);
  check(
    "and the session is genuinely still there",
    still.error === "Someone else already claimed this transfer.",
    still.error || JSON.stringify(still.files?.length),
  );
  sender.disconnect();
  receiver.disconnect();

  // ---- an idle session must still be reaped on the short ceiling
  const idle = await connect(4401);
  const idleSession = await emit(idle, "create", { files, device: laptop });
  const idleReceiver = await connect(4401);
  await emit(idleReceiver, "join", idleSession.sessionId);
  await emit(idleReceiver, "accept", { device: phone });
  // Deliberately no signal: connected, but nothing ever negotiated.
  await sleep(5000);
  const gone = await emit(await connect(4401), "join", idleSession.sessionId);
  check(
    "a connected-but-idle session is still reaped",
    !!gone.error,
    gone.error || "still alive — the ceiling has stopped working",
  );
  idle.disconnect();
  idleReceiver.disconnect();

  // ---- an unscanned code still dies on its own schedule
  const lonely = await connect(4401);
  const lonelySession = await emit(lonely, "create", { files, device: laptop });
  check("an unscanned session is created", !!lonelySession.sessionId);
  await sleep(5000);
  const lonelyGone = await emit(await connect(4401), "join", lonelySession.sessionId);
  check("an unscanned code still expires", !!lonelyGone.error, lonelyGone.error || "still alive");
  lonely.disconnect();
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  for (const c of children) c.kill();
}

console.log(failed ? "\nLIFETIME FAILED" : "\nLIFETIME PASSED");
process.exit(failed ? 1 : 0);
