"use client";

/**
 * Sending a snippet of text or a link, without inventing a second transfer path.
 *
 * The text is wrapped in a file and sent through the same engine as everything
 * else — same chunking, same resume, same encryption — and the receiver notices
 * that what arrived is small and plain text, and shows it instead of saving it.
 * No protocol change: `FileMeta.type` already carries the MIME type.
 *
 * The one genuinely delicate part is offering to *open* a received link, since
 * the text came from another device and is not to be trusted. See
 * `safeExternalUrl`.
 */

import type { FileMeta } from "./protocol";

export const TEXT_TYPE = "text/plain";

/**
 * A snippet, not a document. Anything longer is better sent as a file, and this
 * keeps a pasted novel from being rendered into the page as one paragraph.
 */
export const TEXT_MAX_BYTES = 64 * 1024;

/** Named for what it is, so it reads sensibly if the receiver saves it. */
export function textFileName(text: string): string {
  return safeExternalUrl(text) ? "link.txt" : "note.txt";
}

/** Wraps typed text as a file the existing sender can carry unchanged. */
export function textToFile(text: string): File {
  return new File([text], textFileName(text), {
    type: TEXT_TYPE,
    lastModified: Date.now(),
  });
}

/** Whether a received payload should be shown as text rather than saved. */
export function isTextPayload(meta: Pick<FileMeta, "type" | "size">): boolean {
  return (
    typeof meta.type === "string" &&
    meta.type.startsWith("text/plain") &&
    meta.size <= TEXT_MAX_BYTES
  );
}

/**
 * The href to offer for received text, or null to offer nothing.
 *
 * This is the only place received content becomes something clickable, so it is
 * deliberately narrow: an explicit http or https scheme and nothing else. That
 * rules out `javascript:` and `data:` URLs, which would run in this page's
 * origin if a user could be persuaded to click one, and `file:` URLs pointing at
 * the receiver's own disk.
 *
 * Text without a scheme — "example.com" — still transfers perfectly and is shown
 * as text; it simply gets no button. Guessing that a dotted word is a hostname
 * means guessing wrong sometimes, and the wrong guess here is an inviting button
 * that goes somewhere nobody chose.
 *
 * The three checks below overlap, and it is worth knowing which one earns its
 * place. Removing both scheme checks and re-running the suite refuses
 * `javascript:`, `data:` and `file:` anyway — those URLs have no hostname, so the
 * hostname check catches them by accident. Only `intent://example.com` survives
 * that, which makes the protocol allow-list the check actually doing the security
 * work. Do not rely on the accident.
 */
export function safeExternalUrl(raw: string): string | null {
  const text = raw.trim();
  // A URL cannot contain whitespace, and this rejects "look at https://x.example"
  // rather than silently linking the tail of a sentence.
  if (!text || /\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Bytes a string will occupy once encoded, for the length counter. */
export function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
