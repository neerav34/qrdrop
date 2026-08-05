/**
 * Real two-tab transfer over WebRTC in a real Chrome. Start both servers first
 * (`npm run dev:all`), then: `npm run test:e2e`.
 *
 * This is the test that matters — it proves the bytes arrive intact, not just
 * that the handshake works.
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

const WORK = path.join(os.tmpdir(), "qrdrop-e2e");
const DOWNLOADS = path.join(WORK, "dl");
const SRC = path.join(WORK, "payload.bin");
const SIZE = 3 * 1024 * 1024 + 777; // odd size so the last chunk is partial

fs.mkdirSync(WORK, { recursive: true });

fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.writeFileSync(SRC, crypto.randomBytes(SIZE));
const srcHash = crypto.createHash("sha256").update(fs.readFileSync(SRC)).digest("hex");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

const log = (...a) => console.log(...a);
let failed = false;
const check = (name, cond, extra = "") => {
  log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

try {
  // ---- sender tab
  const send = await browser.newPage();
  send.on("pageerror", (e) => log("  [sender pageerror]", e.message));
  send.on("console", (m) => { if (m.type() === "error") log("  [sender console]", m.text()); });
  await send.goto(`${BASE}/send`, { waitUntil: "networkidle2" });

  const input = await send.waitForSelector("input[type=file]");
  await input.uploadFile(SRC);

  // Surface a server-side refusal (e.g. the per-IP rate limit, if the signal
  // suite just ran) instead of letting it look like a mystery timeout.
  await send.waitForSelector(".link-row input, .error", { timeout: 15000 });
  const refusal = await send.$(".error");
  if (refusal) {
    throw new Error(
      `sender was refused: ${await refusal.evaluate((el) => el.textContent)}`,
    );
  }
  const shareUrl = await send.$eval(".link-row input", (el) => el.value);
  check("sender produced a share URL", /\/r\/[0-9a-f-]{36}$/.test(shareUrl), shareUrl);

  const qrPresent = await send.$(".qr-frame svg");
  check("QR code rendered", !!qrPresent);

  const waitingText = await send.$eval(".status", (el) => el.textContent.trim());
  check("sender is waiting for receiver", /Waiting for receiver/.test(waitingText), waitingText);

  // ---- receiver tab
  const recv = await browser.newPage();
  recv.on("pageerror", (e) => log("  [receiver pageerror]", e.message));
  recv.on("console", (m) => { if (m.type() === "error") log("  [receiver console]", m.text()); });
  const cdp = await recv.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });

  await recv.goto(shareUrl, { waitUntil: "networkidle2" });
  await recv.waitForSelector(".file-name", { timeout: 15000 });
  const shown = await recv.$eval(".file-name", (el) => el.textContent);
  const shownSize = await recv.$eval(".file-size", (el) => el.textContent);
  check("receiver sees file name before accepting", shown.includes("payload.bin"), shown);
  check("receiver sees file size", /3\.0 MB/.test(shownSize), shownSize);

  const acceptBtn = await recv.waitForSelector(".btn.primary", { timeout: 10000 });
  await acceptBtn.click();

  // ---- watch it move
  await recv.waitForSelector(".meter", { timeout: 20000 });
  check("receiver entered transfer state", true);

  await recv.waitForFunction(
    () => document.querySelector("a.btn.primary")?.textContent?.includes("Save file"),
    { timeout: 60000 },
  );
  check("receiver reached completion screen", true);

  await send.waitForFunction(
    () => document.body.innerText.includes("delivered"),
    { timeout: 20000 },
  );
  const senderDone = await send.$eval(".file-line", (el) => el.innerText);
  check("sender got delivery confirmation", /delivered/.test(senderDone), senderDone.replace(/\n/g, " | "));

  // ---- verify the bytes
  let got = null;
  for (let i = 0; i < 60; i++) {
    const files = fs.readdirSync(DOWNLOADS).filter((f) => !f.endsWith(".crdownload"));
    if (files.length) { got = path.join(DOWNLOADS, files[0]); break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  check("file landed in downloads", !!got, got || fs.readdirSync(DOWNLOADS).join(","));
  if (got) {
    const buf = fs.readFileSync(got);
    check("size matches exactly", buf.length === SIZE, `${buf.length} vs ${SIZE}`);
    const h = crypto.createHash("sha256").update(buf).digest("hex");
    check("sha256 matches source", h === srcHash, `${h.slice(0, 16)}… vs ${srcHash.slice(0, 16)}…`);
  }

  // ---- session is single-use: a third tab gets nothing
  const third = await browser.newPage();
  await third.goto(shareUrl, { waitUntil: "networkidle2" });
  await third.waitForSelector(".error", { timeout: 15000 });
  const err = await third.$eval(".error", (el) => el.textContent);
  check("replaying the QR link fails", err.length > 0, err);
} catch (e) {
  failed = true;
  log("  ✗ threw:", e.message);
} finally {
  await browser.close();
}

log(failed ? "\nE2E FAILED" : "\nE2E PASSED");
process.exit(failed ? 1 : 0);
