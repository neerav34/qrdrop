"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  startReceiver,
  type Progress,
  type ReceiverHandle,
  type ReceiverStatus,
} from "@/lib/peer";
import type { FileMeta } from "@/lib/protocol";
import { bytes, eta, rate } from "@/lib/format";

export default function Receiver({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<ReceiverStatus>("connecting");
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [progress, setProgress] = useState<Progress>({ moved: 0, total: 0, bps: 0 });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ url: string; name: string } | null>(null);

  const handle = useRef<ReceiverHandle | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    handle.current = startReceiver(sessionId, {
      onMeta: setMeta,
      onStatus: setStatus,
      onProgress: setProgress,
      onDone: (blob, m) => {
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setSaved({ url, name: m.name });
        // Kick off the browser's own save flow; the button below is the fallback.
        const a = document.createElement("a");
        a.href = url;
        a.download = m.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
      onError: setError,
    });
    return () => {
      handle.current?.close();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [sessionId]);

  const pct = progress.total ? Math.floor((progress.moved / progress.total) * 100) : 0;

  if (error) {
    return (
      <main className="shell">
        <div className="panel">
          <div className="error">{error}</div>
          <Link className="btn" href="/">
            Back to start
          </Link>
        </div>
      </main>
    );
  }

  if (saved) {
    return (
      <main className="shell">
        <div className="panel">
          <div className="tick">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m4 12.5 5 5L20 6.5" />
            </svg>
          </div>
          <div className="file-line">
            <div className="file-name">{saved.name}</div>
            <div className="file-size">Transfer complete</div>
          </div>
          <a className="btn primary" href={saved.url} download={saved.name}>
            Save file
          </a>
          <p className="footnote">
            If your browser did not save it automatically, use the button above.
            Leaving this page discards the file.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="panel">
        {meta ? (
          <div className="file-line">
            <div className="file-name">{meta.name}</div>
            <div className="file-size">
              {bytes(meta.size)}
              {meta.type ? ` · ${meta.type}` : ""}
            </div>
          </div>
        ) : (
          <div className="status">
            <span className="spinner" /> Looking up the transfer…
          </div>
        )}

        {status === "offered" && (
          <>
            <button className="btn primary" onClick={() => handle.current?.accept()}>
              Accept & receive
            </button>
            <p className="footnote">
              Only accept files from someone you trust. The file comes straight
              from the sender&apos;s device.
            </p>
          </>
        )}

        {status === "linking" && (
          <div className="status">
            <span className="spinner" /> Connecting to sender…
          </div>
        )}

        {status === "receiving" && (
          <>
            <div className="pct">{pct}%</div>
            <div className="meter">
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="stats">
              <span>{rate(progress.bps)}</span>
              <span>{eta(progress.total - progress.moved, progress.bps)}</span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
