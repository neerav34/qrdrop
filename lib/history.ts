"use client";

/**
 * A short local record of recent transfers: what moved, how big, which way, and
 * when. Names and sizes only — never file contents, and never the session id,
 * which is a bearer token and would be a small leak for no benefit.
 *
 * It lives in this browser and goes nowhere else. Nothing is sent to a server,
 * which is why the app can keep claiming it collects nothing about anyone.
 *
 * Two things make this fiddlier than it looks, and both are handled here rather
 * than at the call sites:
 *
 *  - `localStorage` is not always available. Private windows, blocked site data
 *    and thumbnail capture can make even *reading* the accessor throw, so every
 *    access is wrapped and every failure degrades to "no history" rather than a
 *    broken page.
 *  - Two tabs can lose each other's records. `localStorage` looks synchronous
 *    but is not shared synchronously across tabs in separate renderer
 *    processes: each has a cache that syncs a few milliseconds later. Measured
 *    here — one tab wrote the key and the other read it as empty 3ms after,
 *    then wrote over it. So a write re-checks itself shortly afterwards and
 *    merges its entry back in if a stale snapshot buried it.
 *  - The stored value is user-editable. Anyone can put junk under this key, so
 *    it is validated entry by entry on read and anything malformed is dropped —
 *    a corrupt record must never take the home page down with it.
 */

/** Bumped if the shape changes, so old records are ignored instead of misread. */
const KEY = "qrdrop.history.v1";

/** Small on purpose: this is a convenience, not an archive. */
export const HISTORY_LIMIT = 10;

export type HistoryEntry = {
  id: string;
  /** Epoch milliseconds. */
  at: number;
  direction: "sent" | "received";
  fileCount: number;
  totalSize: number;
  /** First filename, for display. The rest are summarised by count. */
  firstName: string;
  /** The other device's label, when it was known. */
  peer: string | null;
};

/**
 * When a write re-checks that its entry survived. Two passes: the first covers
 * the ordinary cross-tab lag, the second a slow one.
 */
const HEAL_DELAYS = [120, 600];

/** Injectable so tests need no real timers. */
export type Schedule = (fn: () => void, ms: number) => void;

const defaultSchedule: Schedule = (fn, ms) => {
  if (typeof setTimeout === "function") setTimeout(fn, ms);
};

/** Just the parts of Storage used here, so tests can supply a fake. */
export type StorageLike = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
};

function defaultStore(): StorageLike | null {
  try {
    // Touching `localStorage` at all can throw when site data is blocked.
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function looksLikeEntry(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    (e.direction === "sent" || e.direction === "received") &&
    typeof e.fileCount === "number" &&
    Number.isFinite(e.fileCount) &&
    e.fileCount >= 0 &&
    typeof e.totalSize === "number" &&
    Number.isFinite(e.totalSize) &&
    e.totalSize >= 0 &&
    typeof e.firstName === "string" &&
    (e.peer === null || typeof e.peer === "string")
  );
}

export function readHistory(store: StorageLike | null = defaultStore()): HistoryEntry[] {
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(looksLikeEntry)
      // Trust the file for order as little as the rest of it.
      .sort((a, b) => b.at - a.at)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Folds one entry into whatever the store currently holds, newest first. Reading
 * at write time is what makes a concurrent writer's snapshot survivable.
 */
function mergeEntry(entry: HistoryEntry, store: StorageLike | null): HistoryEntry[] {
  const next = [entry, ...readHistory(store).filter((e) => e.id !== entry.id)]
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_LIMIT);
  if (store) {
    try {
      store.setItem(KEY, JSON.stringify(next));
    } catch {
      // A full or read-only store costs us the record, nothing more.
    }
  }
  return next;
}

export function addHistory(
  entry: Omit<HistoryEntry, "id" | "at">,
  store: StorageLike | null = defaultStore(),
  schedule: Schedule = defaultSchedule,
): HistoryEntry[] {
  const full: HistoryEntry = {
    ...entry,
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Math.random()),
    at: Date.now(),
  };
  const next = mergeEntry(full, store);

  // Another tab may since have written a snapshot taken before ours landed.
  if (store) {
    for (const ms of HEAL_DELAYS) {
      schedule(() => {
        if (!readHistory(store).some((e) => e.id === full.id)) {
          mergeEntry(full, store);
        }
      }, ms);
    }
  }
  return next;
}

export function clearHistory(store: StorageLike | null = defaultStore()): void {
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    /* nothing sensible to do */
  }
}

/** Exposed so a test can seed and inspect the same key the app uses. */
export const HISTORY_KEY = KEY;
