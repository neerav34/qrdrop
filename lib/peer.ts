"use client";

import { io, type Socket } from "socket.io-client";
import { describeDevice } from "./device";
import { keepAwake, type KeepAwake } from "./keepAwake";
import {
  createDiskSink,
  createMemorySink,
  diskStreamingAvailable,
  type Sink,
} from "./sink";
import {
  BUFFER_HIGH,
  BUFFER_LOW,
  CHUNK_SIZE,
  COLD_START_ATTEMPTS,
  PROGRESS_INTERVAL_MS,
  DISK_STREAM_THRESHOLD,
  ICE_SERVERS,
  RESUME_WINDOW_MS,
  SIGNAL_URL,
  type ControlFrame,
  type DeviceInfo,
  type FileMeta,
  type LinkPath,
  type SignalPayload,
} from "./protocol";

export type Progress = { moved: number; total: number; bps: number };

/** Reconnection is on by default, but be explicit: resume depends on it. */
function socketOptions() {
  return {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  };
}

/**
 * Rate-limit progress callbacks. Each one costs a React render, and at one call
 * per 16 KB chunk that measurably slows the transfer it is reporting on. `force`
 * lets the final value through so the bar always lands on 100%.
 */
function makeProgressGate() {
  let lastAt = 0;
  return (now: number, force = false) => {
    if (!force && now - lastAt < PROGRESS_INTERVAL_MS) return false;
    lastAt = now;
    return true;
  };
}

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

/**
 * Read the negotiated ICE candidate pair back off the connection, so we can tell
 * the user (truthfully) whether the bytes are going straight across the local
 * network or out through a relay.
 */
async function readPath(p: RTCPeerConnection): Promise<LinkPath | null> {
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

/**
 * A free-tier container that has idled out takes a while to boot. Say so instead
 * of claiming the server is unreachable on the first failed attempt.
 */
function coldStartNotice(attempt: number): string {
  return attempt <= 2
    ? "Reaching the connection server…"
    : "Waking up the connection server — free hosting can take up to a minute.";
}

/** Wait for the send buffer to drain, but never hang if the channel dies. */
function waitForDrain(ch: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      ch.removeEventListener("bufferedamountlow", done);
      ch.removeEventListener("close", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 5000);
    ch.addEventListener("bufferedamountlow", done);
    ch.addEventListener("close", done);
  });
}

// ---------------------------------------------------------------- sender

export type SenderStatus =
  | "connecting"
  | "waiting"
  | "linking"
  | "sending"
  | "paused"
  | "done";

export type SenderHandle = { close: () => void };

export type SenderCallbacks = {
  onSession: (sessionId: string, expiresAt: number) => void;
  onStatus: (s: SenderStatus) => void;
  onProgress: (p: Progress) => void;
  onPeer: (device: DeviceInfo | null) => void;
  /** The route the bytes are taking, once ICE has settled. */
  onPath: (path: LinkPath) => void;
  /** Transient, self-healing condition. null clears it. */
  onNotice: (msg: string | null) => void;
  /** Terminal. The transfer is over. */
  onError: (msg: string) => void;
};

