/**
 * Local transfer history — the failure modes, not the happy path.
 *
 *   npm run dev  (or npm run build && npm run start)
 *   npm run test:history
 *
 * Works against either server — nothing here depends on a development build. CI
 * runs it against the production one, which is why that was verified too.
 *
 * The happy path is covered by the browser transfer suite, which completes a real
 * transfer and checks it appears. What matters here is that history can never
 * damage a page that has nothing to do with it: the stored value is editable by
 * anyone, the storage API can throw merely on access, and the list must stay
 * capped however many records accumulate.
 *
 * Records are seeded directly into storage rather than by running dozens of
 * transfers, which keeps the suite quick and lets it test values a transfer could
 * never produce.
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.E2E_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KEY = "qrdrop.history.v1";
const LIMIT = 10;

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

const entry = (i, over = {}) => ({
  id: `seed-${i}`,
  at: Date.now() - i * 60_000,
  direction: i % 2 ? "sent" : "received",
  fileCount: 1,
  totalSize: 1024 * (i + 1),
  firstName: `seed-${i}.bin`,
  peer: "Mac",
  ...over,
});

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});

/** Seed storage, reload, and report what the home page renders. */
async function withStored(value, opts = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    (k, v, breakStorage) => {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
      if (breakStorage) {
        // Some browsers throw on any access when site data is blocked.
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get() {
            throw new Error("access denied");
          },
        });
      }
    },
    KEY,
    value,
    !!opts.breakStorage,
  );
  if (!opts.breakStorage) await page.reload({ waitUntil: "networkidle2" });
  else await page.evaluate(() => {});
  const state = await page.evaluate(() => ({
    rendered: !!document.querySelector(".recent"),
    rows: document.querySelectorAll(".recent-list li").length,
    names: [...document.querySelectorAll(".recent-name")].map((n) =>
      n.textContent.trim(),
    ),
    // Proof the rest of the page is unharmed.
    homeIntact: !!document.querySelector(".wordmark") && !!document.querySelector(".card-btn"),
  }));
  return { page, state, errors };
}

try {
  // -------------------------------------------------- nothing stored yet
  {
    const { page, state } = await withStored(null);
    check("a first-time visitor sees no history block at all", !state.rendered);
    check("and the home page is intact", state.homeIntact);
    await page.close();
  }

  // ------------------------------------------------ a couple of records
  {
    const { page, state } = await withStored(JSON.stringify([entry(0), entry(1)]));
    check("stored records are listed", state.rendered && state.rows === 2, `${state.rows} rows`);
    check(
      "newest first",
      state.names[0].startsWith("seed-0"),
      state.names.join(" | "),
    );
    await page.close();
  }

  // ------------------------------------------------------- over the cap
  {
    const many = Array.from({ length: 25 }, (_, i) => entry(i));
    const { page, state } = await withStored(JSON.stringify(many));
    check(
      `more records than the cap are trimmed to ${LIMIT}`,
      state.rows === LIMIT,
      `${state.rows} rows from 25 stored`,
    );
    await page.close();
  }

  // ------------------------------------------- junk that anyone could paste
  for (const [label, value] of [
    ["not JSON at all", "}}}not json{{{"],
    ["JSON but not an array", JSON.stringify({ nope: true })],
    ["an array of nonsense", JSON.stringify([1, "two", null, {}])],
    ["entries missing fields", JSON.stringify([{ id: "x" }, { at: "soon" }])],
    ["a hostile size", JSON.stringify([entry(0, { totalSize: -5 })])],
    ["a wrong direction", JSON.stringify([entry(0, { direction: "sideways" })])],
  ]) {
    const { page, state, errors } = await withStored(value);
    check(
      `survives ${label}`,
      state.homeIntact && errors.length === 0,
      errors.length ? errors[0] : `${state.rows} rows shown`,
    );
    await page.close();
  }

  // ------------------------------- one good record among the bad ones
  {
    const { page, state } = await withStored(
      JSON.stringify([entry(0), { id: "bad" }, 42, entry(1, { peer: null })]),
    );
    check(
      "keeps the valid records and drops the rest",
      state.rows === 2,
      `${state.rows} rows from 4 stored`,
    );
    await page.close();
  }

  // ------------------------------------------ storage that throws on access
  {
    const { page, state, errors } = await withStored(JSON.stringify([entry(0)]), {
      breakStorage: true,
    });
    check(
      "a storage accessor that throws does not break the page",
      state.homeIntact && errors.length === 0,
      errors.length ? errors[0] : "home page intact",
    );
    await page.close();
  }

  // ------------------------------------------------------------- clearing
  {
    const { page, state } = await withStored(JSON.stringify([entry(0), entry(1)]));
    check("records present before clearing", state.rows === 2);
    await page.click(".recent-clear");
    const after = await page.evaluate(() => ({
      rendered: !!document.querySelector(".recent"),
      stored: localStorage.getItem("qrdrop.history.v1"),
    }));
    check("Clear empties the list", !after.rendered);
    check("and removes it from storage", after.stored === null, String(after.stored));
    await page.reload({ waitUntil: "networkidle2" });
    const persisted = await page.evaluate(() => !!document.querySelector(".recent"));
    check("and it stays cleared after a reload", !persisted);
    await page.close();
  }
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  await browser.close();
}

console.log(failed ? "\nHISTORY FAILED" : "\nHISTORY PASSED");
process.exit(failed ? 1 : 0);
