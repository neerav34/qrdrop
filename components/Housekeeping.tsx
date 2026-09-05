"use client";

import { useEffect } from "react";
import { prune } from "@/lib/partials";

/**
 * Renders nothing and exists to throw things away.
 *
 * A half-received transfer is kept on disk so a reload can pick it up, and the
 * one thing that must not happen is those records outliving their usefulness.
 * Resume stops being possible within minutes — the signalling server forgets the
 * session — so anything past its lifetime is dead weight holding onto someone's
 * file contents. Sweeping on app open means it goes without anyone having to
 * visit the right screen or press the right button.
 */
export default function Housekeeping() {
  useEffect(() => {
    void prune();
  }, []);
  return null;
}
