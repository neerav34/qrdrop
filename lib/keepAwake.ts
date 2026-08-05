"use client";

/**
 * Holds a screen wake lock for the duration of a transfer, so the phone doesn't
 * sleep mid-file and stall the data channel.
 *
 * A lock can only be taken while the page is visible, and the browser drops it
 * automatically when the page is hidden — so we re-take it whenever we come
 * back. Unsupported browsers degrade to nothing, which is why the caller still
 * needs the "keep this page open" messaging.
 */

type WakeLockSentinel = { released: boolean; release: () => Promise<void> };
type WakeLockAPI = { request: (type: "screen") => Promise<WakeLockSentinel> };

function api(): WakeLockAPI | null {
  if (typeof navigator === "undefined") return null;
  const wl = (navigator as Navigator & { wakeLock?: WakeLockAPI }).wakeLock;
  return wl ?? null;
}

export function wakeLockSupported(): boolean {
  return api() !== null;
}

export type KeepAwake = { release: () => void };

export function keepAwake(): KeepAwake {
  const wl = api();
  let sentinel: WakeLockSentinel | null = null;
  let released = false;

  const take = async () => {
    if (released || !wl || document.visibilityState !== "visible") return;
    try {
      sentinel = await wl.request("screen");
    } catch {
      // Denied (often a low-battery mode). Nothing to do but carry on.
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) {
      void take();
    }
  };

  void take();
  document.addEventListener("visibilitychange", onVisibility);

  return {
    release() {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    },
  };
}
