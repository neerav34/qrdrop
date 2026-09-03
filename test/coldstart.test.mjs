/**
 * Free hosting idles containers out, so the first visit of the day meets a
 * signaling server that isn't up yet. That must look like waiting, not failing.
 *
 * NOTE: this test owns the signaling server on port 4000 — it stops whatever is
 * listening there and starts its own, so `npm run dev:all` loses its signaling
 * half for the rest of that session.
 *
 *   npm run dev            # in one terminal
 *   npm run test:coldstart
 *
 * It clears the port by looking up what is bound to it, rather than by matching
 * a command line. The previous version matched `node index.js`, which is not how
 * this repo starts the server (`node server/index.js`), so with the dev servers
 * up it quietly measured a *warm* server and failed the one assertion that
 * matters — looking exactly like an app regression. If the port cannot be freed
 * this now says so and stops, rather than testing the wrong thing.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";

const BASE = process.env.E2E_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_DIR = new URL("../server", import.meta.url).pathname;

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORK = path.join(os.tmpdir(), "qrdrop-cold");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const payload = path.join(WORK, "doc.pdf");
fs.writeFileSync(payload, crypto.randomBytes(300_000));

/** Whatever is listening on a TCP port, by pid. Empty when the port is free. */
function listeners(port) {
  try {
    return execSync(`lsof -ti tcp:${port}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }
}

// Make sure nothing is serving signaling, so the page meets a cold server.
for (const pid of listeners(4000)) {
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    /* already gone */
  }
}
for (let i = 0; i < 25 && listeners(4000).length; i++) await sleep(200);
if (listeners(4000).length) {
  console.log(
    `  ✗ port 4000 is still in use by pid ${listeners(4000).join(", ")} — stop it and rerun.`,
  );
  console.log("    A warm server here would test the opposite of what this suite is for.");
  process.exit(1);
}
await sleep(400);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});
let server = null;

const cardText = (page) =>
  page
    .evaluate(() => document.querySelector(".card")?.innerText?.replace(/\n+/g, " | ") || "")
    .catch(() => "");

try {
  const page = await browser.newPage();
  await page.goto(`${BASE}/send`, { waitUntil: "networkidle2" });
  await (await page.waitForSelector("input[type=file]")).uploadFile(payload);
  await sleep(4000);

  const whileDown = await cardText(page);
  check(
    "does not hard-fail while the server is still booting",
    !/Is it running/.test(whileDown),
    whileDown.slice(0, 90),
  );
  check(
    "explains the wait instead of showing a bare spinner",
    /Waking up|Reaching the connection server/.test(whileDown),
    whileDown.slice(0, 90),
  );

  // Now let it finish "booting".
  server = spawn("node", ["index.js"], {
    cwd: SERVER_DIR,
    stdio: "ignore",
    detached: true,
  });

  let recoveredIn = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    if (await page.$(".qr-frame svg")) {
      recoveredIn = i + 1;
      break;
    }
  }
  check(
    "recovers on its own once the server answers",
    recoveredIn !== null,
    recoveredIn !== null ? `QR appeared after ${recoveredIn}s` : "never recovered",
  );
  const afterUp = await cardText(page);
  check("the waking notice clears", !/Waking up/.test(afterUp), afterUp.slice(0, 90));
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  await browser.close();
  // Leave the server running — it's what `npm run signal` would have given you.
  server?.unref();
}

console.log(failed ? "\nCOLD START FAILED" : "\nCOLD START PASSED");
process.exit(failed ? 1 : 0);
