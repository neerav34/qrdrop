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
  type ReceivedFile,
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

type Saved = ReceivedFile & { url: string | null };

export default function Receiver({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<ReceiverStatus>("connecting");
  const [manifest, setManifest] = useState<FileMeta[] | null>(null);
  const [progress, setProgress] = useState<Progress>({
    moved: 0,
    total: 0,
    bps: 0,
    index: 0,
    fileCount: 0,
  });
  const [peer, setPeer] = useState<DeviceInfo | null>(null);
  const [me, setMe] = useState<DeviceInfo | null>(null);
  const [target, setTarget] = useState<{
    kind: "disk" | "memory";
    location: string | null;
  }>({ kind: "memory", location: null });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [complete, setComplete] = useState(false);

  const handle = useRef<ReceiverHandle | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => setMe(describeDevice()), []);

  useExitGuard(status === "receiving" || status === "paused" || status === "linking");

  useEffect(() => {
    handle.current = startReceiver(
      sessionId,
      {
        onManifest: setManifest,
        onStatus: setStatus,
        onProgress: setProgress,
        onPeer: setPeer,
        onTarget: (kind, location) => setTarget({ kind, location }),
        onNotice: setNotice,
        onError: setError,
        onFile: (file) => {
          if (!file.blob) {
            // Already written to the folder the user chose.
            setSaved((prev) => [...prev, { ...file, url: null }]);
            return;
          }
          const url = URL.createObjectURL(file.blob);
          urls.current.push(url);
          setSaved((prev) => [...prev, { ...file, url }]);
          // Offer it straight away. Browsers may block the second and later
          // automatic downloads in a batch, which is why the list below always
          // keeps an explicit Save button for every file.
          const a = document.createElement("a");
          a.href = url;
          a.download = file.meta.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        },
        onDone: () => setComplete(true),
      },
      { forceRelay: relayForced() },
    );
    return () => {
      handle.current?.close();
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    };
  }, [sessionId]);

  const pct = progress.total
    ? Math.floor((progress.moved / progress.total) * 100)
    : 0;
  const linkState: LinkState = complete ? "done" : LINK_STATE[status];
  const from = { device: peer, you: false };
  const to = { device: me, you: true };
  const count = manifest?.length ?? 0;
  const totalSize = manifest?.reduce((n, f) => n + f.size, 0) ?? 0;

  // Fatal before anything arrived — offer a way back rather than a dead end.
  if (error && !saved.length) {
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

  const fileList = manifest && count > 1 && (
    <ul className="filelist">
      {manifest.map((f, i) => {
        const done = saved.some((s) => s.index === i);
        const active = !done && status === "receiving" && i === progress.index;
        const entry = saved.find((s) => s.index === i);
        return (
          <li key={`${i}-${f.name}`} data-state={done ? "done" : active ? "active" : "pending"}>
            <span className="filelist-mark" aria-hidden>
              {done ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m4 12.5 5 5L20 6.5" />
                </svg>
              ) : active ? (
                <span className="spinner" />
              ) : null}
            </span>
            <span className="filelist-name">{f.name}</span>
            <span className="filelist-size">{bytes(f.size)}</span>
            {entry?.url && (
              <a className="filelist-save" href={entry.url} download={f.name}>
                Save
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );

  if (complete) {
    const downloadable = saved.filter((s) => s.url);
    return (
      <main className="shell">
        <div className="panel">
          <div className="card">
            <DeviceLink from={from} to={to} state="done" pct={100} />
            <div className="tick">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path className="draw" d="m4 12.5 5 5L20 6.5" />
              </svg>
            </div>
            <div className="file-line">
              <div className="file-name">
                {count === 1 ? saved[0]?.meta.name : `${count} files received`}
              </div>
              <div className="file-size">
                {bytes(totalSize)} ·{" "}
                {target.kind === "disk"
                  ? `saved to ${target.location ?? "your chosen location"}`
                  : "transfer complete"}
              </div>
            </div>

            {fileList}

            {target.kind === "disk" ? (
              <div className="notice good">
                <span className="notice-dot" />
                Written straight to disk as it arrived — nothing was held in memory.
              </div>
            ) : (
              <>
                {downloadable.length === 1 && downloadable[0].url && (
                  <a
                    className="btn primary wide"
                    href={downloadable[0].url}
                    download={downloadable[0].meta.name}
                  >
                    Save file
                  </a>
                )}
                <p className="footnote">
                  {downloadable.length > 1
                    ? "Your browser may have asked before saving several files at once. Use the Save links above for anything it skipped."
                    : "If your browser did not save it automatically, use the button above."}{" "}
                  Leaving this page discards anything unsaved.
                </p>
              </>
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

          {manifest ? (
            <div className="file-line">
              <div className="file-name">
                {count === 1
                  ? manifest[0].name
                  : status === "receiving"
                    ? manifest[progress.index]?.name ?? `${count} files`
                    : `${count} files`}
              </div>
              <div className="file-size">
                {count > 1 && status === "receiving"
                  ? `file ${progress.index + 1} of ${count} · ${bytes(totalSize)} total`
                  : bytes(totalSize)}
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
              {fileList}
              <button
                className="btn primary wide"
                onClick={() => void handle.current?.accept()}
              >
                Accept &amp; receive
              </button>
              <p className="footnote">
                Only accept files from someone you trust. They come straight from{" "}
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
              {fileList}
              {target.kind === "disk" && (
                <div className="notice">
                  <span className="notice-dot" />
                  Streaming straight to {target.location ?? "disk"}, so size
                  isn&apos;t limited by memory.
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
