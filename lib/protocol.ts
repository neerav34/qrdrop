/** Shared vocabulary between the browser clients and the signaling server. */

export type FileMeta = {
  name: string;
  size: number;
  type: string;
};

export type SignalPayload =
  | { kind: "desc"; desc: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

/** Data-channel control frames. Everything else on the wire is a binary chunk. */
export type ControlFrame =
  | { t: "begin"; meta: FileMeta }
  | { t: "eof" }
  | { t: "ack" };

export const CHUNK_SIZE = 16 * 1024;
/** Pause the read loop once this much is queued in the SCTP send buffer. */
export const BUFFER_HIGH = 4 * 1024 * 1024;
export const BUFFER_LOW = 1 * 1024 * 1024;

/** Receiver holds the whole file in memory before saving it — keep the ceiling honest. */
export const SOFT_SIZE_LIMIT = 2 * 1024 * 1024 * 1024;

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

export const SIGNAL_URL =
  process.env.NEXT_PUBLIC_SIGNAL_URL || "http://localhost:4000";
