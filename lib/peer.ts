"use client";

import { io, type Socket } from "socket.io-client";
import {
  BUFFER_HIGH,
  BUFFER_LOW,
  CHUNK_SIZE,
  ICE_SERVERS,
  SIGNAL_URL,
  type ControlFrame,
  type FileMeta,
  type SignalPayload,
} from "./protocol";

export type Progress = { moved: number; total: number; bps: number };

/** Exponential moving average of throughput, so the readout doesn't jitter. */
function makeRateMeter() {
  let lastAt = 0;
  let lastBytes = 0;
  let bps = 0;
  return (moved: number, now: number) => {
    if (!lastAt) {
      lastAt = now;
      lastBytes = moved;
      return 0;
    }
    const dt = (now - lastAt) / 1000;
    if (dt >= 0.25) {
      const sample = (moved - lastBytes) / dt;
      bps = bps === 0 ? sample : bps * 0.7 + sample * 0.3;
      lastAt = now;
      lastBytes = moved;
    }
    return bps;
  };
}

function attachIce(
  pc: RTCPeerConnection,
  socket: Socket,
  pending: RTCIceCandidateInit[],
) {
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal", {
        kind: "candidate",
        candidate: e.candidate.toJSON(),
      } satisfies SignalPayload);
    }
  };
  return async function drain() {
    while (pending.length) {
      const c = pending.shift()!;
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* a stale candidate is not fatal — ICE retries other paths */
      }
    }
  };
}

// ---------------------------------------------------------------- sender

export type SenderStatus =
  | "connecting"
  | "waiting"
  | "linking"
  | "sending"
  | "done";

export type SenderHandle = { close: () => void };