export function startSender(file: File, cb: SenderCallbacks): SenderHandle {
  const meta: FileMeta = {
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
  };
  const socket: Socket = io(SIGNAL_URL, socketOptions());

  let sessionId: string | null = null;
  let token: string | null = null;
  /** Handed over by the signaling server; TURN credentials never live in the bundle. */
  let iceServers: RTCIceServer[] = ICE_SERVERS;
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  /** Bumped on every teardown so stale callbacks and pumps abandon quietly. */
  let gen = 0;
  let finished = false;
  let closed = false;
  let awake: KeepAwake | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let linkPending: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let pending: RTCIceCandidateInit[] = [];
  let connectFailures = 0;

  cb.onStatus("connecting");

  function releaseAwake() {
    awake?.release();
    awake = null;
  }

  function fatal(msg: string) {
    if (closed) return;
    finished = true;
    if (deadline) clearTimeout(deadline);
    teardownPeer();
    releaseAwake();
    cb.onError(msg);
  }

  function pause(msg: string) {
    if (finished || closed) return;
    cb.onStatus("paused");
    cb.onNotice(msg);
    if (!deadline) {
      deadline = setTimeout(
        () => fatal("Could not pick the transfer back up. Start again."),
        RESUME_WINDOW_MS,
      );
    }
  }

  function resumedOk() {
    if (deadline) {
      clearTimeout(deadline);
      deadline = null;
    }
    cb.onNotice(null);
  }

  function teardownPeer() {
    gen++;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    try {
      channel?.close();
    } catch {}
    try {
      pc?.close();
    } catch {}
    channel = null;
    pc = null;
    pending = [];
  }

  /**
   * Coalesce every reason to relink — our own failure detection and the
   * receiver's nudge usually arrive together, and two concurrent negotiations
   * produce a mismatched offer/answer pair that then waits on ICE's own slow
   * timers to recover.
   */
  function requestLink(delay = 900) {
    if (finished || closed || linkPending) return;
    linkPending = setTimeout(() => {
      linkPending = null;
      if (socket.connected) void link();
    }, delay);
  }

  /** The sender is always the offerer, on the first link and on every resume. */
  async function link() {
    if (finished || closed) return;
    teardownPeer();
    const myGen = gen;
    cb.onStatus("linking");

    const p = new RTCPeerConnection({ iceServers });
    pc = p;

    p.onicecandidate = (e) => {
      if (e.candidate && gen === myGen) {
        socket.emit("signal", {
          kind: "candidate",
          candidate: e.candidate.toJSON(),
        } satisfies SignalPayload);
      }
    };
    p.onconnectionstatechange = () => {
      if (gen !== myGen || finished || closed) return;
      if (p.connectionState === "connected") {
        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        void readPath(p).then((path) => {
          if (path && gen === myGen) cb.onPath(path);
        });
      }
      if (p.connectionState === "failed" || p.connectionState === "disconnected") {
        pause("Connection to the receiver dropped. Retrying…");
        requestLink();
      }
    };

    // Don't wait on ICE to give up on its own schedule — retry on ours.
    watchdog = setTimeout(() => {
      if (gen !== myGen || finished || closed) return;
      if (p.connectionState !== "connected") {
        pause("Still trying to reach the other device…");
        requestLink(200);
      }
    }, 10000);

    const ch = p.createDataChannel("file", { ordered: true });
    channel = ch;
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = BUFFER_LOW;

    ch.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let frame: ControlFrame;
      try {
        frame = JSON.parse(e.data) as ControlFrame;
      } catch {
        return;
      }
      // The receiver tells us where it got to; that's our seek point.
      if (frame.t === "resume") {
        void pump(ch, Math.min(Math.max(0, frame.from), file.size), myGen);
      } else if (frame.t === "ack") {
        finished = true;
        if (deadline) clearTimeout(deadline);
        releaseAwake();
        cb.onNotice(null);
        cb.onStatus("done");
        socket.emit("complete");
      }
    };
    ch.onclose = () => {
      if (gen !== myGen || finished || closed) return;
      pause("Connection to the receiver dropped. Retrying…");
      requestLink();
    };

    try {
      const offer = await p.createOffer();
      if (gen !== myGen) return;
      await p.setLocalDescription(offer);
      socket.emit("signal", { kind: "desc", desc: offer } satisfies SignalPayload);
    } catch {
      if (gen === myGen) requestLink();
    }
  }

  async function pump(ch: RTCDataChannel, from: number, myGen: number) {
    resumedOk();
    cb.onStatus("sending");
    if (!awake) awake = keepAwake();

    const meter = makeRateMeter();
    const gate = makeProgressGate();
    let offset = from;
    cb.onProgress({ moved: offset, total: file.size, bps: 0 });

    while (offset < file.size) {
      if (gen !== myGen || closed || finished || ch.readyState !== "open") return;
      if (ch.bufferedAmount > BUFFER_HIGH) {
        await waitForDrain(ch);
        continue;
      }
      let buf: ArrayBuffer;
      try {
        buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      } catch {
        fatal("Could not read the file. Was it moved or deleted?");
        return;
      }
      if (gen !== myGen || ch.readyState !== "open") return;
      try {
        ch.send(buf);
      } catch {
        return; // channel went away mid-send; the relink path handles it
      }
      offset += buf.byteLength;
      const now = performance.now();
      const bps = meter(offset, now);
      if (gate(now, offset >= file.size)) {
        cb.onProgress({ moved: offset, total: file.size, bps });
      }
    }

    if (gen === myGen && ch.readyState === "open") {
      ch.send(JSON.stringify({ t: "eof" } satisfies ControlFrame));
    }
  }

  socket.on("connect", () => {
    connectFailures = 0;
    cb.onNotice(null);
    if (sessionId && token) {
      // Same participant, new socket: re-attach rather than start over.
      socket.emit(
        "rejoin",
        { sessionId, token, role: "sender" },
        (res: {
          error?: string;
          peerOnline?: boolean;
          peerDevice?: DeviceInfo;
          iceServers?: RTCIceServer[];
        }) => {
          if (res.error) return fatal(res.error);
          if (res.iceServers?.length) iceServers = res.iceServers;
          if (res.peerDevice) cb.onPeer(res.peerDevice);
          if (res.peerOnline) {
            resumedOk();
            void link();
          }
        },
      );
      return;
    }
    socket.emit(
      "create",
      { file: meta, device: describeDevice() },
      (res: {
        sessionId?: string;
        token?: string;
        expiresAt?: number;
        error?: string;
        iceServers?: RTCIceServer[];
      }) => {
        if (res.error || !res.sessionId || !res.token) {
          return fatal(res.error || "Could not create a session.");
        }
        sessionId = res.sessionId;
        token = res.token;
        if (res.iceServers?.length) iceServers = res.iceServers;
        cb.onSession(res.sessionId, res.expiresAt ?? Date.now() + 600_000);
        cb.onStatus("waiting");
      },
    );
  });

  socket.on("connect_error", () => {
    if (sessionId) {
      pause("Lost the connection. Reconnecting…");
      return;
    }
    // socket.io is already retrying with backoff — let it, and explain the wait.
    connectFailures++;
    if (connectFailures <= COLD_START_ATTEMPTS) {
      cb.onNotice(coldStartNotice(connectFailures));
      return;
    }
    fatal(`Can't reach the signaling server at ${SIGNAL_URL}. Is it running?`);
  });

  socket.on("receiver-ready", (info: { device?: DeviceInfo }) => {
    if (info?.device) cb.onPeer(info.device);
    resumedOk();
    void link();
  });

  socket.on("peer-offline", () => {
    teardownPeer();
    pause("Receiver's screen went to sleep or switched apps. Waiting for it…");
  });

  socket.on("expired", () => {
    if (!finished) fatal("This transfer expired. Start a new one.");
  });

  socket.on("signal", async (payload: SignalPayload) => {
    const p = pc;
    if (!p) {
      if (payload.kind === "candidate") pending.push(payload.candidate);
      return;
    }
    try {
      if (payload.kind === "desc") {
        // An answer from a superseded negotiation would poison this one.
        if (p.signalingState !== "have-local-offer") return;
        await p.setRemoteDescription(payload.desc);
        while (pending.length) {
          await p.addIceCandidate(pending.shift()!).catch(() => {});
        }
      } else if (p.remoteDescription) {
        await p.addIceCandidate(payload.candidate);
      } else {
        pending.push(payload.candidate);
      }
    } catch {
      /* a stale description or candidate is not fatal — ICE retries */
    }
  });

  return {
    close() {
      closed = true;
      if (deadline) clearTimeout(deadline);
      if (linkPending) clearTimeout(linkPending);
      teardownPeer();
      releaseAwake();
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
  | "paused"
  | "done";

export type ReceiverHandle = {
  /** Must be called from a click — a save dialog needs user activation. */
  accept: () => Promise<void>;
  close: () => void;
};

export type ReceiverCallbacks = {
  onMeta: (meta: FileMeta) => void;
  onStatus: (s: ReceiverStatus) => void;
  onProgress: (p: Progress) => void;
  onPeer: (device: DeviceInfo | null) => void;
  /** "disk" means it is being written straight to a file the user chose. */
  onTarget: (target: "disk" | "memory") => void;
  /** blob is null when the bytes already went to disk. */
  onDone: (blob: Blob | null, meta: FileMeta) => void;
  onNotice: (msg: string | null) => void;
  onError: (msg: string) => void;
};

export function startReceiver(
  sessionId: string,
  cb: ReceiverCallbacks,
): ReceiverHandle {
  const socket: Socket = io(SIGNAL_URL, socketOptions());

  let token: string | null = null;
  let iceServers: RTCIceServer[] = ICE_SERVERS;
  let meta: FileMeta | null = null;
  let sink: Sink | null = null;
  let received = 0;
  let pc: RTCPeerConnection | null = null;
  const gate = makeProgressGate();
  let gen = 0;
  let finished = false;
  let closed = false;
  let awake: KeepAwake | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: RTCIceCandidateInit[] = [];
  let connectFailures = 0;
  const meter = makeRateMeter();

  cb.onStatus("connecting");

  function releaseAwake() {
    awake?.release();
    awake = null;
  }

  function fatal(msg: string) {
    if (closed) return;
    finished = true;
    if (deadline) clearTimeout(deadline);
    teardownPeer();
    sink?.abort();
    releaseAwake();
    cb.onError(msg);
  }

  function pause(msg: string) {
    if (finished || closed) return;
    cb.onStatus("paused");
    cb.onNotice(msg);
    if (!deadline) {
      deadline = setTimeout(
        () => fatal("Could not pick the transfer back up. Ask for a new code."),
        RESUME_WINDOW_MS,
      );
    }
  }

  function resumedOk() {
    if (deadline) {
      clearTimeout(deadline);
      deadline = null;
    }
    cb.onNotice(null);
  }

  function teardownPeer() {
    gen++;
    try {
      pc?.close();
    } catch {}
    pc = null;
    pending = [];
  }

  /**
   * Ask the sender to renegotiate. `rejoin` is idempotent, and the server turns
   * it into a `receiver-ready` for the sender — which is exactly the nudge we
   * want after our own peer connection dies. Repeats until bytes flow again, so
   * a single lost nudge doesn't leave the transfer stranded.
   */
  function nudgeSender(delay = 900) {
    if (finished || closed || nudgeTimer || !token) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (!socket.connected || finished || closed) return;
      socket.emit(
        "rejoin",
        { sessionId, token, role: "receiver" },
        (res: { error?: string }) => {
          if (res?.error) fatal(res.error);
        },
      );
      nudgeSender(8000);
    }, delay);
  }

  function stopNudging() {
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }

  function acceptOffer(desc: RTCSessionDescriptionInit) {
    // Every resume brings a brand-new peer connection from the sender, so we
    // build a matching fresh one rather than trying to renegotiate in place.
    teardownPeer();
    const myGen = gen;
    cb.onStatus("linking");

    const p = new RTCPeerConnection({ iceServers });
    pc = p;

    p.onicecandidate = (e) => {
      if (e.candidate && gen === myGen) {
        socket.emit("signal", {
          kind: "candidate",
          candidate: e.candidate.toJSON(),
        } satisfies SignalPayload);
      }
    };
    p.onconnectionstatechange = () => {
      if (gen !== myGen || finished || closed) return;
      if (p.connectionState === "failed" || p.connectionState === "disconnected") {
        pause("Connection to the sender dropped. Retrying…");
        nudgeSender();
      }
    };
    p.ondatachannel = (e) => wireChannel(e.channel, myGen);

    void (async () => {
      try {
        await p.setRemoteDescription(desc);
        const answer = await p.createAnswer();
        if (gen !== myGen) return;
        await p.setLocalDescription(answer);
        socket.emit("signal", {
          kind: "desc",
          desc: answer,
        } satisfies SignalPayload);
        while (pending.length) {
          await p.addIceCandidate(pending.shift()!).catch(() => {});
        }
      } catch {
        if (gen === myGen) nudgeSender();
      }
    })();
  }

  function wireChannel(ch: RTCDataChannel, myGen: number) {
    ch.binaryType = "arraybuffer";

    const announce = () => {
      if (gen !== myGen || ch.readyState !== "open") return;
      stopNudging();
      resumedOk();
      cb.onStatus("receiving");
      if (!awake) awake = keepAwake();
      // Tell the sender where to seek to. On a first connection this is 0.
      ch.send(JSON.stringify({ t: "resume", from: received } satisfies ControlFrame));
    };

    if (ch.readyState === "open") announce();
    else ch.onopen = announce;

    ch.onmessage = (e) => {
      if (gen !== myGen || finished) return;
      if (typeof e.data === "string") {
        let frame: ControlFrame;
        try {
          frame = JSON.parse(e.data) as ControlFrame;
        } catch {
          return;
        }
        if (frame.t === "eof") void finalize(ch);
        return;
      }
      const buf: ArrayBuffer =
        e.data instanceof ArrayBuffer ? e.data : new Uint8Array(e.data).buffer;
      sink?.write(buf);
      received += buf.byteLength;
      const now = performance.now();
      const bps = meter(received, now);
      if (gate(now, received >= (meta?.size ?? 0))) {
        cb.onProgress({ moved: received, total: meta?.size ?? 0, bps });
      }
    };

    ch.onclose = () => {
      if (gen !== myGen || finished || closed) return;
      pause("Connection to the sender dropped. Retrying…");
      nudgeSender();
    };
  }

  async function finalize(ch: RTCDataChannel) {
    if (finished || closed || !meta || !sink) return;
    finished = true;
    stopNudging();
    if (deadline) clearTimeout(deadline);
    try {
      await sink.drain();
      if (ch.readyState === "open") {
        ch.send(JSON.stringify({ t: "ack" } satisfies ControlFrame));
      }
      const blob = await sink.finish();
      releaseAwake();
      cb.onNotice(null);
      cb.onStatus("done");
      cb.onDone(blob, meta);
      socket.emit("complete");
    } catch {
      finished = false;
      fatal("Could not save the file to disk.");
    }
  }

  socket.on("connect", () => {
    connectFailures = 0;
    cb.onNotice(null);
    if (token) {
      socket.emit(
        "rejoin",
        { sessionId, token, role: "receiver" },
        (res: {
          error?: string;
          peerDevice?: DeviceInfo;
          file?: FileMeta;
          iceServers?: RTCIceServer[];
        }) => {
          if (res.error) return fatal(res.error);
          if (res.iceServers?.length) iceServers = res.iceServers;
          if (res.peerDevice) cb.onPeer(res.peerDevice);
          resumedOk();
        },
      );
      return;
    }
    socket.emit(
      "join",
      sessionId,
      (res: {
        file?: FileMeta;
        peerDevice?: DeviceInfo;
        error?: string;
        iceServers?: RTCIceServer[];
      }) => {
        if (res.error || !res.file) {
          return fatal(res.error || "That transfer is no longer available.");
        }
        if (res.iceServers?.length) iceServers = res.iceServers;
        meta = res.file;
        cb.onMeta(res.file);
        cb.onPeer(res.peerDevice ?? null);
        cb.onStatus("offered");
      },
    );
  });

  socket.on("connect_error", () => {
    if (meta) {
      pause("Lost the connection. Reconnecting…");
      return;
    }
    connectFailures++;
    if (connectFailures <= COLD_START_ATTEMPTS) {
      cb.onNotice(coldStartNotice(connectFailures));
      return;
    }
    fatal(`Can't reach the signaling server at ${SIGNAL_URL}. Is it running?`);
  });

  socket.on("peer-offline", () => {
    teardownPeer();
    pause("Sender's screen went to sleep or switched apps. Waiting for it…");
  });

  socket.on("peer-back", () => {
    resumedOk();
    cb.onStatus("linking");
  });

  socket.on("expired", () => {
    if (!finished) fatal("This transfer expired.");
  });

  socket.on("signal", async (payload: SignalPayload) => {
    if (payload.kind === "desc") {
      if (payload.desc.type === "offer") acceptOffer(payload.desc);
      return;
    }
    if (pc?.remoteDescription) {
      await pc.addIceCandidate(payload.candidate).catch(() => {});
    } else {
      pending.push(payload.candidate);
    }
  });

  if (process.env.NODE_ENV !== "production") {
    // Lets the test suite kill a live link the way a sleeping phone would, so
    // resume-from-offset is exercised for real. Stripped from production builds.
    (window as unknown as { __qrdropDropLink?: () => void }).__qrdropDropLink =
      () => {
        if (finished || closed) return;
        teardownPeer();
        pause("Simulated drop. Retrying…");
        nudgeSender();
      };
  }

  return {
    async accept() {
      if (!meta) return;
      cb.onNotice(null);

      // Big files stream to disk so RAM isn't the ceiling. The picker needs the
      // user activation from this very click, so it has to happen here.
      if (meta.size >= DISK_STREAM_THRESHOLD && diskStreamingAvailable()) {
        try {
          sink = await createDiskSink(meta.name);
        } catch {
          cb.onStatus("offered");
          cb.onError("Choose where to save the file, then accept again.");
          return;
        }
      } else {
        sink = createMemorySink(meta.type);
      }
      cb.onTarget(sink.toDisk ? "disk" : "memory");
      cb.onStatus("linking");

      socket.emit(
        "accept",
        { device: describeDevice() },
        (res: { token?: string; error?: string; iceServers?: RTCIceServer[] }) => {
          if (res?.error || !res?.token) {
            return fatal(res?.error || "Could not join the transfer.");
          }
          if (res.iceServers?.length) iceServers = res.iceServers;
          token = res.token;
        },
      );
    },
    close() {
      closed = true;
      if (deadline) clearTimeout(deadline);
      stopNudging();
      teardownPeer();
      if (!finished) sink?.abort();
      releaseAwake();
      socket.disconnect();
    },
  };
}
