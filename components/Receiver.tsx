"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import DeviceLink, { type LinkState } from "@/components/DeviceLink";
import { describeDevice } from "@/lib/device";
import { bytes, eta, rate } from "@/lib/format";
import { useExitGuard } from "@/lib/hooks";
import { relayForced } from "@/lib/relayFlag";
import {
  startReceiver,
  type Progress,
  type ReceiverHandle,
  type ReceiverStatus,
} from "@/lib/peer";
import type { DeviceInfo, FileMeta } from "@/lib/protocol";

const LINK_STATE: Record<ReceiverStatus, LinkState> = {
  connecting: "idle",
  offered: "idle",
  linking: "linking",
  receiving: "moving",
  paused: "paused",
  done: "done",
};

export default function Receiver({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<ReceiverStatus>("connecting");
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [progress, setProgress] = useState<Progress>({ moved: 0, total: 0, bps: 0 });
  const [peer, setPeer] = useState<DeviceInfo | null>(null);
  const [me, setMe] = useState<DeviceInfo | null>(null);
  const [target, setTarget] = useState<"disk" | "memory">("memory");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ url: string | null; name: string } | null>(
    null,
  );

  const handle = useRef<ReceiverHandle | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => setMe(describeDevice()), []);

  useExitGuard(status === "receiving" || status === "paused" || status === "linking");

  useEffect(() => {
    handle.current = startReceiver(sessionId, {
      onMeta: setMeta,
      onStatus: setStatus,
      onProgress: setProgress,
      onPeer: setPeer,
      onTarget: setTarget,
      onNotice: setNotice,
      onError: setError,
      onDone: (blob, m) => {
        if (!blob) {
          // Already streamed to the file the user picked — nothing to download.
          setSaved({ url: null, name: m.name });
          return;
        }
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
    },
    { forceRelay: relayForced() });
    return () => {
      handle.current?.close();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [sessionId]);

  const pct = progress.total
    ? Math.floor((progress.moved / progress.total) * 100)
    : 0;
  const linkState: LinkState = saved ? "done" : LINK_STATE[status];
  const from = { device: peer, you: false };
  const to = { device: me, you: true };

  // Fatal, with nothing received — offer a way back rather than a dead end.
  if (error && !saved) {
    return (
      <main className="shell">
        <div className="panel">
          <div className="card">
            <DeviceLink from={from} to={to} state="paused" pct={pct} />
            <div className="notice bad">
              <span className="notice-dot" />
              {error}
            </div>
            <Link className="btn wide" href="/">
              Back to start
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (saved) {
    return (
      <main className="shell">
        <div className="panel">
          <div className="card">
            <DeviceLink from={from} to={to} state="done" pct={100} />
            <div className="tick">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m4 12.5 5 5L20 6.5" />
              </svg>
            </div>
            <div className="file-line">
              <div className="file-name">{saved.name}</div>
              <div className="file-size">
                {meta ? `${bytes(meta.size)} · ` : ""}
                {saved.url ? "transfer complete" : "saved to your chosen location"}
              </div>
            </div>
            {saved.url ? (
              <>
                <a className="btn primary wide" href={saved.url} download={saved.name}>
                  Save file
                </a>
                <p className="footnote">
                  If your browser did not save it automatically, use the button
                  above. Leaving this page discards the file.
                </p>
              </>
            ) : (
              <div className="notice good">
                <span className="notice-dot" />
                Written straight to disk as it arrived — nothing was held in memory.
              </div>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="panel">
        <div className="card">
          <DeviceLink from={from} to={to} state={linkState} pct={pct} />

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

          {error && (
            <div className="notice bad">
              <span className="notice-dot" />
              {error}
            </div>
          )}

          {!error && notice && (
            <div className="notice warn">
              <span className="notice-dot" />
              {notice}
            </div>
          )}

          {status === "offered" && (
            <>
              <button
                className="btn primary wide"
                onClick={() => void handle.current?.accept()}
              >
                Accept &amp; receive
              </button>
              <p className="footnote">
                Only accept files from someone you trust. It comes straight from{" "}
                {peer?.label ? `their ${peer.label}` : "their device"}, not from a
                server.
              </p>
            </>
          )}

          {status === "linking" && !notice && (
            <div className="status">
              <span className="spinner" /> Opening a direct connection…
            </div>
          )}

          {status === "receiving" && (
            <>
              <div className="pct">{pct}%</div>
              <div className="stats">
                <span>{rate(progress.bps)}</span>
                <span>{eta(progress.total - progress.moved, progress.bps)}</span>
              </div>
              {target === "disk" && (
                <div className="notice">
                  <span className="notice-dot" />
                  Streaming straight to the file you chose, so size isn&apos;t
                  limited by memory.
                </div>
              )}
            </>
          )}
        </div>

        {(status === "receiving" || status === "paused") && (
          <p className="footnote">
            Keep this page open. Your screen is held awake, but switching apps can
            still pause the transfer — it resumes from where it stopped.
          </p>
        )}
      </div>
    </main>
  );
}
