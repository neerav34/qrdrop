"use client";

/**
 * Where received bytes go. Small files accumulate in memory and become a Blob;
 * large ones stream straight to a file on disk so a 4 GB transfer isn't bounded
 * by how much the tab can hold.
 */

type WritableFileStream = {
  write: (data: BufferSource) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

type SaveFileHandle = {
  createWritable: () => Promise<WritableFileStream>;
};

type SavePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

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

export function diskStreamingAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showSaveFilePicker?: SavePicker })
      .showSaveFilePicker === "function"
  );
}

/**
 * Must be called from a user gesture (the Accept click) — the browser will not
 * open a save dialog otherwise. Throws if the user cancels.
 */
export async function createDiskSink(name: string): Promise<Sink> {
  const picker = (window as unknown as { showSaveFilePicker: SavePicker })
    .showSaveFilePicker;
  const handle = await picker({ suggestedName: name });
  const stream = await handle.createWritable();

  // Writes are serialised through a promise chain: the data channel delivers in
  // order, and this preserves that order without blocking the message handler.
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
