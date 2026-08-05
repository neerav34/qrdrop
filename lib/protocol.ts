/** Shared vocabulary between the browser clients and the signaling server. */

export type DeviceKind = "phone" | "tablet" | "laptop";

export type DeviceInfo = {
  kind: DeviceKind;
  /** Human label for the UI, e.g. "iPhone" or "Windows laptop". */
  label: string;
};

export type FileMeta = {
  name: string;
  size: number;
  type: string;
};

/**
 * Which route the bytes actually took, read back off the negotiated ICE pair.
 * "host" on both ends means the two devices are talking over the local network
 * with nothing in between — no internet hop, no relay, no mobile data spent.
 */
export type LinkPath = {
  localType: string;
  remoteType: string;
  relayed: boolean;
};

export type SignalPayload =
  | { kind: "desc"; desc: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

/**
 * Data-channel control frames. Everything else on the wire is a binary chunk.
 *
 * The receiver drives resumption: on every fresh data channel it announces how
 * many bytes it already holds, and the sender seeks there before pumping. That
 * makes the first connection and a resume after a drop the same code path.
 */
export type ControlFrame =
  | { t: "resume"; from: number }
  | { t: "eof" }
  | { t: "ack" };

export const CHUNK_SIZE = 16 * 1024;
/** Pause the read loop once this much is queued in the SCTP send buffer. */
export const BUFFER_HIGH = 4 * 1024 * 1024;
export const BUFFER_LOW = 1 * 1024 * 1024;

/**
 * Above this size the receiver streams to a file on disk instead of buffering in
 * memory (where supported). Below it, a plain download avoids making the user
 * pick a save location for a file that arrives in two seconds.
 */
export const DISK_STREAM_THRESHOLD = 256 * 1024 * 1024;

/** Only meaningful when we cannot stream to disk — then RAM is the ceiling. */
export const MEMORY_WARN_THRESHOLD = 2 * 1024 * 1024 * 1024;

/** How long a client keeps trying to re-establish a dropped transfer. */
export const RESUME_WINDOW_MS = 120_000;

/**
 * Free hosting tiers idle their containers out, so the very first connection of
 * the day can take the better part of a minute while the signaling server boots.
 * Keep retrying for this many attempts before calling it unreachable — with
 * socket.io's backoff that's roughly 80 seconds.
 */
export const COLD_START_ATTEMPTS = 20;

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

export const SIGNAL_URL =
  process.env.NEXT_PUBLIC_SIGNAL_URL || "http://localhost:4000";
