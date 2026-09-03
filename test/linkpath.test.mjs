/**
 * Reading the connection's route, and the retry that makes it reliable.
 *
 *   npm run test:linkpath      (no server, no browser, no peer)
 *
 * This exists because of a red CI run. The route is read off the ICE stats when
 * the connection reports itself connected — but a connection can report
 * "connected" before the selected candidate pair appears in `getStats()`, and
 * the read happened exactly once. When it lost that race the route line never
 * appeared at all, which on a fast local transfer is most of the time. The
 * browser suite then threw on a missing element, in a job whose other half is
 * the service worker, so the failure read as something it was not.
 *
 * A fake connection is the whole point: the interesting cases are stats that are
 * empty, then late, then relayed, and a peer replaced mid-read. None of those can
 * be arranged reliably against a real one.
 */
import { readPath, reportPath } from "../lib/linkpath.ts";

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

/** The shape `getStats()` returns: iterable by forEach, addressable by get. */
function statsReport(entries) {
  const map = new Map(entries.map((e) => [e.id, e]));
  return { forEach: (fn) => map.forEach(fn), get: (id) => map.get(id) };
}

const pair = (over = {}) => [
  { id: "p1", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "l1", remoteCandidateId: "r1", ...over },
  { id: "l1", type: "local-candidate", candidateType: "host" },
  { id: "r1", type: "remote-candidate", candidateType: "host" },
];

/** A connection whose stats are empty for the first `blankFor` reads. */
function fakePeer({ blankFor = 0, entries = pair(), throws = false } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    getStats: async () => {
      calls++;
      if (throws) throw new Error("connection is gone");
      return statsReport(calls <= blankFor ? [] : entries);
    },
  };
}

const always = () => true;

console.log("\n▸ reading the route once");
{
  check(
    "a local pair reads as a direct link",
    JSON.stringify(await readPath(fakePeer())) ===
      JSON.stringify({ localType: "host", remoteType: "host", relayed: false }),
  );
  check(
    "a relay on either side is reported as relayed",
    (await readPath(fakePeer({ entries: [
      { id: "p1", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "l1", remoteCandidateId: "r1" },
      { id: "l1", type: "local-candidate", candidateType: "host" },
      { id: "r1", type: "remote-candidate", candidateType: "relay" },
    ] }))).relayed === true,
  );
  check(
    "a pair that succeeded without being nominated is not the chosen one",
    (await readPath(fakePeer({ entries: pair({ nominated: false, state: "succeeded" }) }))) === null,
  );
  check("no pair at all reads as unknown", (await readPath(fakePeer({ blankFor: 1 }))) === null);
  check("and a connection that throws does not propagate", (await readPath(fakePeer({ throws: true }))) === null);
}

console.log("\n▸ the retry, which is the point");
{
  // The measured failure: stats settle after the connection says connected.
  const p = fakePeer({ blankFor: 3 });
  const seen = [];
  await reportPath(p, always, (path) => seen.push(path));
  check(
    "a late-settling route is still reported",
    seen.length === 1 && seen[0].localType === "host",
    `${p.calls} reads, ${seen.length} reported`,
  );
  check("and reported exactly once", seen.length === 1);
}
{
  const p = fakePeer();
  const seen = [];
  await reportPath(p, always, (path) => seen.push(path));
  check("a route available immediately costs one read", p.calls === 1, `${p.calls} reads`);
}
{
  // Stats that never settle must not spin forever, and must not throw.
  const p = fakePeer({ blankFor: Number.MAX_SAFE_INTEGER });
  const seen = [];
  const started = Date.now();
  await reportPath(p, always, (path) => seen.push(path));
  check("stats that never settle give up quietly", seen.length === 0, `${p.calls} reads`);
  check(
    "and give up in a bounded time",
    Date.now() - started < 5000,
    `${Date.now() - started}ms`,
  );
}
{
  // A reconnect replaces the peer; a read in flight for the old one must not
  // report a route for a connection nobody is using any more.
  const p = fakePeer({ blankFor: 2 });
  const seen = [];
  let live = true;
  const done = reportPath(p, () => live, (path) => seen.push(path));
  live = false;
  await done;
  check("a superseded connection reports nothing", seen.length === 0, `${seen.length} reported`);
}

console.log(failed ? "\nLINKPATH FAILED" : "\nLINKPATH PASSED");
process.exit(failed ? 1 : 0);
