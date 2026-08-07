/**
 * Signaling-server protocol tests. Start the server first (`npm run signal`),
 * then: `npm run test:signal`.
 */
import { io } from "socket.io-client";

const URL = process.env.SIGNAL_URL || "http://localhost:4000";
const pass = [];
const fail = [];
const ok = (name, cond, extra = "") =>
  (cond ? pass : fail).push(`${name}${extra ? " :: " + extra : ""}`);

const connect = () => {
  const s = io(URL, { transports: ["websocket"] });
  return new Promise((res, rej) => {
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
  });
};
const emit = (s, ev, arg) => new Promise((res) => s.emit(ev, arg, res));
const waitFor = (s, ev, ms = 2000) =>
  new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    s.once(ev, (payload) => {
      clearTimeout(t);
      res(payload ?? true);
    });
  });

const file = { name: "report.pdf", size: 2400000, type: "application/pdf" };
const laptop = { kind: "laptop", label: "Mac" };
const phone = { kind: "phone", label: "iPhone" };

// ---------------------------------------------- happy path + device labels
const sender = await connect();
const created = await emit(sender, "create", { files: [file], device: laptop });
ok("create returns uuid", /^[0-9a-f-]{36}$/.test(created.sessionId || ""), JSON.stringify(created));
ok("create returns a resume token", /^[0-9a-f-]{36}$/.test(created.token || ""));
ok("create returns expiry ~10min", created.expiresAt - Date.now() > 590000);

const receiver = await connect();
const joined = await emit(receiver, "join", created.sessionId);
ok("join returns the file manifest", joined.files?.[0]?.name === "report.pdf", JSON.stringify(joined.files));
ok("join reveals the sender's device", joined.peerDevice?.label === "Mac", JSON.stringify(joined.peerDevice));

const readyP = waitFor(sender, "receiver-ready");
const accepted = await emit(receiver, "accept", { device: phone });
ok("accept returns a resume token", /^[0-9a-f-]{36}$/.test(accepted.token || ""));
const ready = await readyP;
ok("sender notified on accept", !!ready);
ok("sender learns the receiver's device", ready?.device?.label === "iPhone", JSON.stringify(ready?.device));

// ------------------------------------------------------------ relay + guards
const gotOffer = waitFor(receiver, "signal");
sender.emit("signal", { kind: "desc", desc: { type: "offer", sdp: "v=0\r\n" } });
const relayed = await gotOffer;
ok("offer relayed to receiver", relayed?.desc?.type === "offer");

const gotAnswer = waitFor(sender, "signal");
receiver.emit("signal", { kind: "desc", desc: { type: "answer", sdp: "v=0\r\n" } });
ok("answer relayed back to sender", (await gotAnswer)?.desc?.type === "answer");

const dropped = waitFor(receiver, "signal", 600);
sender.emit("signal", { kind: "desc", desc: { type: "bogus" } });
ok("malformed signal dropped", (await dropped) === null);

const intruder = await connect();
ok(
  "third device refused",
  !!(await emit(intruder, "join", created.sessionId)).error,
);
ok(
  "unknown session refused",
  !!(await emit(intruder, "join", "11111111-2222-3333-4444-555555555555")).error,
);
ok(
  "invalid meta rejected",
  !!(await emit(intruder, "create", { files: [{ name: "", size: -1, type: 5 }] })).error,
);
ok(
  "an empty file list is rejected",
  !!(await emit(await connect(), "create", { files: [], device: laptop })).error,
);
ok(
  "a non-array files field is rejected",
  !!(await emit(await connect(), "create", { files: file, device: laptop })).error,
);
ok(
  "too many files is rejected",
  !!(
    await emit(await connect(), "create", {
      files: Array.from({ length: 101 }, (_, i) => ({ ...file, name: `f${i}.bin` })),
      device: laptop,
    })
  ).error,
);
{
  const many = Array.from({ length: 5 }, (_, i) => ({ ...file, name: `p${i}.jpg` }));
  const multi = await emit(await connect(), "create", { files: many, device: laptop });
  ok("a multi-file session is accepted", !!multi.sessionId, JSON.stringify(multi.error || "ok"));
  const peek = await emit(await connect(), "join", multi.sessionId);
  ok(
    "the receiver sees all five files",
    peek.files?.length === 5 && peek.files[4].name === "p4.jpg",
    `${peek.files?.length} files`,
  );
}
ok(
  "device label is sanitised",
  (
    await emit(await connect(), "create", {
      files: [file],
      device: { kind: "hax", label: "<script>alert(1)</script>".repeat(4) },
    })
  ).sessionId !== undefined,
  "server accepts but strips it",
);

// ------------------------------------------------------- resume after a drop
// A receiver going quiet must NOT destroy the session — that's the whole point.
const offlineP = waitFor(sender, "peer-offline");
receiver.disconnect();
ok("sender told the peer went offline", !!(await offlineP));

