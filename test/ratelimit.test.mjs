/**
 * How the client address is derived, which is the whole basis of rate limiting.
 *
 *   npm run test:ratelimit
 *
 * This exists because the original implementation read the *first* entry of
 * X-Forwarded-For — the part a client controls, since proxies append. Anyone
 * could send "X-Forwarded-For: 203.0.113.1" and get a fresh bucket per request.
 * Against the live deployment that took the limiter from refusing 4 of 14
 * session creations to refusing none at all.
 *
 * Each case boots its own server on its own port with a small limit, so a bucket
 * fills in a few requests.
 */
import { spawn } from "node:child_process";
import { io } from "socket.io-client";

const SERVER_DIR = new URL("../server", import.meta.url).pathname;
const LIMIT = 5;

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function boot(port, env) {
  children.push(
    spawn("node", ["index.js"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        MAX_SESSIONS_PER_IP_PER_MIN: String(LIMIT),
        ...env,
      },
      stdio: "ignore",
    }),
  );
}

const files = [{ name: "a.bin", size: 1024, type: "application/octet-stream" }];
const device = { kind: "laptop", label: "Mac" };

/**
 * Attempt LIMIT+3 creations, each with a different forged header value. `chain`
 * simulates a proxy having appended the real client address after the forged
 * one, which is what X-Forwarded-For actually looks like in production.
 */
async function attempts(port, headerName, { chain = false } = {}) {
  let created = 0;
  let refused = 0;
  for (let i = 0; i < LIMIT + 3; i++) {
    const forged = chain ? `203.0.113.${i}, 10.0.0.9` : `203.0.113.${i}`;
    const extraHeaders = headerName ? { [headerName]: forged } : {};
    const s = io(`http://localhost:${port}`, { transports: ["polling"], extraHeaders });
    await new Promise((res, rej) => {
      s.on("connect", res);
      s.on("connect_error", rej);
    });
    const r = await new Promise((res) => s.emit("create", { files, device }, res));
    if (r.error) refused++;
    else created++;
    s.disconnect();
  }
  return { created, refused };
}

async function ready(port) {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/healthz`)).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

/*
 * A separate server per scenario. Sharing one would mean the first scenario fills
 * the bucket and every later result is "refused" for the wrong reason — which is
 * exactly how the first version of this file fooled itself.
 */
boot(4501, {});                                  // default: only cf-connecting-ip trusted
boot(4502, {});                                  // same, for the forged-XFF case
boot(4503, { TRUSTED_PROXY_HOPS: "1" });         // operator declares one appending proxy
boot(4504, { TRUSTED_IP_HEADER: "" });           // trust no header at all
boot(4505, {});                                  // the documented caveat
boot(4506, { MAX_HTTP_REQ_PER_IP_PER_MIN: "8" });

try {
  for (const p of [4501, 4502, 4503, 4504, 4505, 4506]) {
    if (!(await ready(p))) throw new Error(`server on ${p} never came up`);
  }

  const honest = await attempts(4501, null);
  check(
    "an honest client gets exactly the configured allowance",
    honest.created === LIMIT && honest.refused === 3,
    `created=${honest.created} refused=${honest.refused} (limit ${LIMIT})`,
  );

  // ---------------------------------------------- the bug that was fixed
  const spoofed = await attempts(4502, "X-Forwarded-For");
  check(
    "a forged X-Forwarded-For buys no extra allowance",
    spoofed.created === LIMIT && spoofed.refused === 3,
    `created=${spoofed.created} refused=${spoofed.refused} — was 8/0 before the fix`,
  );

  // ------------------------------------- XFF only when hops are declared
  const hops = await attempts(4503, "X-Forwarded-For", { chain: true });
  check(
    "with one declared hop, XFF is read from the right, not the left",
    hops.created === LIMIT && hops.refused === 3,
    `created=${hops.created} refused=${hops.refused} — the forged left entry is ignored`,
  );

  // ------------------------------------------------- trusting no header
  const paranoid = await attempts(4504, "CF-Connecting-IP");
  check(
    'TRUSTED_IP_HEADER="" really does disable it',
    paranoid.created === LIMIT && paranoid.refused === 3,
    `created=${paranoid.created} refused=${paranoid.refused} — "||" here let the default sneak back`,
  );

  // ------------ documented caveat: a trusted header is only as good as the
  // ------------ proxy that overwrites it
  const cfForged = await attempts(4505, "CF-Connecting-IP");
  check(
    "CF-Connecting-IP IS forgeable with no Cloudflare in front",
    cfForged.refused === 0,
    "safe only because Cloudflare overwrites it — never point TRUSTED_IP_HEADER " +
      "at a header your platform does not set",
  );

  // ------------------------------------------------------- HTTP limiter
  {
    let ok = 0;
    let tooMany = 0;
    for (let i = 0; i < 14; i++) {
      const r = await fetch(`http://localhost:4506/stats`, { headers: { Accept: "*/*" } });
      r.status === 429 ? tooMany++ : ok++;
    }
    check("HTTP routes are rate limited too", tooMany > 0, `${ok} ok, ${tooMany} refused`);
  }
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  for (const c of children) c.kill();
}

console.log(failed ? "\nRATELIMIT FAILED" : "\nRATELIMIT PASSED");
process.exit(failed ? 1 : 0);
