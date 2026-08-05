"use client";

import { useEffect, useState } from "react";

/** Warn before a reload or tab close would abandon a transfer in flight. */
export function useExitGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Browsers show their own wording; a non-empty returnValue is the signal.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}

/**
 * True once the page has been backgrounded during a transfer, so the UI can
 * explain what happened when the user comes back. The wake lock prevents most
 * of these, but not app-switching.
 */
export function useWasBackgrounded(active: boolean) {
  const [was, setWas] = useState(false);
  useEffect(() => {
    if (!active) {
      setWas(false);
      return;
    }
    const onChange = () => {
      if (document.visibilityState === "hidden") setWas(true);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [active]);
  return was;
}
