/**
 * ALLOWED_ORIGINS handling. This is worth its own suite because getting it wrong
 * fails in the most confusing possible way: `curl` sends no Origin header and
 * gets a cheerful 200, while every real browser is rejected with an opaque 400.
 *
 *   npm run test:origins
 *
 * It spawns its own servers on ports 4201+, so nothing else needs to be running.
 */
import { spawn } from "node:child_process";

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
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push(child);
  return () => log;
}

/** The engine.io handshake, which is what a browser actually hits first. */
async function handshake(port, origin) {
  const res = await fetch(
    `http://localhost:${port}/socket.io/?EIO=4&transport=polling`,
    { headers: origin ? { Origin: origin } : {} },
  );
  return res.status;
}

const SITE = "https://qrdrop-seven.vercel.app";

const logUnset = boot(4201, { ALLOWED_ORIGINS: "" });
const logExact = boot(4202, { ALLOWED_ORIGINS: SITE });
const logSlash = boot(4203, { ALLOWED_ORIGINS: `${SITE}/` });
const logSpaced = boot(4204, { ALLOWED_ORIGINS: `  ${SITE.toUpperCase()} , http://localhost:3000 ` });
const logWild = boot(4205, { ALLOWED_ORIGINS: "https://*.vercel.app" });
const logNoScheme = boot(4206, { ALLOWED_ORIGINS: "qrdrop-seven.vercel.app" });
await sleep(2200);

try {
  check("unset: allows any origin (dev default)", (await handshake(4201, SITE)) === 200);
  check("unset: still serves requests with no Origin", (await handshake(4201)) === 200);

  check("exact match is allowed", (await handshake(4202, SITE)) === 200);
  check("a different origin is refused", (await handshake(4202, "https://evil.example.com")) === 400);
  check(
    "refusal is explained in the log, not silent",
    /Refused origin/.test(logExact()),
    (logExact().match(/Refused origin[^\n]*/) || ["(nothing logged)"])[0].slice(0, 96),
  );

  // The regression that broke the first live deployment.
  check(
    "a trailing slash in the env var still matches",
    (await handshake(4203, SITE)) === 200,
    "dashboards copy URLs with a trailing slash",
  );
  check(
    "surrounding whitespace and case still match",
    (await handshake(4204, SITE)) === 200,
  );
  check(
    "multi-value lists work",
    (await handshake(4204, "http://localhost:3000")) === 200,
  );

  check("wildcard subdomain matches", (await handshake(4205, "https://qrdrop-git-abc.vercel.app")) === 200);
  check("wildcard does not match a different apex", (await handshake(4205, "https://vercel.app.evil.com")) === 400);
  check("wildcard spans one label only", (await handshake(4205, "https://a.b.vercel.app")) === 400);

  // A value written without a scheme can only have meant "that host".
  check(
    "an entry with no scheme still matches https",
    (await handshake(4206, SITE)) === 200,
  );
  check(
    "an entry with no scheme also matches http",
    (await handshake(4206, "http://qrdrop-seven.vercel.app")) === 200,
  );
  check(
    "an entry with no scheme does not match another host",
    (await handshake(4206, "https://evil.example.com")) === 400,
  );

  void logUnset, logSlash, logWild, logNoScheme;
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  for (const c of children) c.kill();
}

console.log(failed ? "\nORIGINS FAILED" : "\nORIGINS PASSED");
process.exit(failed ? 1 : 0);
