"use client";

/**
 * Reading the route the bytes are actually taking off the live connection, so
 * the app can tell the user the truth about it — straight across the local
 * network, peer-to-peer over the internet, or out through a relay.
 *
 * Its own module for one reason: it is the only part of the transfer engine that
 * can be tested without a browser, a server or a peer, and it earned that after
 * a race here turned CI red in a way that looked like a service worker fault.
 * The engine itself imports extension-less paths that Node cannot resolve, so
 * anything testable in isolation has to live outside it.
 */

import type { LinkPath } from "./protocol";

/**
 * Keep asking for the route until it is known.
 *
 * A connection reporting itself "connected" does not guarantee the selected
 * candidate pair is in `getStats()` yet — nomination can land a moment later. A
 * single read therefore misses it sometimes, and because nothing retried, the
 * route line simply never appeared: most visible on a fast local transfer, where
 * the whole file can arrive before the stats settle.
 */
export async function reportPath(
  p: RTCPeerConnection,
  ok: () => boolean,
  emit: (path: LinkPath) => void,
): Promise<void> {
  for (let i = 0; i < 12; i++) {
    if (!ok()) return;
    const path = await readPath(p);
    if (path) {
      if (ok()) emit(path);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Read the negotiated ICE candidate pair back off the connection, so we can tell
 * the user (truthfully) whether the bytes are going straight across the local
 * network or out through a relay.
 */
export async function readPath(p: RTCPeerConnection): Promise<LinkPath | null> {
  let stats: RTCStatsReport;
  try {
    stats = await p.getStats();
  } catch {
    return null;
  }
  type Pair = {
    type: string;
    state?: string;
    nominated?: boolean;
    selected?: boolean;
    localCandidateId?: string;
    remoteCandidateId?: string;
  };
  let pair: Pair | null = null;
  stats.forEach((raw) => {
    const r = raw as Pair;
    if (r.type !== "candidate-pair") return;
    if (r.selected || (r.state === "succeeded" && r.nominated)) pair = r;
  });
  if (!pair) return null;
  const chosen: Pair = pair;
  const local = chosen.localCandidateId
    ? (stats.get(chosen.localCandidateId) as { candidateType?: string } | undefined)
    : undefined;
  const remote = chosen.remoteCandidateId
    ? (stats.get(chosen.remoteCandidateId) as { candidateType?: string } | undefined)
    : undefined;
  const localType = local?.candidateType ?? "unknown";
  const remoteType = remote?.candidateType ?? "unknown";
  return {
    localType,
    remoteType,
    relayed: localType === "relay" || remoteType === "relay",
  };
}
