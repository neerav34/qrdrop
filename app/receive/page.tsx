"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The QR encodes a full URL, but accept a bare session id too. */
function sessionFrom(text: string): string | null {
  const m = text.match(UUID_RE);
  return m ? m[0] : null;
}

export default function ReceivePage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let scanner: { stop: () => Promise<void>; clear: () => void } | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        const instance = new Html5Qrcode("qr-reader", { verbose: false });
        scanner = instance;
        await instance.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          (decoded: string) => {
            const id = sessionFrom(decoded);
            if (!id || cancelled) return;
            cancelled = true;
            instance.stop().catch(() => {});
            router.push(`/r/${id}`);
          },
          () => {
            /* per-frame "no code found" — not an error worth showing */
          },
        );
      } catch (e) {
        setError(
          window.isSecureContext
            ? "Could not open the camera. Allow camera access, or paste the link below."
            : "Camera needs HTTPS. Open this page over https (or use localhost), or paste the link below.",
        );
      }
    })();

    return () => {
      cancelled = true;
      scanner?.stop().then(() => scanner?.clear()).catch(() => {});
    };
  }, [router]);

  return (
    <main className="shell">
      <div className="panel">
        <Link className="back" href="/">
          ← Back
        </Link>
        <h2>Scan the sender&apos;s code</h2>

        {error ? <div className="error">{error}</div> : <div id="qr-reader" />}

        <div className="link-row">
          <input
            placeholder="…or paste the transfer link"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button
            className="btn"
            disabled={!sessionFrom(manual)}
            onClick={() => {
              const id = sessionFrom(manual);
              if (id) router.push(`/r/${id}`);
            }}
          >
            Go
          </button>
        </div>

        <p className="footnote">
          Your phone&apos;s built-in camera app works too — the code is just a link.
        </p>
      </div>
    </main>
  );
}
