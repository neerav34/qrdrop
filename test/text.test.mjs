/**
 * Text and link sharing — the boundary cases only.
 *
 *   npm run test:text      (no server, no browser — imports the real module)
 *
 * Most of this is small enough to be obvious. `safeExternalUrl` is not: it
 * decides whether content that arrived from another device gets rendered as
 * something clickable, which is the one place this feature could do real harm.
 * A `javascript:` URL clicked in this page runs in this page's origin, and a
 * `file:` URL points at the receiver's own disk, so the check is a scheme
 * allow-list rather than a blocklist of the schemes anyone thought to name.
 *
 * Measured while checking this suite can fail: with the scheme checks removed,
 * `javascript:`, `data:` and `file:` are still refused, because those URLs have
 * no hostname and a separate check rejects that. `intent://example.com` is the
 * one case that passes every other check, so it is the assertion that actually
 * holds the allow-list in place. It is not filler.
 */
import {
  TEXT_MAX_BYTES,
  TEXT_TYPE,
  isTextPayload,
  safeExternalUrl,
  textBytes,
  textFileName,
  textToFile,
} from "../lib/text.ts";

let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed = true;
};

console.log("\n▸ wrapping text as a file");
{
  const f = textToFile("hello there");
  check("it is a real File the sender can carry", f instanceof File && f.size === 11);
  check("declared as plain text", f.type === TEXT_TYPE, f.type);
  check("named for a note", f.name === "note.txt", f.name);
  check("and for a link when that is what it is", textFileName("https://example.com") === "link.txt");
  check(
    "multi-byte characters are counted as bytes, not characters",
    textBytes("héllo — 😀") === new TextEncoder().encode("héllo — 😀").length &&
      textToFile("😀").size === 4,
    `${textBytes("héllo — 😀")} bytes`,
  );
}

console.log("\n▸ deciding what to show as text");
{
  check("plain text is shown", isTextPayload({ type: "text/plain", size: 20 }));
  check(
    "a charset parameter is still plain text",
    isTextPayload({ type: "text/plain;charset=utf-8", size: 20 }),
  );
  check("an image is not", !isTextPayload({ type: "image/png", size: 20 }));
  check("nor is HTML, which must never be rendered", !isTextPayload({ type: "text/html", size: 20 }));
  check("nor a file with no type at all", !isTextPayload({ type: "", size: 20 }));
  check("at the size limit, still shown", isTextPayload({ type: "text/plain", size: TEXT_MAX_BYTES }));
  check("one byte over, saved instead", !isTextPayload({ type: "text/plain", size: TEXT_MAX_BYTES + 1 }));
}

console.log("\n▸ what may become a clickable link");
{
  check("https", safeExternalUrl("https://example.com/x?y=1") === "https://example.com/x?y=1");
  check("http", safeExternalUrl("http://example.com/") === "http://example.com/");
  check("surrounding whitespace is trimmed", safeExternalUrl("  https://example.com  ") === "https://example.com/");
  check("uppercase scheme still works", !!safeExternalUrl("HTTPS://example.com"));

  // The refusals are the point of this function.
  for (const [label, value] of [
    ["javascript:", "javascript:alert(document.cookie)"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["the receiver's own disk", "file:///etc/passwd"],
    ["a scheme-relative URL", "//example.com/x"],
    ["an app scheme", "intent://example.com#Intent;scheme=https;end"],
    ["a bare hostname, which would be a guess", "example.com"],
    ["a sentence containing a link", "look at https://example.com"],
    ["plain prose", "call me back"],
    ["nothing at all", "   "],
    ["a newline hiding a second line", "https://example.com\njavascript:alert(1)"],
  ]) {
    check(`refuses ${label}`, safeExternalUrl(value) === null, JSON.stringify(value.slice(0, 40)));
  }
}

console.log(failed ? "\nTEXT FAILED" : "\nTEXT PASSED");
process.exit(failed ? 1 : 0);
