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
const emit = (s, ev, arg) =>
  new Promise((res) => s.emit(ev, arg, res));

const meta = { name: "report.pdf", size: 2400000, type: "application/pdf" };

// 1. create + join + accept + relay
const sender = await connect();
const created = await emit(sender, "create", meta);
ok("create returns uuid", /^[0-9a-f-]{36}$/.test(created.sessionId || ""), JSON.stringify(created));
ok("create returns expiry ~10min", created.expiresAt - Date.now() > 590000);

const receiver = await connect();
const joined = await emit(receiver, "join", created.sessionId);
ok("join returns file meta", joined.file?.name === "report.pdf", JSON.stringify(joined));

const readyP = new Promise((r) => sender.once("receiver-ready", r));
receiver.emit("accept");
await Promise.race([readyP, new Promise((_, x) => setTimeout(() => x(new Error("timeout")), 2000))])
  .then(() => ok("sender notified on accept", true))
  .catch((e) => ok("sender notified on accept", false, e.message));

const gotOffer = new Promise((r) => receiver.once("signal", r));
sender.emit("signal", { kind: "desc", desc: { type: "offer", sdp: "v=0\r\n" } });
const relayed = await Promise.race([gotOffer, new Promise((r) => setTimeout(() => r(null), 2000))]);
ok("offer relayed to receiver", relayed?.desc?.type === "offer", JSON.stringify(relayed));

const gotAnswer = new Promise((r) => sender.once("signal", r));
receiver.emit("signal", { kind: "desc", desc: { type: "answer", sdp: "v=0\r\n" } });
const back = await Promise.race([gotAnswer, new Promise((r) => setTimeout(() => r(null), 2000))]);
ok("answer relayed back to sender", back?.desc?.type === "answer");

// 2. malformed signal is dropped, not relayed
const shouldNotArrive = new Promise((r) => {
  const t = setTimeout(() => r("nothing"), 600);
  receiver.once("signal", (p) => { clearTimeout(t); r(p); });
});
sender.emit("signal", { kind: "desc", desc: { type: "bogus" } });
ok("malformed signal dropped", (await shouldNotArrive) === "nothing");

// 3. third device is refused (single-use session)
const intruder = await connect();
const refused = await emit(intruder, "join", created.sessionId);
ok("third device refused", !!refused.error, JSON.stringify(refused));

// 4. unknown session
const unknown = await emit(intruder, "join", "11111111-2222-3333-4444-555555555555");
ok("unknown session refused", !!unknown.error, JSON.stringify(unknown));

// 5. invalid metadata rejected
const bad = await emit(intruder, "create", { name: "", size: -1, type: 5 });
ok("invalid meta rejected", !!bad.error, JSON.stringify(bad));

// 6. peer-gone fires on disconnect
const gone = new Promise((r) => {
  const t = setTimeout(() => r("never"), 1500);
  sender.once("peer-gone", () => { clearTimeout(t); r("fired"); });
});
receiver.disconnect();
ok("peer-gone on receiver drop", (await gone) === "fired");

// 7. rate limit: 10 creations per IP per minute
const flood = await connect();
let limitHitAt = null;
for (let i = 0; i < 14; i++) {
  const c = await connect();
  const r = await emit(c, "create", meta);
  if (r.error && limitHitAt === null) limitHitAt = i;
  c.disconnect();
}
flood.disconnect();
ok("rate limit trips", limitHitAt !== null, `first refusal at attempt ${limitHitAt}`);

sender.disconnect();
intruder.disconnect();

console.log("\nPASS");
pass.forEach((p) => console.log("  ✓ " + p));
if (fail.length) {
  console.log("\nFAIL");
  fail.forEach((f) => console.log("  ✗ " + f));
}
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
