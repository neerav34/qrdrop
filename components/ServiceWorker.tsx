"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, which is what makes the app installable and lets
 * the UI open offline. Production only — a caching layer in front of the dev
 * server is nothing but a source of confusing staleness.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () =>
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* an unregistered worker costs nothing but offline support */
      });
    // Registering after load keeps it off the critical path.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
