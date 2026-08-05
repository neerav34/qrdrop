"use client";

import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { startSender, type Progress, type SenderHandle, type SenderStatus } from "@/lib/peer";
import { SOFT_SIZE_LIMIT } from "@/lib/protocol";
import { bytes, clock, eta, rate } from "@/lib/format";

export default function SendPage() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<SenderStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [left, setLeft] = useState<number>(0);
  const [progress, setProgress] = useState<Progress>({ moved: 0, total: 0, bps: 0 });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);

  const handle = useRef<SenderHandle | null>(null);
  const startedAt = useRef<number>(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => () => handle.current?.close(), []);

  // Countdown on the QR code's validity window.
  useEffect(() => {
    if (!expiresAt || status === "sending" || status === "done") return;
    const tick = () => setLeft(Math.max(0, expiresAt - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt, status]);

  useEffect(() => {
    if (status === "sending" && !startedAt.current) startedAt.current = performance.now();
    if (status === "done" && startedAt.current && elapsed === null) {
      setElapsed((performance.now() - startedAt.current) / 1000);
    }
  }, [status, elapsed]);

  const begin = useCallback((f: File) => {
    setError(null);
    setFile(f);
    setProgress({ moved: 0, total: f.size, bps: 0 });
    handle.current = startSender(f, {
      onSession: (id, exp) => {
        setSessionId(id);
        setExpiresAt(exp);
      },
      onStatus: setStatus,
      onProgress: setProgress,
      onError: setError,
    });
  }, []);

  function reset() {
    handle.current?.close();
    handle.current = null;
    startedAt.current = 0;
    setFile(null);
    setSessionId(null);
    setExpiresAt(0);
    setStatus("connecting");
    setProgress({ moved: 0, total: 0, bps: 0 });
    setError(null);
    setElapsed(null);
  }

  const shareUrl = sessionId && origin ? `${origin}/r/${sessionId}` : "";
  const pct = progress.total ? Math.floor((progress.moved / progress.total) * 100) : 0;

  // ---------------------------------------------------------------- picker
  if (!file) {
    return (
      <main className="shell">
        <div className="panel">
          <Link className="back" href="/">
            ← Back
          </Link>
          <h2>Pick a file to send</h2>
          <div
            className={dragging ? "drop over" : "drop"}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) begin(f);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") input.current?.click();
            }}
          >
            Tap to choose a file
            <br />
            or drop one here
          </div>
          <input
            ref={input}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) begin(f);
            }}
          />
          <p className="footnote">
            Any file type. Both devices stay on the page until the transfer finishes.
          </p>
        </div>
      </main>
    );
  }

  // ------------------------------------------------------------- completed
  if (status === "done") {
    return (
      <main className="shell">
        <div className="panel">
          <div className="tick">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m4 12.5 5 5L20 6.5" />
            </svg>
          </div>
          <div className="file-line">
            <div className="file-name">{file.name} delivered</div>
            <div className="file-size">
              {bytes(file.size)}
              {elapsed !== null ? ` in ${elapsed.toFixed(1)} seconds` : ""}
            </div>
          </div>
          <button className="btn primary" onClick={reset}>
            Send another file
          </button>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------- transfer
  return (
    <main className="shell">
      <div className="panel">
        <button className="back" onClick={reset}>
          ← Back
        </button>

        <div className="file-line">
          <div className="file-name">{file.name}</div>
          <div className="file-size">{bytes(file.size)}</div>
        </div>

        {error && <div className="error">{error}</div>}

        {status === "sending" ? (
          <>
            <div className="pct">{pct}%</div>
            <div className="meter">
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="stats">
              <span>{rate(progress.bps)}</span>
              <span>{eta(progress.total - progress.moved, progress.bps)}</span>
            </div>
            <div className="status">
              <span className="spinner" /> Sending…
            </div>
          </>
        ) : (
          <>
            {shareUrl ? (
              <div className="qr-frame">
                <QRCodeSVG value={shareUrl} size={232} level="M" marginSize={0} />
              </div>
            ) : (
              <div className="status">
                <span className="spinner" /> Preparing session…
              </div>
            )}

            {shareUrl && (
              <>
                <div className="status">
                  <span className="spinner" />
                  {status === "linking" ? "Connecting to receiver…" : "Waiting for receiver…"}
                </div>
                {left > 0 && (
                  <div className="footnote">QR expires in {clock(left)}</div>
                )}
                <div className="link-row">
                  <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(shareUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                      } catch {
                        setCopied(false);
                      }
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="warn">
                  Only show this code to the person you are sending to. Anyone who
                  scans it first gets the file.
                </div>
              </>
            )}

            {file.size > SOFT_SIZE_LIMIT && (
              <div className="warn">
                This file is over {bytes(SOFT_SIZE_LIMIT)}. The receiving browser
                buffers the whole file in memory, so very large transfers may fail
                on phones.
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
