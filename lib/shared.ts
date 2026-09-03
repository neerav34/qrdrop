"use client";

/**
 * Being on the receiving end of another app's share sheet.
 *
 * An installed QRDrop registers as a share target, so "Share → QRDrop" from a
 * browser, a notes app or a chat lands here with the shared text as query
 * parameters. It arrives prefilled in the send box rather than sent
 * automatically: what leaves this device should be something the person saw
 * first.
 *
 * Share sheets are not consistent about which field holds what, which is the
 * only reason this file exists.
 */

/** Whatever a share sheet chose to send. Any of them may be missing. */
export type SharedInput = {
  title?: string | null;
  text?: string | null;
  url?: string | null;
};

/**
 * Folds a share into one snippet.
 *
 * `title` is deliberately dropped whenever there is anything else, and this is
 * the decision worth explaining. Sharing a page from Chrome on Android sends
 * both the page title and its URL; joining them would produce two lines, which
 * is no longer a bare URL, so the receiver would see prose with no button to
 * open it. Dropping the title keeps a shared page a link — which is the thing
 * being shared. It is kept only when it is all that arrived.
 */
export function composeShared({ title, text, url }: SharedInput): string {
  const t = (text ?? "").trim();
  const u = (url ?? "").trim();
  const ti = (title ?? "").trim();

  // Apps that put the link inside the text as well — don't say it twice.
  if (t && u) return t.includes(u) ? t : `${t}\n${u}`;
  if (u) return u;
  if (t) return t;
  return ti;
}

/**
 * Reads a share off the current URL, or "" if this is an ordinary visit.
 *
 * Reads `window.location` rather than a router hook, as the relay flag does:
 * one pattern for query parameters in this app, and no Suspense boundary needed
 * around the page for it.
 */
export function sharedFromLocation(): string {
  if (typeof window === "undefined") return "";
  const q = new URLSearchParams(window.location.search);
  return composeShared({
    title: q.get("title"),
    text: q.get("text"),
    url: q.get("url"),
  });
}
