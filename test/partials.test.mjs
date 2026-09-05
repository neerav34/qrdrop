/**
 * The store a half-received transfer lives in while the page does not.
 *
 *   npm run dev
 *   npm run test:partials
 *
 * Needs a development build: the store is reached through a hook that
 * production strips, since nothing else would have any business calling it.
 *
 * The assertion this suite exists for is that bytes written before a reload are
 * readable, byte-for-byte, after one. Everything else here is about the store
 * refusing to become a place where someone's file contents quietly accumulate:
 * a session dropped on demand, expired records swept without anyone asking, and
 * a malformed record ignored rather than trusted or thrown over.
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.E2E_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});

/** A page with the store reachable, and nothing left over from a previous run. */
async function freshPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message.split("\n")[0]));
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__qrdropPartials, { timeout: 15000 });
  await page.evaluate(async () => {
    for (const r of await window.__qrdropPartials.listPartials(0)) {
      await window.__qrdropPartials.dropSession(r.sessionId);
    }
    // listPartials(0) hides nothing, but expired records still need clearing.
    await window.__qrdropPartials.prune(Number.MAX_SAFE_INTEGER);
  });
  return page;
}

const record = (id, over = {}) => ({
  sessionId: id,
  at: Date.now(),
  manifest: [{ name: "holiday.mp4", size: 1024, type: "video/mp4" }],
  index: 0,
  received: 512,
  peer: "iPhone",
  ...over,
});

