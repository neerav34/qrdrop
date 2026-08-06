"use client";

/**
 * `?relay=1` forces the transfer through TURN instead of a direct path.
 *
 * A relay cannot be verified from a single network — the direct route always
 * wins, which is exactly what you want in normal use but means the relay stays
 * untested until the day it is the only option. This makes that case reachable
 * on demand, including from a real phone against the deployed site.
 *
 * It is visible in the UI whenever it is on, because it spends relay quota that
 * an ordinary transfer would not.
 */
export function relayForced(): boolean {
  if (typeof window === "undefined") return false;
  const v = new URLSearchParams(window.location.search).get("relay");
  return v === "1" || v === "true";
}
