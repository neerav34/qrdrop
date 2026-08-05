"use client";

import type { DeviceInfo, DeviceKind } from "@/lib/protocol";

export type LinkState = "idle" | "linking" | "moving" | "paused" | "done";

export type LinkNode = {
  device: DeviceInfo | null;
  /** Renders the "you" chip so it's obvious which end is this device. */
  you?: boolean;
};

function Glyph({ kind, ghost }: { kind: DeviceKind; ghost: boolean }) {
  const stroke = ghost ? "var(--line-ghost)" : "currentColor";
  const dash = ghost ? "4 4" : undefined;

  if (kind === "phone") {
    return (
      <svg width="34" height="52" viewBox="0 0 34 52" fill="none" aria-hidden>
        <rect
          x="1.25"
          y="1.25"
          width="31.5"
          height="49.5"
          rx="6"
          stroke={stroke}
          strokeWidth="2"
          strokeDasharray={dash}
        />
        <path d="M13 6h8" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "tablet") {
    return (
      <svg width="42" height="54" viewBox="0 0 42 54" fill="none" aria-hidden>
        <rect
          x="1.25"
          y="1.25"
          width="39.5"
          height="51.5"
          rx="5"
          stroke={stroke}
          strokeWidth="2"
          strokeDasharray={dash}
        />
        <circle cx="21" cy="47" r="1.6" fill={stroke} />
      </svg>
    );
  }

  return (
    <svg width="60" height="46" viewBox="0 0 60 46" fill="none" aria-hidden>
      <rect
        x="7.25"
        y="3.25"
        width="45.5"
        height="30.5"
        rx="3.5"
        stroke={stroke}
        strokeWidth="2"
        strokeDasharray={dash}
      />
      <path
        d="M2 39h56l-3.5 4H5.5z"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeDasharray={dash}
      />
    </svg>
  );
}

function Node({
  node,
  state,
  labels,
}: {
  node: LinkNode;
  state: LinkState;
  labels: boolean;
}) {
  const ghost = !node.device;
  const kind = node.device?.kind ?? "phone";
  const label = node.device?.label ?? "waiting";

  return (
    <div className="dl-node" data-ghost={ghost || undefined}>
      <div className="dl-glyph" data-state={state}>
        <Glyph kind={kind} ghost={ghost} />
      </div>
      {labels && (
        <div className="dl-label">
          {label}
          {node.you && <span className="dl-you">you</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The pair of devices and the channel between them. `from` and `to` are in the
 * direction the file travels, so the flow always animates left to right and each
 * page just decides which end is the local one.
 */
export default function DeviceLink({
  from,
  to,
  state,
  pct = 0,
  labels = true,
}: {
  from: LinkNode;
  to: LinkNode;
  state: LinkState;
  pct?: number;
  /** Off for the decorative version on the home page. */
  labels?: boolean;
}) {
  const described =
    state === "moving"
      ? `Sending to ${to.device?.label ?? "receiver"}, ${Math.floor(pct)} percent`
      : state === "done"
        ? "Transfer complete"
        : state === "paused"
          ? "Transfer paused, waiting to resume"
          : state === "linking"
            ? "Connecting"
            : "Waiting for the other device";

  return (
    <div className="dl" role="img" aria-label={described}>
      <Node key={`from-${from.device?.label ?? "ghost"}`} node={from} state={state} labels={labels} />
      <div className="dl-wire" data-state={state}>
        <span className="dl-track" />
        <span className="dl-fill" style={{ width: `${Math.min(100, pct)}%` }} />
        {state === "moving" &&
          [0, 0.45, 0.9].map((delay) => (
            <span
              key={delay}
              className="dl-pkt"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
        {state === "done" && (
          <span className="dl-badge" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
              <path className="draw" d="m4 12.5 5 5L20 6.5" />
            </svg>
          </span>
        )}
        {state === "paused" && <span className="dl-badge dl-badge-warn" aria-hidden />}
      </div>
      <Node key={`to-${to.device?.label ?? "ghost"}`} node={to} state={state} labels={labels} />
    </div>
  );
}
