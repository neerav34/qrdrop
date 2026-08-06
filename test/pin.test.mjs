/**
 * PIN gate, at the protocol level. Start the signaling server first:
 *
 *   npm run signal
 *   npm run test:pin
 *
 * The properties that matter:
 *   - a PIN-protected `join` leaks *nothing* — not names, not sizes, not the
 *     sender's device. A PIN that guards the bytes but announces "3 files, 1.2 GB
 *     from an iPhone" is not much of a gate.
 *   - guesses are limited per *session*, so reconnecting cannot buy five more.
 *     This is the control that makes six digits meaningful; the hashing does not.
 *   - running out destroys the session rather than merely refusing.
 *   - `accept` is gated too, so a client cannot skip `verify` entirely.
 */
import crypto from "node:crypto";
import { io } from "socket.io-client";

const URL = process.env.SIGNAL_URL || "http://localhost:4000";

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

const connect = () => {
  const s = io(URL, { transports: ["websocket"] });
  return new Promise((res, rej) => {
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
  });
};
const emit = (s, ev, arg) => new Promise((res) => s.emit(ev, arg, res));
const waitFor = (s, ev, ms = 1500) =>
  new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    s.once(ev, (p) => {
      clearTimeout(t);
      res(p ?? true);
    });
  });

const digest = (salt, pin) =>
  crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex");

const files = [{ name: "payslip.pdf", size: 812_345, type: "application/pdf" }];
const laptop = { kind: "laptop", label: "Mac" };
const phone = { kind: "phone", label: "iPhone" };

const PIN = "428913";
const salt = crypto.randomBytes(16).toString("hex");

try {
  // ------------------------------------------------- a locked session reveals nothing
  const sender = await connect();
  const created = await emit(sender, "create", {
    files,
    device: laptop,
    pin: { salt, hash: digest(salt, PIN) },
  });
  check("a PIN-protected session is created", !!created.sessionId, created.error || "");

  const receiver = await connect();
  const peek = await emit(receiver, "join", created.sessionId);
  check("join says a PIN is needed", peek.needsPin === true, JSON.stringify(peek));
  check("join leaks no file list", peek.files === undefined);
  check("join leaks no sender device", peek.peerDevice === undefined);
  check("join returns the salt, which is not secret", /^[0-9a-f]{32}$/.test(peek.pinSalt || ""));

  // ------------------------------------------------------- accept must be gated too
  const sneaky = await emit(receiver, "accept", { device: phone });
  check("accept is refused without verifying", !!sneaky.error, JSON.stringify(sneaky));

  // ----------------------------------------------------------- wrong then right
  const attemptSeen = waitFor(sender, "pin-attempt");
  const wrong = await emit(receiver, "verify", {
    sessionId: created.sessionId,
    hash: digest(peek.pinSalt, "000000"),
  });
  check("a wrong PIN is refused", !!wrong.error, wrong.error || "");
  check("it reports remaining attempts", wrong.attemptsLeft === 4, String(wrong.attemptsLeft));
  const seen = await attemptSeen;
  check("the sender is told someone guessed wrong", seen?.remaining === 4, JSON.stringify(seen));

  const malformed = await emit(receiver, "verify", {
    sessionId: created.sessionId,
    hash: "not-a-digest",
  });
  check("a malformed digest is refused", !!malformed.error);

  const okP = waitFor(sender, "pin-ok");
  const right = await emit(receiver, "verify", {
    sessionId: created.sessionId,
    hash: digest(peek.pinSalt, PIN),
  });
  check("the right PIN returns the manifest", right.files?.[0]?.name === "payslip.pdf", JSON.stringify(right.error || ""));
  check("and the sender's device", right.peerDevice?.label === "Mac");
  check("and ICE servers, as an unlocked join would", Array.isArray(right.iceServers));
  check("the sender is told it was unlocked", !!(await okP));

  const nowAccepted = await emit(receiver, "accept", { device: phone });
  check("accept works once verified", !!nowAccepted.token, JSON.stringify(nowAccepted.error || ""));
  sender.disconnect();
  receiver.disconnect();

  // --------------------------------- attempts are per session, not per socket
  const s2 = await connect();
  const locked = await emit(s2, "create", {
    files,
    device: laptop,
    pin: { salt, hash: digest(salt, PIN) },
  });
  let refusals = 0;
  let destroyed = false;
  // A fresh socket for every guess — the naive implementation resets here.
  for (let i = 0; i < 5; i++) {
    const guesser = await connect();
    const res = await emit(guesser, "verify", {
      sessionId: locked.sessionId,
      hash: digest(salt, String(100000 + i)),
    });
    if (res.error) refusals++;
    if (res.attemptsLeft === undefined) destroyed = true;
    guesser.disconnect();
  }
  check("every guess from a new socket is refused", refusals === 5, `${refusals}/5`);
  check("the fifth wrong guess kills the session", destroyed, "reconnecting must not reset the count");

  const after = await emit(await connect(), "join", locked.sessionId);
  check("the session is gone after the limit", !!after.error, after.error || "still alive");

  // Even the correct PIN cannot revive it.
  const revive = await emit(await connect(), "verify", {
    sessionId: locked.sessionId,
    hash: digest(salt, PIN),
  });
  check("the right PIN cannot revive a burned session", !!revive.error);
  s2.disconnect();

  // ------------------------------------------------ malformed PIN at create time
  const bad = await emit(await connect(), "create", {
    files,
    device: laptop,
    pin: { salt: "short", hash: "nope" },
  });
  check("a malformed PIN is rejected at create", !!bad.error, bad.error || "");

  // ------------------------------------------- no PIN set means no gate at all
  const open = await connect();
  const plain = await emit(open, "create", { files, device: laptop });
  const openPeek = await emit(await connect(), "join", plain.sessionId);
  check("a session without a PIN still returns its manifest", openPeek.files?.length === 1);
  check("and does not claim to need a PIN", openPeek.needsPin === undefined);
  open.disconnect();
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
}

console.log(failed ? "\nPIN FAILED" : "\nPIN PASSED");
process.exit(failed ? 1 : 0);
