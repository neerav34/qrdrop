/**
 * Free hosting idles containers out, so the first visit of the day meets a
 * signaling server that isn't up yet. That must look like waiting, not failing.
 *
 * NOTE: this test owns the signaling server on port 4000 — it stops whatever is
 * listening there and starts its own. Run it with the web dev server up but
 * `npm run signal` NOT running:
 *
 *   npm run dev            # in one terminal
 *   npm run test:coldstart
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

// Make sure nothing is serving signaling, so the page meets a cold server.
try {
  execSync("pkill -f 'node index.js'", { stdio: "ignore" });
} catch {
  /* nothing was running */
}
await sleep(800);

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
