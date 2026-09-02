/**
 * The cross-tab lost update, deterministically.
 *
 *   npm run test:merge      (no server, no browser — imports the real module)
 *
 * `localStorage` looks synchronous, and within one tab it is. Across two tabs in
 * separate renderer processes it is not: each has a cache that syncs a few
 * milliseconds later. Measured in a real Chrome — the sending tab wrote the
 * history key, and the receiving tab read it as empty 3ms afterwards, then wrote
 * its own record over the top. One transfer, one record lost.
 *
 * Which is only reachable when both ends of a transfer are tabs on one device,
 * but "sometimes silently drops a record" is not a property worth keeping.
 *
 * A fake store stands in for storage so the stale write can be placed exactly
 * where it hurts, and a fake schedule replaces timers so the repair runs when
 * this file says so rather than whenever the event loop feels like it.
 */
import { addHistory, readHistory, HISTORY_KEY, HISTORY_LIMIT } from "../lib/history.ts";

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

/** A store that behaves like one tab's view: reads and writes are immediate. */
function fakeStore(initial = null) {
  let value = initial;
  return {
    getItem: (k) => (k === HISTORY_KEY ? value : null),
    setItem: (k, v) => {
      if (k === HISTORY_KEY) value = v;
    },
    removeItem: () => {
      value = null;
    },
    /** What another tab would splat over the key, cache-stale and all. */
    stale: (list) => {
      value = JSON.stringify(list);
    },
    raw: () => value,
  };
}

/** Collects the repair passes instead of running them on a timer. */
function fakeSchedule() {
  const queued = [];
  const schedule = (fn, ms) => queued.push({ fn, ms });
  return { schedule, queued, runAll: () => queued.splice(0).forEach((q) => q.fn()) };
}

const record = (over = {}) => ({
  direction: "sent",
  fileCount: 1,
  totalSize: 4096,
  firstName: "a.bin",
  peer: "Mac",
  ...over,
});

const seeded = (i) => ({
  id: `seed-${i}`,
  at: Date.now() - (i + 1) * 60_000,
  direction: "received",
  fileCount: 1,
  totalSize: 1024,
  firstName: `seed-${i}.bin`,
  peer: null,
});

console.log("\n▸ an ordinary write");
{
  const store = fakeStore();
  const { schedule, queued } = fakeSchedule();
  const returned = addHistory(record(), store, schedule);
  check("the entry is returned", returned.length === 1 && returned[0].firstName === "a.bin");
  check("and is in the store", readHistory(store).length === 1);
  check("with an id and a timestamp", !!returned[0].id && returned[0].at > 0);
  check("and repair passes are queued, not run", queued.length === 2, `${queued.length} queued`);
}

console.log("\n▸ a repair pass with nothing to repair");
{
  const store = fakeStore();
  const { schedule, runAll } = fakeSchedule();
  addHistory(record(), store, schedule);
  const before = store.raw();
  runAll();
  check("leaves the store untouched", store.raw() === before);
  check("and does not duplicate the entry", readHistory(store).length === 1);
}

console.log("\n▸ the lost update: another tab writes a snapshot taken before ours");
{
  const store = fakeStore();
  const { schedule, runAll } = fakeSchedule();
  const mine = addHistory(record({ direction: "sent", firstName: "sent.bin" }), store, schedule)[0];

  // The other tab read the key before our write landed, so its snapshot has no
  // trace of us. This is the measured behaviour, verbatim.
  const theirs = {
    ...seeded(0),
    id: "other-tab",
    at: mine.at + 1,
    direction: "received",
    firstName: "received.bin",
  };
  store.stale([theirs]);
  check(
    "our record is gone before the repair",
    !readHistory(store).some((e) => e.id === mine.id),
    JSON.stringify(readHistory(store).map((e) => e.direction)),
  );

  runAll();
  const after = readHistory(store);
  check("the repair puts it back", after.some((e) => e.id === mine.id));
  check("without discarding theirs", after.some((e) => e.id === "other-tab"), `${after.length} entries`);
  check(
    "newest first",
    after.length === 2 && after[0].id === "other-tab" && after[1].id === mine.id,
    after.map((e) => e.firstName).join(", "),
  );
}

console.log("\n▸ repeated repair is idempotent");
{
  const store = fakeStore();
  const { schedule, queued } = fakeSchedule();
  const mine = addHistory(record(), store, schedule)[0];
  store.stale([]);
  queued.forEach((q) => q.fn());
  queued.forEach((q) => q.fn());
  const after = readHistory(store);
  check("one copy only", after.filter((e) => e.id === mine.id).length === 1, `${after.length} entries`);
}

console.log("\n▸ the cap survives a repair");
{
  const store = fakeStore(JSON.stringify(Array.from({ length: HISTORY_LIMIT }, (_, i) => seeded(i))));
  const { schedule, runAll } = fakeSchedule();
  const mine = addHistory(record(), store, schedule)[0];
  check("still capped after the write", readHistory(store).length === HISTORY_LIMIT);
  check("and the newest record is ours", readHistory(store)[0].id === mine.id);
  store.stale(Array.from({ length: HISTORY_LIMIT }, (_, i) => seeded(i)));
  runAll();
  const after = readHistory(store);
  check("still capped after the repair", after.length === HISTORY_LIMIT, `${after.length} entries`);
  check("and ours is back at the front", after[0].id === mine.id);
}

console.log("\n▸ an unavailable store");
{
  const { schedule, queued } = fakeSchedule();
  const returned = addHistory(record(), null, schedule);
  check("the entry is still returned to the caller", returned.length === 1);
  check("and nothing is scheduled for a store that isn't there", queued.length === 0);
}

console.log(failed ? "\nMERGE FAILED" : "\nMERGE PASSED");
process.exit(failed ? 1 : 0);
