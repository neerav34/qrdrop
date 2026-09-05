"use client";

/**
 * Somewhere for a half-received transfer to live while the page is not.
 *
 * Backgrounding a tab is survivable already; a reload is not, because received
 * bytes are held in the tab — a Blob being assembled in memory, or a file handle
 * that dies with the page. A phone that kills the tab, or a stray refresh, and
 * the whole transfer starts over. This is where those bytes go so they can be
 * picked back up.
 *
 * **This deliberately writes file contents to disk, and that is a change in what
 * the app stores about you, so it is kept as narrow as possible:**
 *
 *  - Only ever a transfer that has not finished. Completion deletes the record,
 *    and so does cancelling.
 *  - Kept for `PARTIAL_TTL_MS` and no longer, because resume stops being
 *    possible when the signalling server forgets the session anyway. Expired
 *    records are pruned on every load, not just when someone happens to look.
 *  - Nothing is uploaded. This is the same browser, the same device, and no
 *    server is involved in any of it.
 *
 * It stores the session id, which local history deliberately does not — resuming
 * means rejoining that exact session, so there is no way round it. The short
 * lifetime is what keeps that acceptable: the id is worthless once the server
 * has dropped the session.
 *
 * As with local history, every access is wrapped. IndexedDB is unavailable in
 * some private windows and can throw merely on being opened, and the failure
 * must degrade to "no resume after reload" rather than a broken page.
 */

import type { FileMeta } from "./protocol";

const DB_NAME = "qrdrop";
const DB_VERSION = 1;
/** Progress, one record per session. */
const META = "partials";
/** The bytes, in batches, keyed [sessionId, fileIndex, seq]. */
const CHUNKS = "chunks";

/**
 * How long a half-received transfer is kept.
 *
 * Fifteen minutes is not arbitrary: the signalling server holds a session open
 * for two minutes after a peer vanishes, so resume is impossible long before
 * this. The margin is for a slow reload, and the ceiling exists so nothing
 * lingers if a record is ever missed.
 */
export const PARTIAL_TTL_MS = 15 * 60_000;

/**
 * Bytes buffered before a write.
 *
 * The channel delivers 16 KB chunks. One IndexedDB record each would mean 6,400
 * records for a 100 MB file, so they are batched — which costs at most this much
 * memory and keeps the record count in the tens.
 */
export const CHUNK_BATCH_BYTES = 4 * 1024 * 1024;

export type PartialRecord = {
  sessionId: string;
  /** When it was last written to, for expiry. */
  at: number;
  manifest: FileMeta[];
  /** The file that was arriving. */
  index: number;
  /** Bytes of that file already stored — what the sender is asked to seek to. */
  received: number;
  peer: string | null;
};

function looksLikeRecord(v: unknown): v is PartialRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    r.sessionId.length > 0 &&
    typeof r.at === "number" &&
    Number.isFinite(r.at) &&
    Array.isArray(r.manifest) &&
    typeof r.index === "number" &&
    r.index >= 0 &&
    typeof r.received === "number" &&
    r.received >= 0 &&
    (r.peer === null || typeof r.peer === "string")
  );
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null); // blocked site data throws here
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: ["sessionId", "index", "seq"] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Another tab holding an old version open: give up rather than hang.
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** One transaction, resolved on completion rather than on the last request. */
function run<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch {
      return resolve(null);
    }
    let result: T | null = null;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    void Promise.resolve(body(tx)).then(
      (v) => {
        result = v ?? null;
      },
      () => {
        try {
          tx.abort();
        } catch {
          /* already gone */
        }
      },
    );
  });
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Every key from this session, whatever the file index or sequence number. */
function sessionRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId], [sessionId, []], false, false);
}

function fileRange(sessionId: string, index: number): IDBKeyRange {
  return IDBKeyRange.bound([sessionId, index], [sessionId, index, []], false, false);
}

/** Records progress. Called often, so it writes one small record and returns. */
export async function saveProgress(rec: PartialRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await run(db, [META], "readwrite", (tx) =>
    asPromise(tx.objectStore(META).put({ ...rec, at: Date.now() })),
  );
}

/** Appends one batch of bytes for a file. `seq` orders them on the way back. */
export async function appendChunk(
  sessionId: string,
  index: number,
  seq: number,
  blob: Blob,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await run(db, [CHUNKS], "readwrite", (tx) =>
    asPromise(tx.objectStore(CHUNKS).put({ sessionId, index, seq, blob })),
  );
}

export async function readProgress(sessionId: string): Promise<PartialRecord | null> {
  const db = await openDb();
  if (!db) return null;
  const rec = await run(db, [META], "readonly", (tx) =>
    asPromise(tx.objectStore(META).get(sessionId)),
  );
  return looksLikeRecord(rec) ? rec : null;
}

/**
 * The stored bytes of one file, in order.
 *
 * The order comes from the key, not from the sort below: records are keyed
 * `[sessionId, index, seq]` and `getAll` over a range returns them in key order.
 * Verified by deleting the sort — the ordering assertion still passed. It stays
 * as cheap insurance against a filtered or malformed row, but the compound key
 * is the thing actually holding sequence, so do not flatten it.
 */
export async function readChunks(sessionId: string, index: number): Promise<Blob[]> {
  const db = await openDb();
  if (!db) return [];
  const rows = await run(db, [CHUNKS], "readonly", (tx) =>
    asPromise(tx.objectStore(CHUNKS).getAll(fileRange(sessionId, index))),
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.seq === "number" && r.blob instanceof Blob)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.blob as Blob);
}

/** Forgets a session completely: progress and every byte stored for it. */
export async function dropSession(sessionId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await run(db, [META, CHUNKS], "readwrite", async (tx) => {
    await asPromise(tx.objectStore(META).delete(sessionId));
    await asPromise(tx.objectStore(CHUNKS).delete(sessionRange(sessionId)));
  });
}

/** Unexpired records, newest first. Malformed ones are ignored, not returned. */
export async function listPartials(now = Date.now()): Promise<PartialRecord[]> {
  const db = await openDb();
  if (!db) return [];
  const rows = await run(db, [META], "readonly", (tx) =>
    asPromise(tx.objectStore(META).getAll()),
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(looksLikeRecord)
    .filter((r) => now - r.at < PARTIAL_TTL_MS)
    .sort((a, b) => b.at - a.at);
}

/**
 * Deletes everything past its lifetime, and anything malformed while there.
 * Returns how many sessions went, which the tests assert on.
 */
export async function prune(now = Date.now()): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  const rows = await run(db, [META], "readonly", (tx) =>
    asPromise(tx.objectStore(META).getAll()),
  );
  if (!Array.isArray(rows)) return 0;
  const stale = rows.filter(
    (r) => !looksLikeRecord(r) || now - r.at >= PARTIAL_TTL_MS,
  );
  for (const r of stale) {
    const id = (r as { sessionId?: unknown }).sessionId;
    if (typeof id === "string" && id) await dropSession(id);
  }
  return stale.length;
}

/** Test hook only: the store is otherwise reached through the receiver. */
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (
    window as unknown as { __qrdropPartials?: Record<string, unknown> }
  ).__qrdropPartials = {
    saveProgress,
    appendChunk,
    readProgress,
    readChunks,
    dropSession,
    listPartials,
    prune,
    PARTIAL_TTL_MS,
  };
}
