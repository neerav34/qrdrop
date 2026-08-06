"use client";

import { useEffect, useState } from "react";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * Chrome fires `beforeinstallprompt` only when the app actually meets the
 * install criteria, so this button appearing is itself the signal that the
 * manifest, icons and service worker are all in order. It renders nothing on
 * iOS, where installing is a Safari share-sheet action we cannot trigger.
 */
export default function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep it, so we can fire it from our own button
      setPrompt(e as InstallPrompt);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!prompt || hidden) return null;

  return (
    <button
      className="install-btn"
      onClick={async () => {
        await prompt.prompt();
        const { outcome } = await prompt.userChoice;
        if (outcome === "accepted") setHidden(true);
        setPrompt(null);
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      Add to home screen
    </button>
  );
}
