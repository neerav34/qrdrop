/**
 * Proves the TURN relay actually carries a file — the one thing the other suites
 * can't show, because on any single network the direct path always wins.
 *
 * Needs a real TURN provider configured on the signaling server, so it is opt-in:
 *
 *   E2E_URL=https://your-app.vercel.app npm run test:relay
 *   npm run test:relay                      # against localhost + local signal
 *
 * `?relay=1` forces `iceTransportPolicy: "relay"` on both peers, so a direct
 * candidate is never even considered. If this passes, the credentials work and a
 * transfer between two genuinely separated networks will too.
 *
 * It spends relay quota equal to the payload size — deliberately small.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.E2E_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZE = Number(process.env.RELAY_PAYLOAD_BYTES || 512 * 1024);

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const WORK = path.join(os.tmpdir(), "qrdrop-relay");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const src = path.join(WORK, "relayed.bin");
fs.writeFileSync(src, crypto.randomBytes(SIZE));
const srcHash = sha(fs.readFileSync(src));
const dl = path.join(WORK, "dl");
fs.mkdirSync(dl);

console.log(`\n▸ forcing the relay for a ${(SIZE / 1024).toFixed(0)} KB transfer`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const send = await browser.newPage();
  send.on("pageerror", (e) => console.log("  [sender pageerror]", e.message));
  send.on("console", (m) => {
    if (m.type() === "error") console.log("  [sender]", m.text());
  });
  await send.goto(`${BASE}/send?relay=1`, { waitUntil: "networkidle2" });
  await (await send.waitForSelector("input[type=file]")).uploadFile(src);
  await send.waitForSelector(".link-row input, .notice.bad", { timeout: 120000 });

  const refusal = await send.$(".notice.bad");
  if (refusal) {
    throw new Error(await refusal.evaluate((el) => el.textContent.trim()));
  }
  const url = await send.$eval(".link-row input", (el) => el.value);
  check("the forced-relay flag carries into the share link", /relay=1/.test(url), url);

  const recv = await browser.newPage();
  const cdp = await recv.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: dl,
    eventsEnabled: true,
  });
  await recv.goto(url, { waitUntil: "networkidle2" });
  await (await recv.waitForSelector(".btn.primary", { timeout: 60000 })).click();

  await recv.waitForFunction(
    () => document.querySelector("a.btn.primary")?.textContent?.includes("Save file"),
    { timeout: 180000 },
  );
  check("a relay-only transfer completes", true);

  await send.waitForFunction(() => document.body.innerText.includes("delivered"), {
    timeout: 60000,
  });
  const pathText = (await send.$eval(".pathline", (el) => el.textContent)).trim();
  check(
    "the negotiated path really is the relay",
    /Relayed/.test(pathText),
    pathText,
  );

  let got = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !got) {
    const files = fs.readdirSync(dl).filter((f) => !f.endsWith(".crdownload"));
    if (files.length) got = path.join(dl, files[0]);
    else await sleep(150);
  }
  check("the relayed file arrives", !!got, got || "(nothing)");
  if (got) {
    const buf = fs.readFileSync(got);
    check("relayed size matches", buf.length === SIZE, `${buf.length} vs ${SIZE}`);
    check("relayed sha256 matches source", sha(buf) === srcHash);
  }
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
  console.log(
    "\n  If this failed at the connection stage, TURN credentials are wrong or\n" +
      "  the quota is spent — check the signaling server's /healthz for its turn mode.",
  );
} finally {
  await browser.close();
}

console.log(failed ? "\nRELAY FAILED" : "\nRELAY PASSED");
process.exit(failed ? 1 : 0);
