"use client";

import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DeviceLink, { type LinkState } from "@/components/DeviceLink";
import { describeDevice } from "@/lib/device";
import { bytes, clock, eta, pathLabel, rate } from "@/lib/format";
import { useExitGuard } from "@/lib/hooks";
import { relayForced } from "@/lib/relayFlag";
import { formatPin, generatePin } from "@/lib/pin";
import {
  startSender,
  type Progress,
  type SenderHandle,
  type SenderStatus,
} from "@/lib/peer";
import {
  DISK_STREAM_THRESHOLD,
  MEMORY_WARN_THRESHOLD,
  type DeviceInfo,
  type LinkPath,
} from "@/lib/protocol";

/** Keep in step with --qr-size in globals.css, which the scan line travels. */
const QR_SIZE = 216;

const LINK_STATE: Record<SenderStatus, LinkState> = {
  connecting: "idle",
  waiting: "idle",
  linking: "linking",
  sending: "moving",
  paused: "paused",
  done: "done",
};

export default function SendPage() {
  const [files, setFiles] = useState<File[] | null>(null);
  const [status, setStatus] = useState<SenderStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [left, setLeft] = useState(0);
  const [progress, setProgress] = useState<Progress>({
    moved: 0,
    total: 0,
    bps: 0,
    index: 0,
    fileCount: 0,
  });
  const [peer, setPeer] = useState<DeviceInfo | null>(null);
  const [path, setPath] = useState<LinkPath | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  const [me, setMe] = useState<DeviceInfo | null>(null);
  const [forceRelay, setForceRelay] = useState(false);
  const [requirePin, setRequirePin] = useState(false);
  const [pin, setPin] = useState<string | null>(null);
  const [pinAttempt, setPinAttempt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const handle = useRef<SenderHandle | null>(null);
  const startedAt = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    setMe(describeDevice());
    setForceRelay(relayForced());
  }, []);

  useEffect(() => () => handle.current?.close(), []);

  useExitGuard(status === "sending" || status === "paused" || status === "linking");

  // Countdown on the QR code's validity window.
  useEffect(() => {
    if (!expiresAt || status !== "waiting") return;
    const tick = () => setLeft(Math.max(0, expiresAt - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt, status]);

  useEffect(() => {
    if (status === "sending" && !startedAt.current) {
      startedAt.current = performance.now();
    }
    if (status === "done" && startedAt.current && elapsed === null) {
      setElapsed((performance.now() - startedAt.current) / 1000);
    }
  }, [status, elapsed]);

  const begin = useCallback((picked: File[]) => {
    if (!picked.length) return;
    setError(null);
    setNotice(null);
    setFiles(picked);
    setProgress({
      moved: 0,
      total: picked.reduce((n, f) => n + f.size, 0),
      bps: 0,
      index: 0,
      fileCount: picked.length,
    });
    // Generated here rather than in the engine, so the value on screen is
    // provably the one that was hashed.
    const usePin = requirePin ? generatePin() : null;
    setPin(usePin);
    setPinAttempt(null);
    handle.current = startSender(picked, {
      onSession: (id, exp) => {
        setSessionId(id);
        setExpiresAt(exp);
      },
      onStatus: setStatus,
      onProgress: setProgress,
      onPeer: setPeer,
      onPath: setPath,
      onNotice: setNotice,
      onPinAttempt: setPinAttempt,
      onError: setError,
    },
    { forceRelay: relayForced(), pin: usePin ?? undefined });
  }, [requirePin]);

  function reset(announce = false) {
    // A deliberate cancel must be told to the peer; otherwise they wait out the
    // whole resume window for someone who has already walked away.
    if (announce) handle.current?.cancel();
    else handle.current?.close();
    handle.current = null;
    startedAt.current = 0;
    setFiles(null);
    setSessionId(null);
    setExpiresAt(0);
    setStatus("connecting");
    setProgress({ moved: 0, total: 0, bps: 0, index: 0, fileCount: 0 });
    setPeer(null);
    setPath(null);
    setNotice(null);
    setError(null);
    setElapsed(null);
    setPin(null);
    setPinAttempt(null);
  }

  const totalSize = files ? files.reduce((n, f) => n + f.size, 0) : 0;
  const shareUrl =
    sessionId && origin
      ? `${origin}/r/${sessionId}${forceRelay ? "?relay=1" : ""}`
      : "";
  const pct = progress.total
    ? Math.floor((progress.moved / progress.total) * 100)
    : 0;
  const linkPct = status === "done" ? 100 : pct;
  const linkState = LINK_STATE[status];

  const pair = useMemo(
    () => ({
      from: { device: me, you: true },
      to: { device: peer, you: false },
    }),
    [me, peer],
  );

  // ---------------------------------------------------------------- picker
  if (!files) {
    return (
      <main className="shell">
        <div className="panel">
          <div className="topbar">
            <Link className="back" href="/">
              ← Back
            </Link>
          </div>
          <h2>Pick files to send</h2>
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
              begin(Array.from(e.dataTransfer.files || []));
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") input.current?.click();
            }}
          >
            <strong>Choose files</strong>
            or drop them here
          </div>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => begin(Array.from(e.target.files || []))}
          />
          <label className="toggle">
            <input
              type="checkbox"
              checked={requirePin}
              onChange={(e) => setRequirePin(e.target.checked)}
            />
            <span className="toggle-track" aria-hidden />
            <span>
              Require a PIN
              <small>
                The receiver must enter a code you read out. Until they do, they
                cannot even see what you are sending.
              </small>
            </span>
          </label>

          <p className="footnote">
            Any file type, any size, as many as you like. Both devices stay on
            the page until the transfer finishes — if one drops out, it picks up
            from the file and byte it stopped at.
          </p>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------- transfer
  return (
    <main className="shell">
      <div className="panel">
        <div className="topbar">
          <button
            className="back"
            onClick={() => reset(status !== "done")}
          >
            ← {status === "done" ? "Send another" : "Cancel"}
          </button>
        </div>

        <div className="card">
          <DeviceLink
            from={pair.from}
            to={pair.to}
            state={linkState}
            pct={linkPct}
          />

          <div className="file-line">
            <div className="file-name">
              {files.length === 1
                ? files[0].name
                : status === "sending"
                  ? files[progress.index]?.name ?? `${files.length} files`
                  : `${files.length} files`}
            </div>
            <div className="file-size">
              {status === "done"
                ? `${bytes(totalSize)} delivered${
                    elapsed !== null ? ` in ${elapsed.toFixed(1)}s` : ""
                  }`
                : status === "sending" && files.length > 1
                  ? `file ${progress.index + 1} of ${files.length} · ${bytes(totalSize)} total`
                  : bytes(totalSize)}
            </div>
          </div>

          {forceRelay && (
            <div className="notice warn">
              <span className="notice-dot" />
              Forcing the TURN relay (<code>?relay=1</code>). This spends relay
              quota — drop the parameter for normal transfers.
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

          {status === "sending" && (
            <>
              <div className="pct">{pct}%</div>
              <div className="stats">
                <span>{rate(progress.bps)}</span>
                <span>{eta(progress.total - progress.moved, progress.bps)}</span>
              </div>
              {path && <div className="pathline">{pathLabel(path)}</div>}
            </>
          )}

          {status === "linking" && !notice && (
            <div className="status">
              <span className="spinner" /> Opening a direct connection…
            </div>
          )}

          {status === "waiting" && !error && (
            <>
              {shareUrl ? (
                <div className="qr-frame">
                  <QRCodeSVG value={shareUrl} size={QR_SIZE} level="M" marginSize={0} />
                </div>
              ) : (
                <div className="status">
                  <span className="spinner" /> Preparing session…
                </div>
              )}
              <div className="status">
                <span className="spinner" /> Waiting for someone to scan
              </div>
              {pin && (
                <div className="pinbox">
                  <div className="pinbox-label">Tell them this PIN</div>
                  <div className="pinbox-digits">{formatPin(pin)}</div>
                </div>
              )}
              {pinAttempt !== null && (
                <div className="notice warn">
                  <span className="notice-dot" />
                  Someone entered the wrong PIN — {pinAttempt}{" "}
                  {pinAttempt === 1 ? "try" : "tries"} left before this transfer is
                  cancelled. If that was not your recipient, cancel and start again.
                </div>
              )}
              {left > 0 && <div className="countdown">Code expires in {clock(left)}</div>}
            </>
          )}

          {status === "done" && path && (
            <div className="pathline">{pathLabel(path)} · never touched a server</div>
          )}

          {status === "done" && (
            <button className="btn primary wide" onClick={() => reset(false)}>
              Send another file
            </button>
          )}
        </div>

        {status === "waiting" && shareUrl && (
          <>
            <div className="link-row">
              <input
                readOnly
                value={shareUrl}
                aria-label="Transfer link"
                onFocus={(e) => e.currentTarget.select()}
              />
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
            <p className="footnote">
              {pin
                ? "Safe to paste into a chat — the code is useless without the PIN, and the PIN should travel some other way (say it out loud)."
                : "Only show this code to the person you are sending to — whoever scans it first gets the file. Or paste the link into a chat."}
            </p>
            {totalSize > MEMORY_WARN_THRESHOLD && (
              <div className="notice warn">
                <span className="notice-dot" />
                This file is over {bytes(MEMORY_WARN_THRESHOLD)}. Files above{" "}
                {bytes(DISK_STREAM_THRESHOLD)} are written straight to disk on
                desktop Chrome, but a phone receiving this may run out of memory.
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
