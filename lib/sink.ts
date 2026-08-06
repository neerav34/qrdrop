"use client";

import type { FileMeta } from "./protocol";

/**
 * Where received bytes go. Small transfers accumulate in memory and become Blobs;
 * large ones stream straight to disk so a multi-gigabyte transfer isn't bounded by
 * how much the tab can hold.
 *
 * For a single large file that means one save dialog. For several, it means asking
 * once for a *folder* — the alternative is a save dialog per file, and only the
 * first one would have the user gesture it needs.
 */

type WritableFileStream = {
  write: (data: BufferSource) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

type SaveFileHandle = { createWritable: () => Promise<WritableFileStream> };

type DirectoryHandle = {
  name: string;
  getFileHandle: (
    name: string,
    opts?: { create?: boolean },
  ) => Promise<SaveFileHandle>;
};

type SavePicker = (opts: { suggestedName?: string }) => Promise<SaveFileHandle>;
type DirectoryPicker = (opts?: { mode?: string }) => Promise<DirectoryHandle>;

type PickerWindow = Window & {
  showSaveFilePicker?: SavePicker;
  showDirectoryPicker?: DirectoryPicker;
};

export type Sink = {
  /** True when bytes land on disk rather than in memory. */
  readonly toDisk: boolean;
  write: (chunk: ArrayBuffer) => void;
  /** Resolves once every queued write has landed. */
  drain: () => Promise<void>;
  /** Blob for the memory sink; null when the file is already on disk. */
  finish: () => Promise<Blob | null>;
  abort: () => void;
};

/** Produces one sink per incoming file. */
export type SinkFactory = {
  readonly toDisk: boolean;
  /** Where files are being written, for the UI to name. */
  readonly location: string | null;
  open: (meta: FileMeta) => Promise<Sink>;
};

export function diskStreamingAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as PickerWindow).showSaveFilePicker === "function"
  );
}

export function directoryPickerAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as PickerWindow).showDirectoryPicker === "function"
  );
}

/** Serialises writes through a promise chain; the channel already delivers in order. */
function streamSink(stream: WritableFileStream): Sink {
  let queue: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  return {
    toDisk: true,
    write(chunk) {
      queue = queue.then(() =>
        stream.write(chunk).catch((e) => {
          failure = failure ?? e;
        }),
      );
    },
    async drain() {
      await queue;
      if (failure) throw failure;
    },
    async finish() {
      await queue;
      if (failure) throw failure;
      await stream.close();
      return null;
    },
    abort() {
      void stream.abort?.().catch(() => {});
    },
  };
}

export function createMemorySink(type: string): Sink {
  let chunks: ArrayBuffer[] = [];
  return {
    toDisk: false,
    write(chunk) {
      chunks.push(chunk);
    },
    async drain() {},
    async finish() {
      const blob = new Blob(chunks, { type });
      chunks = [];
      return blob;
    },
    abort() {
      chunks = [];
    },
  };
}

export function memoryFactory(): SinkFactory {
  return {
    toDisk: false,
    location: null,
    async open(meta) {
      return createMemorySink(meta.type);
    },
  };
}

/**
 * One save dialog, for a single file. Must be called from a user gesture — the
 * browser will not open a picker otherwise. Throws if the user cancels.
 */
export async function singleFileFactory(name: string): Promise<SinkFactory> {
  const picker = (window as PickerWindow).showSaveFilePicker!;
  const handle = await picker({ suggestedName: name });
  let used = false;
  return {
    toDisk: true,
    location: name,
    async open() {
      if (used) throw new Error("single-file sink reused");
      used = true;
      return streamSink(await handle.createWritable());
    },
  };
}

/**
 * One folder dialog for the whole batch, then a file inside it per transfer. This
 * is the only workable shape for several large files: a save dialog per file would
 * need a fresh user gesture each time, and there isn't one mid-transfer.
 */
export async function directoryFactory(): Promise<SinkFactory> {
  const picker = (window as PickerWindow).showDirectoryPicker!;
  const dir = await picker({ mode: "readwrite" });
  return {
    toDisk: true,
    location: dir.name,
    async open(meta) {
      const handle = await dir.getFileHandle(safeName(meta.name), { create: true });
      return streamSink(await handle.createWritable());
    },
  };
}

/**
 * A sender could offer any name at all, and it is about to become a real path on
 * disk — strip separators and traversal before it gets there.
 */
export function safeName(name: string): string {
  // The control-character range is written with \u escapes on purpose: as
  // literal bytes it is invisible in an editor and reads like a space-to-"<"
  // range, which would mean something entirely different.
  const base = name.split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 200) || "file";
}
