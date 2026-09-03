/**
 * PWA installability and offline behaviour.
 *
 * Must run against a *production* server, because the service worker is
 * deliberately not registered in dev:
 *
 *   npm run build && npm run start   # in one terminal, on :3000
 *   npm run test:pwa
 *
 * Or point it anywhere: PWA_URL=https://qrdrop-seven.vercel.app npm run test:pwa
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.PWA_URL || process.env.E2E_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Width/height straight out of the PNG IHDR chunk. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage();

  // ------------------------------------------------------------- manifest
  const mres = await fetch(`${BASE}/manifest.webmanifest`);
  check("manifest is served", mres.ok, `HTTP ${mres.status}`);
  const manifest = await mres.json();
  check("has a name and short_name", !!manifest.name && !!manifest.short_name);
  check("start_url is set", manifest.start_url === "/", manifest.start_url);
  check("display is standalone", manifest.display === "standalone", manifest.display);

  // Share target: the declaration is the whole feature on the manifest side, and
  // a system share sheet cannot be driven from here — see the note at the end.
  const st = manifest.share_target || {};
  check("declares a share target", !!manifest.share_target);
  check("shares land on the send page", st.action === "/send", String(st.action));
  check(
    "by GET, which needs no service worker to read a body",
    (st.method || "GET").toUpperCase() === "GET",
    String(st.method),
  );
  check(
    "and it accepts all three fields a share sheet may send",
    st.params?.title === "title" && st.params?.text === "text" && st.params?.url === "url",
    JSON.stringify(st.params),
  );

  const sizes = (manifest.icons || []).map((i) => i.sizes);
  // Chrome will not offer to install without both of these.
  check("declares a 192x192 icon", sizes.includes("192x192"), sizes.join(" "));
  check("declares a 512x512 icon", sizes.includes("512x512"), sizes.join(" "));
  check(
    "declares a maskable icon",
    (manifest.icons || []).some((i) => (i.purpose || "").includes("maskable")),
    "Android crops non-maskable icons badly",
  );

  // ---------------------------------------------------------------- icons
  for (const icon of manifest.icons || []) {
    const res = await fetch(`${BASE}${icon.src}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dim = pngSize(buf);
    const [w, h] = icon.sizes.split("x").map(Number);
    check(
      `${icon.src} is a real PNG at ${icon.sizes}`,
      res.ok && dim && dim.w === w && dim.h === h,
      dim ? `${dim.w}x${dim.h}` : `HTTP ${res.status}`,
    );
  }

  const apple = await fetch(`${BASE}/apple-touch-icon.png`);
  check("apple-touch-icon is served for iOS", apple.ok, `HTTP ${apple.status}`);

  // ------------------------------------------------------- service worker
  await page.goto(BASE, { waitUntil: "networkidle2" });
  const swState = await page
    .evaluate(async () => {
      if (!("serviceWorker" in navigator)) return "unsupported";
      // Registration is deferred to window load, and activation takes a moment
      // after that, so wait for it rather than sampling once.
      let reg = null;
      for (let i = 0; i < 80; i++) {
        reg = await navigator.serviceWorker.getRegistration();
        if (reg?.active) return "active";
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!reg) return "none";
      return reg.installing ? "installing" : reg.waiting ? "waiting" : "unknown";
    })
    .catch((e) => `error: ${e.message}`);
  check(
    "a service worker registers and activates",
    swState === "active",
    swState === "none"
      ? "none registered — is this a production build? (npm run build && npm run start)"
      : swState,
  );

  // A share arriving is just a navigation with query parameters, so the half
  // that matters can be tested even though the share sheet cannot.
  await page.goto(
    `${BASE}/send?title=Example%20Domain&url=https%3A%2F%2Fexample.com%2F`,
    { waitUntil: "networkidle2" },
  );
  const shared = await page.evaluate(() => ({
    box: document.querySelector(".text-input")?.value ?? null,
    button: document.querySelector(".text-foot .btn")?.textContent?.trim() ?? null,
  }));
  check(
    "a shared page prefills the send box",
    shared.box === "https://example.com/",
    JSON.stringify(shared.box),
  );
  check(
    "as a link, so the receiver gets a working Open button",
    shared.button === "Send link",
    String(shared.button),
  );
  await page.goto(`${BASE}/send`, { waitUntil: "networkidle2" });
  check(
    "an ordinary visit still shows the file picker",
    !!(await page.$(".drop")) && !(await page.$(".text-input")),
  );

  // The manifest link has to be in the document, not just the file on disk.
  const linked = await page.$eval('link[rel="manifest"]', (el) => el.getAttribute("href"))
    .catch(() => null);
  check("the document links the manifest", !!linked, linked || "(no link tag)");

  // ------------------------------------------------------------- offline
  if (swState === "active") {
    // Give the shell a moment to be cached, then cut the network entirely.
    await sleep(1500);
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });

    let offlineOk = false;
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
      offlineOk = await page.evaluate(() =>
        document.body.innerText.includes("QRDrop") ||
        !!document.querySelector(".wordmark"),
      );
    } catch (e) {
      offlineOk = false;
    }
    check("the UI still opens with the network cut", offlineOk);

    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }

  // --------------------------------------------------- security headers
  {
    const res = await fetch(`${BASE}/send`);
    const h = (k) => res.headers.get(k) || "";
    check("nosniff is set", h("x-content-type-options") === "nosniff", h("x-content-type-options"));
    check(
      "the site cannot be framed",
      /frame-ancestors 'none'/.test(h("content-security-policy")) ||
        h("x-frame-options").toUpperCase() === "DENY",
      `${h("content-security-policy")} | ${h("x-frame-options")}`,
    );
    check(
      "a referrer policy is set",
      h("referrer-policy").length > 0,
      "the /r/<id> path is a bearer token; do not leak it in full",
    );
    // The camera must survive the policy, or the QR scanner silently dies.
    const pp = h("permissions-policy");
    check("permissions policy still allows the camera", /camera=\(self\)/.test(pp), pp);
    check("and denies the microphone", /microphone=\(\)/.test(pp), pp);
    check(
      "the CSP does not restrict scripts or styles",
      !/script-src|style-src|default-src/.test(h("content-security-policy")),
      "a strict policy here would break fonts and the socket; that is a separate change",
    );
  }

  // The scanner page must still be able to ask for the camera at all.
  {
    const page2 = await browser.newPage();
    await page2.goto(`${BASE}/receive`, { waitUntil: "networkidle2" });
    const usable = await page2.evaluate(
      () => typeof navigator.mediaDevices?.getUserMedia === "function",
    );
    check("getUserMedia is still reachable on /receive", usable);
    await page2.close();
  }

  // ------------------- the worker must never touch the signaling origin
  const swRaw = await (await fetch(`${BASE}/sw.js`)).text();
  const swSource = swRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check(
    "the worker ignores cross-origin requests",
    /url\.origin\s*!==\s*self\.location\.origin/.test(swSource),
    "signaling traffic must never be cached",
  );
  check(
    "navigations are network-first, not cache-first",
    /isNavigation/.test(swSource) && /await fetch\(req\)/.test(swSource),
    "a cached HTML shell pinned to old chunk hashes bricks the app",
  );
  check(
    "no skipWaiting, so a new build can't swap under a live transfer",
    !/skipWaiting\s*\(/.test(swSource),
    "checked against comment-stripped source",
  );
} catch (e) {
  failed = true;
  console.log("  ✗ threw:", e.message);
} finally {
  await browser.close();
}

console.log(failed ? "\nPWA FAILED" : "\nPWA PASSED");
process.exit(failed ? 1 : 0);
