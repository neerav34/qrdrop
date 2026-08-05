"use client";

import { useEffect } from "react";
import { SIGNAL_URL } from "@/lib/protocol";

/**
 * Nudge the signaling server awake as soon as any page loads.
 *
 * Free hosting tiers idle containers out after a few minutes, and the wake-up
 * costs 30–60 seconds. Firing this on page load means the server is booting
 * while the user is still choosing a file, so the wait usually lands somewhere
 * they aren't watching a spinner. `no-cors` because we don't need the response —
 * only the fact that the request arrived.
 */
export default function Prewarm() {
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${SIGNAL_URL}/healthz`, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    }).catch(() => {
      /* it's a nudge, not a dependency */
    });
    return () => controller.abort();
  }, []);
  return null;
}