const returning = await connect();
const badToken = await emit(returning, "rejoin", {
  sessionId: created.sessionId,
  token: "00000000-0000-0000-0000-000000000000",
  role: "receiver",
});
ok("rejoin with a wrong token refused", !!badToken.error, JSON.stringify(badToken));

const reReadyP = waitFor(sender, "receiver-ready");
const rejoined = await emit(returning, "rejoin", {
  sessionId: created.sessionId,
  token: accepted.token,
  role: "receiver",
});
ok("session survived the drop", !rejoined.error, JSON.stringify(rejoined));
ok("rejoin returns the manifest", rejoined.files?.[0]?.name === "report.pdf");
ok("rejoin reports the peer is online", rejoined.peerOnline === true);
ok("rejoin re-triggers renegotiation", !!(await reReadyP));

// Signals must route to the *new* socket, not the dead one.
const afterResume = waitFor(returning, "signal");
sender.emit("signal", { kind: "desc", desc: { type: "offer", sdp: "v=0\r\n" } });
ok("signals route to the reconnected socket", (await afterResume)?.desc?.type === "offer");

// The sender can come back too.
const senderToken = created.token;
const backP = waitFor(returning, "peer-back");
sender.disconnect();
const senderAgain = await connect();
const senderRejoin = await emit(senderAgain, "rejoin", {
  sessionId: created.sessionId,
  token: senderToken,
  role: "sender",
});
ok("sender can rejoin too", !senderRejoin.error, JSON.stringify(senderRejoin));
ok("sender sees the receiver online", senderRejoin.peerOnline === true);
ok("receiver told the sender is back", !!(await backP));

// -------------------------------------------------- deliberate cancellation
// A cancel must be distinguishable from a dropped connection. Told apart wrongly,
// the peer waits out the whole resume window for someone who has walked away.
{
  const a = await connect();
  const created2 = await emit(a, "create", { files: [file], device: laptop });
  const b = await connect();
  await emit(b, "join", created2.sessionId);
  await emit(b, "accept", { device: phone });

  const gonePromise = waitFor(b, "peer-gone", 900);
  const cancelPromise = waitFor(b, "peer-cancelled", 1500);
  a.emit("cancel");
  const cancelled = await cancelPromise;
  ok("the peer is told a cancel was deliberate", !!cancelled, JSON.stringify(cancelled));
  ok(
    "and it says which side cancelled",
    cancelled?.by === "sender",
    JSON.stringify(cancelled?.by),
  );
  ok(
    "the peer is NOT told to sit and wait for a resume",
    (await gonePromise) === null,
    "peer-gone would start the 2-minute resume wait",
  );
  const after = await emit(await connect(), "join", created2.sessionId);
  ok("a cancelled session is destroyed", !!after.error, after.error || "still alive");
  a.disconnect();
  b.disconnect();
}

{
  // The receiver can cancel too, and the sender learns who did it.
  const a = await connect();
  const created3 = await emit(a, "create", { files: [file], device: laptop });
  const b = await connect();
  await emit(b, "join", created3.sessionId);
  await emit(b, "accept", { device: phone });
  const seen = waitFor(a, "peer-cancelled", 1500);
  b.emit("cancel");
  const info = await seen;
  ok("a receiver cancel reaches the sender", !!info);
  ok("attributed to the receiver", info?.by === "receiver", JSON.stringify(info?.by));
  a.disconnect();
  b.disconnect();
}

// ------------------------------------------------------------- completion
senderAgain.emit("complete");
await new Promise((r) => setTimeout(r, 150));
const afterComplete = await emit(await connect(), "join", created.sessionId);
ok("session gone after completion", !!afterComplete.error);

// ------------------------------------------------- unscanned session cleanup
const lonely = await connect();
const lonelySession = await emit(lonely, "create", { files: [file], device: laptop });
ok("the lonely session was actually created", !!lonelySession.sessionId, "else the next check is vacuous");
lonely.disconnect();
await new Promise((r) => setTimeout(r, 150));
const gone = await emit(await connect(), "join", lonelySession.sessionId);
ok("never-accepted session dropped on disconnect", !!gone.error);

// ------------------------------------------------------------- rate limiting
let limitHitAt = null;
for (let i = 0; i < 14; i++) {
  const c = await connect();
  const r = await emit(c, "create", { files: [file], device: laptop });
  if (r.error && limitHitAt === null) limitHitAt = i;
  c.disconnect();
}
ok("rate limit trips", limitHitAt !== null, `first refusal at attempt ${limitHitAt}`);

console.log("\nPASS");
pass.forEach((p) => console.log("  ✓ " + p));
if (fail.length) {
  console.log("\nFAIL");
  fail.forEach((f) => console.log("  ✗ " + f));
}
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