try {
  // --------------------------------------------------------------- progress
  console.log("\n▸ progress");
  {
    const page = await freshPage();
    const out = await page.evaluate(async (rec) => {
      const s = window.__qrdropPartials;
      await s.saveProgress(rec);
      const read = await s.readProgress(rec.sessionId);
      return { read, missing: await s.readProgress("no-such-session") };
    }, record("s-progress"));
    check(
      "a record round-trips",
      out.read?.sessionId === "s-progress" && out.read?.received === 512,
      JSON.stringify(out.read),
    );
    check(
      "the manifest survives with it",
      out.read?.manifest?.[0]?.name === "holiday.mp4",
      JSON.stringify(out.read?.manifest),
    );
    check("an unknown session reads as nothing", out.missing === null);
    await page.close();
  }

  // ----------------------------------------------------------------- bytes
  console.log("\n▸ bytes");
  {
    const page = await freshPage();
    const out = await page.evaluate(async () => {
      const s = window.__qrdropPartials;
      const enc = new TextEncoder();
      // Written out of order on purpose: the sequence number is what orders them.
      // Note this passes even with the store's sort removed, because the records
      // are keyed [sessionId, index, seq] and IndexedDB returns key order. It is
      // the key that guarantees this, and this is the check that would notice if
      // the key were ever flattened.
      await s.appendChunk("s-bytes", 0, 2, new Blob([enc.encode("ccc")]));
      await s.appendChunk("s-bytes", 0, 0, new Blob([enc.encode("aaa")]));
      await s.appendChunk("s-bytes", 0, 1, new Blob([enc.encode("bbb")]));
      // A second file in the same session must not be mixed in.
      await s.appendChunk("s-bytes", 1, 0, new Blob([enc.encode("zzz")]));
      const first = await s.readChunks("s-bytes", 0);
      const second = await s.readChunks("s-bytes", 1);
      return {
        first: await new Blob(first).text(),
        second: await new Blob(second).text(),
        empty: (await s.readChunks("s-bytes", 7)).length,
      };
    });
    check("batches come back in sequence order", out.first === "aaabbbccc", out.first);
    check("a second file stays separate", out.second === "zzz", out.second);
    check("a file with nothing stored reads as empty", out.empty === 0, String(out.empty));
    await page.close();
  }

  // ---------------------------------------------------------- across a reload
  console.log("\n▸ across a reload — the reason this exists");
  {
    const page = await freshPage();
    const written = await page.evaluate(async () => {
      const s = window.__qrdropPartials;
      // 6 MB in two batches, which is the shape a real transfer writes.
      // getRandomValues refuses more than 64 KB at a time, hence the blocks.
      const noise = (n) => {
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i += 65536) {
          crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
        }
        return out;
      };
      const a = noise(3 * 1024 * 1024);
      const b = noise(3 * 1024 * 1024);
      await s.appendChunk("s-reload", 0, 0, new Blob([a]));
      await s.appendChunk("s-reload", 0, 1, new Blob([b]));
      await s.saveProgress({
        sessionId: "s-reload",
        at: Date.now(),
        manifest: [{ name: "big.bin", size: 9 * 1024 * 1024, type: "" }],
        index: 0,
        received: 6 * 1024 * 1024,
        peer: "Mac",
      });
      const digest = await crypto.subtle.digest("SHA-256", await new Blob([a, b]).arrayBuffer());
      return {
        hash: [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join(""),
        size: 6 * 1024 * 1024,
      };
    });

    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForFunction(() => !!window.__qrdropPartials, { timeout: 15000 });

    const after = await page.evaluate(async () => {
      const s = window.__qrdropPartials;
      const chunks = await s.readChunks("s-reload", 0);
      const blob = new Blob(chunks);
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return {
        progress: await s.readProgress("s-reload"),
        size: blob.size,
        hash: [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join(""),
      };
    });
    check(
      "progress is still there after the page died",
      after.progress?.received === 6 * 1024 * 1024,
      JSON.stringify(after.progress?.received),
    );
    check("and all the bytes are", after.size === written.size, `${after.size} of ${written.size}`);
    check(
      "byte-for-byte identical",
      after.hash === written.hash,
      `${after.hash.slice(0, 16)}… vs ${written.hash.slice(0, 16)}…`,
    );
    await page.close();
  }

  // -------------------------------------------------------------- forgetting
  console.log("\n▸ forgetting, which matters more than remembering");
  {
    const page = await freshPage();
    const out = await page.evaluate(async () => {
      const s = window.__qrdropPartials;
      const mk = async (id) => {
        await s.saveProgress({
          sessionId: id,
          at: Date.now(),
          manifest: [],
          index: 0,
          received: 1,
          peer: null,
        });
        await s.appendChunk(id, 0, 0, new Blob(["x".repeat(64)]));
      };
      await mk("s-keep");
      await mk("s-go");
      await s.dropSession("s-go");
      return {
        goneProgress: await s.readProgress("s-go"),
        goneBytes: (await s.readChunks("s-go", 0)).length,
        keptProgress: !!(await s.readProgress("s-keep")),
        keptBytes: (await s.readChunks("s-keep", 0)).length,
      };
    });
    check("a dropped session leaves no progress", out.goneProgress === null);
    check("and no bytes", out.goneBytes === 0, `${out.goneBytes} batches`);
    check("while another session is untouched", out.keptProgress && out.keptBytes === 1);
    await page.close();
  }

  // ------------------------------------------------------------------ expiry
  console.log("\n▸ expiry");
  {
    const page = await freshPage();
    const out = await page.evaluate(async () => {
      const s = window.__qrdropPartials;
      const ttl = s.PARTIAL_TTL_MS;
      const now = Date.now();
      const mk = async (id, at) => {
        await s.saveProgress({ sessionId: id, at, manifest: [], index: 0, received: 1, peer: null });
        await s.appendChunk(id, 0, 0, new Blob(["y".repeat(32)]));
      };
      // saveProgress stamps its own `at`, so age them by moving `now` instead.
      await mk("s-recent", now);
      await mk("s-old", now);
      const future = now + ttl + 60_000;
      return {
        listedNow: (await s.listPartials(now)).map((r) => r.sessionId).sort(),
        listedLater: (await s.listPartials(future)).map((r) => r.sessionId),
        pruned: await s.prune(future),
        leftAfterPrune: (await s.listPartials(now)).length,
        bytesAfterPrune: (await s.readChunks("s-old", 0)).length,
        ttlMinutes: ttl / 60000,
      };
    });
    check(
      "fresh records are listed",
      out.listedNow.includes("s-recent") && out.listedNow.includes("s-old"),
      out.listedNow.join(", "),
    );
    check(
      "past their lifetime they are not",
      out.listedLater.length === 0,
      `${out.listedLater.length} listed`,
    );
    check("pruning removes them", out.pruned === 2, `${out.pruned} swept`);
    check("leaving nothing behind", out.leftAfterPrune === 0 && out.bytesAfterPrune === 0);
    check(
      "the lifetime is short, because resume dies with the session",
      out.ttlMinutes <= 15,
      `${out.ttlMinutes} minutes`,
    );
    await page.close();
  }

  // ------------------------------------------------------------- bad records
  console.log("\n▸ a record that makes no sense");
  {
    const page = await freshPage();
    const out = await page.evaluate(async () => {
      const s = window.__qrdropPartials;
      // Straight into the store, bypassing every check the app would apply.
      await new Promise((resolve) => {
        const req = indexedDB.open("qrdrop", 1);
        req.onsuccess = () => {
          const tx = req.result.transaction(["partials"], "readwrite");
          tx.objectStore("partials").put({ sessionId: "s-bad", at: "not a number" });
          tx.objectStore("partials").put({ sessionId: "s-bad-2", at: Date.now(), received: -5 });
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
        req.onerror = () => resolve();
      });
      const read = await s.readProgress("s-bad");
      const listed = (await s.listPartials()).map((r) => r.sessionId);
      const pruned = await s.prune();
      return { read, listed, pruned };
    });
    check("it does not read back as a record", out.read === null, JSON.stringify(out.read));
    check("it is not listed", !out.listed.includes("s-bad"), out.listed.join(", ") || "(none)");
    check("a negative byte count is refused too", !out.listed.includes("s-bad-2"));
    check("and pruning clears them out", out.pruned >= 2, `${out.pruned} swept`);
    await page.close();
  }
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  await browser.close();
}

console.log(failed ? "\nPARTIALS FAILED" : "\nPARTIALS PASSED");
process.exit(failed ? 1 : 0);