export function startSender(
  file: File,
  cb: {
    onSession: (sessionId: string, expiresAt: number) => void;
    onStatus: (s: SenderStatus) => void;
    onProgress: (p: Progress) => void;
    onError: (msg: string) => void;
  },
): SenderHandle {
  const socket: Socket = io(SIGNAL_URL, { transports: ["websocket", "polling"] });
  const meta: FileMeta = {
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
  };

  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let closed = false;
  const pendingCandidates: RTCIceCandidateInit[] = [];

  cb.onStatus("connecting");

  socket.on("connect_error", () =>
    cb.onError(
      `Can't reach the signaling server at ${SIGNAL_URL}. Is it running?`,
    ),
  );

  socket.on("connect", () => {
    socket.emit(
      "create",
      meta,
      (res: { sessionId?: string; expiresAt?: number; error?: string }) => {
        if (res.error || !res.sessionId) {
          cb.onError(res.error || "Could not create a session.");
          return;
        }
        cb.onSession(res.sessionId, res.expiresAt ?? Date.now() + 600_000);
        cb.onStatus("waiting");
      },
    );
  });

  socket.on("expired", () => {
    if (!closed) cb.onError("This QR code expired. Start a new transfer.");
  });
  socket.on("peer-gone", () => {
    if (!closed) cb.onError("The receiver disconnected before the file finished.");
  });

  socket.on("receiver-ready", async () => {
    cb.onStatus("linking");
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    attachIce(pc, socket, pendingCandidates);

    pc.onconnectionstatechange = () => {
      if (!closed && (pc?.connectionState === "failed" || pc?.connectionState === "disconnected")) {
        cb.onError(
          "Peer-to-peer link failed. Both devices need to be on the same network.",
        );
      }
    };

    channel = pc.createDataChannel("file", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.onopen = () => void pump(channel!);
    channel.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const frame = JSON.parse(e.data) as ControlFrame;
      if (frame.t === "ack") {
        cb.onStatus("done");
        closed = true;
        socket.emit("complete");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", { kind: "desc", desc: offer } satisfies SignalPayload);
  });

  socket.on("signal", async (payload: SignalPayload) => {
    if (!pc) return;
    if (payload.kind === "desc") {
      await pc.setRemoteDescription(payload.desc);
      while (pendingCandidates.length) {
        const c = pendingCandidates.shift()!;
        try {
          await pc.addIceCandidate(c);
        } catch {
          /* ignore */
        }
      }
    } else if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch {
        /* ignore */
      }
    } else {
      pendingCandidates.push(payload.candidate);
    }
  });

  async function pump(ch: RTCDataChannel) {
    cb.onStatus("sending");
    ch.send(JSON.stringify({ t: "begin", meta } satisfies ControlFrame));

    const meter = makeRateMeter();
    let offset = 0;
    while (offset < file.size && !closed) {
      if (ch.bufferedAmount > BUFFER_HIGH) {
        await new Promise<void>((resolve) => {
          const on = () => {
            ch.removeEventListener("bufferedamountlow", on);
            resolve();
          };
          ch.addEventListener("bufferedamountlow", on);
        });
        if (closed || ch.readyState !== "open") return;
      }
      const buf = await file
        .slice(offset, offset + CHUNK_SIZE)
        .arrayBuffer();
      if (ch.readyState !== "open") return;
      ch.send(buf);
      offset += buf.byteLength;
      cb.onProgress({
        moved: offset,
        total: file.size,
        bps: meter(offset, performance.now()),
      });
    }
    if (ch.readyState === "open") {
      ch.send(JSON.stringify({ t: "eof" } satisfies ControlFrame));
    }
  }

  return {
    close() {
      closed = true;
      try {
        channel?.close();
      } catch {}
      try {
        pc?.close();
      } catch {}
      socket.disconnect();
    },
  };
}

// -------------------------------------------------------------- receiver

export type ReceiverStatus =
  | "connecting"
  | "offered"
  | "linking"
  | "receiving"
  | "done";

export type ReceiverHandle = { accept: () => void; close: () => void };

export function startReceiver(
  sessionId: string,
  cb: {
    onMeta: (meta: FileMeta) => void;
    onStatus: (s: ReceiverStatus) => void;
    onProgress: (p: Progress) => void;
    onDone: (blob: Blob, meta: FileMeta) => void;
    onError: (msg: string) => void;
  },
): ReceiverHandle {
  const socket: Socket = io(SIGNAL_URL, { transports: ["websocket", "polling"] });
  let pc: RTCPeerConnection | null = null;
  let closed = false;
  const pendingCandidates: RTCIceCandidateInit[] = [];

  let meta: FileMeta | null = null;
  let chunks: ArrayBuffer[] = [];
  let received = 0;
  const meter = makeRateMeter();

  cb.onStatus("connecting");

  socket.on("connect_error", () =>
    cb.onError(
      `Can't reach the signaling server at ${SIGNAL_URL}. Is it running?`,
    ),
  );

  socket.on("connect", () => {
    socket.emit(
      "join",
      sessionId,
      (res: { file?: FileMeta; error?: string }) => {
        if (res.error || !res.file) {
          cb.onError(res.error || "That transfer is no longer available.");
          return;
        }
        meta = res.file;
        cb.onMeta(res.file);
        cb.onStatus("offered");
      },
    );
  });

  socket.on("peer-gone", () => {
    if (!closed) cb.onError("The sender disconnected.");
  });
  socket.on("expired", () => {
    if (!closed) cb.onError("This transfer expired.");
  });

  socket.on("signal", async (payload: SignalPayload) => {
    if (payload.kind === "desc") {
      if (!pc) preparePeer();
      await pc!.setRemoteDescription(payload.desc);
      const answer = await pc!.createAnswer();
      await pc!.setLocalDescription(answer);
      socket.emit("signal", {
        kind: "desc",
        desc: answer,
      } satisfies SignalPayload);
      while (pendingCandidates.length) {
        try {
          await pc!.addIceCandidate(pendingCandidates.shift()!);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (pc?.remoteDescription) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch {
        /* ignore */
      }
    } else {
      pendingCandidates.push(payload.candidate);
    }
  });

  function preparePeer() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    attachIce(pc, socket, pendingCandidates);
    pc.onconnectionstatechange = () => {
      if (
        !closed &&
        (pc?.connectionState === "failed" || pc?.connectionState === "disconnected")
      ) {
        cb.onError(
          "Peer-to-peer link failed. Both devices need to be on the same network.",
        );
      }
    };
    pc.ondatachannel = (e) => wireChannel(e.channel);
  }

  function wireChannel(ch: RTCDataChannel) {
    ch.binaryType = "arraybuffer";
    ch.onmessage = (e) => {
      if (typeof e.data === "string") {
        const frame = JSON.parse(e.data) as ControlFrame;
        if (frame.t === "begin") {
          meta = frame.meta;
          cb.onMeta(frame.meta);
          cb.onStatus("receiving");
        } else if (frame.t === "eof") {
          finish(ch);
        }
        return;
      }
      const buf: ArrayBuffer =
        e.data instanceof ArrayBuffer ? e.data : new Uint8Array(e.data).buffer;
      chunks.push(buf);
      received += buf.byteLength;
      cb.onProgress({
        moved: received,
        total: meta?.size ?? 0,
        bps: meter(received, performance.now()),
      });
    };
  }

  function finish(ch: RTCDataChannel) {
    if (closed || !meta) return;
    closed = true;
    const blob = new Blob(chunks, { type: meta.type });
    chunks = [];
    if (ch.readyState === "open") {
      ch.send(JSON.stringify({ t: "ack" } satisfies ControlFrame));
    }
    cb.onStatus("done");
    cb.onDone(blob, meta);
    socket.emit("complete");
  }

  return {
    accept() {
      cb.onStatus("linking");
      preparePeer();
      socket.emit("accept");
    },
    close() {
      closed = true;
      try {
        pc?.close();
      } catch {}
      socket.disconnect();
    },
  };
}
