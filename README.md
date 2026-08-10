# QRDrop

[![CI](https://github.com/neerav34/qrdrop/actions/workflows/ci.yml/badge.svg)](https://github.com/neerav34/qrdrop/actions/workflows/ci.yml)

Send a file from one device to another by scanning a QR code. The file goes
straight between the two browsers over an encrypted WebRTC data channel — no
upload, no cloud storage, no account, and no server that can see the bytes.

It works **between any two ecosystems**, which is the gap the built-in tools
leave: AirDrop is Apple-to-Apple, Quick Share is Android and Windows. A browser
is the only runtime that exists everywhere, so Android → iPhone, laptop → phone
and Windows → Mac all work the same way here.

```
Sender picks files ──► QR code appears (it holds a session link, not the files)
                              │
Receiver scans it ────────────┘
                              │
        Both browsers hand each other an address via the signaling server
                              │
        Files stream device → device, one after another, 16 KB at a time,
        resuming from the exact file and byte if the link drops
```

## What's in here

| Path | What it is |
|---|---|
| [app/](app/) | Pages: home, `/send`, `/receive` (camera scanner), `/r/[id]` (the scanned link) |
| [lib/peer.ts](lib/peer.ts) | The transfer engine — signalling, WebRTC, chunking, backpressure, resume |
| [lib/protocol.ts](lib/protocol.ts) | Shared message shapes and tuning constants for both sides |
| [lib/sink.ts](lib/sink.ts) | Where received bytes go: memory, one file on disk, or a whole folder |
| [lib/pin.ts](lib/pin.ts) | PIN generation and salted digests, and why the attempt limit is the real control |
| [lib/keepAwake.ts](lib/keepAwake.ts) | Screen wake lock held for the duration of a transfer |
| [lib/device.ts](lib/device.ts) | Coarse device labelling, so each end can name the other |
| [components/Receiver.tsx](components/Receiver.tsx) | The whole receive flow: PIN gate, file list, progress, saving |
| [components/DeviceLink.tsx](components/DeviceLink.tsx) | The two-device visual — the live state of the link |
| [public/sw.js](public/sw.js) | Service worker, deliberately narrow so it cannot serve a stale build |
| [server/](server/) | Socket.io signalling — relays SDP/ICE, mints TURN credentials, holds no files |
| [test/](test/) | 9 suites, 175 checks: protocol, PIN, origins, TURN, PWA, cold start, real-Chrome transfers, live relay |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI: build plus every suite that needs no credentials |

## Run it locally

```bash
npm install
(cd server && npm install)
cp .env.example .env.local
npm run dev:all          # web on :3000, signaling on :4000
```

Open <http://localhost:3000> in two browser tabs — send from one, paste the link
into the other. That path works entirely on localhost.

### Testing across two real devices

WebRTC and the camera both require a secure context, and `http://192.168.x.x` is
not one, so LAN testing over plain HTTP fails on the phone. Deploy first and test
on the HTTPS URL — that is what the transfer is meant to run on anyway.

## Several files at once

Pick as many files as you like (up to 100) and they stream one after another down
a single data channel. They are deliberately **not** zipped first: a 2 GB folder
would then have to exist twice over before a byte moved, and the receiver would
get an archive to unpack instead of their files.

Each file is closed off and handed to the receiver's UI as it lands, so a long
batch is useful while it is still running. Where the bytes go depends on the
batch:

| Batch | Where it lands |
|---|---|
| Anything under 256 MB | memory, then a normal download — nothing is asked |
| One large file | a single save dialog |
| Several large files | **one folder dialog**, then written straight into it |

That last row is the reason [lib/sink.ts](lib/sink.ts) has a `SinkFactory` rather
than just a sink: a save dialog per file would need a fresh user gesture for each
one, and there isn't one mid-transfer. Asking once for a folder is the only shape
that works. Filenames coming off the wire are sanitised before they become real
paths ([`safeName`](lib/sink.ts)) — a sender could otherwise offer
`../../something`.

Browsers may block the second and later automatic downloads in a batch, so the
file list always keeps an explicit Save link per file for anything the browser
skipped.

## Optional PIN

A QR code is a bearer token: anyone who photographs it, shoulder-surfs it, or
catches it in a screen share can claim the transfer — and because sessions are
single-use, a snooper who acts *first* beats the intended recipient. Switching on
**Require a PIN** puts a six-digit code in the way, which travels out of band
because you read it aloud.

Two things about the design are worth stating plainly:

- **The PIN gates the manifest, not just the bytes.** A locked `join` returns
  nothing at all — no filenames, no sizes, not even the sender's device. A gate
  that protected the file while announcing "3 files, 1.2 GB, from an iPhone" would
  be worth much less.
- **The attempt limit is the actual security control, not the hashing.** Six
  digits is a million possibilities: trivial to brute-force with unlimited tries,
  hopeless at five. Attempts are counted on the *session*, so reconnecting cannot
  buy five more, and running out destroys the session rather than merely refusing
  — a burned code can't be ground down at leisure. The sender sees a warning on
  each wrong guess, since it may not be their recipient trying.

The PIN is salted and hashed in the browser, so it never crosses the wire or lands
in a server log. That is hygiene rather than protection *from* the server, which
could brute-force a six-digit digest instantly and already sees every SDP it
relays. A PAKE would fix that and is deliberately out of scope — the signaling
server is trusted for routing either way.

## Surviving interruptions

A phone that sleeps or switches apps kills the connection, so the transfer is
built to expect that rather than hope it doesn't happen:

- **The screen is held awake** for the duration via the Screen Wake Lock API,
  which prevents the most common cause outright.
- **Sessions outlive the socket.** Each side gets a resume token; the server
  holds the session for two minutes after a peer vanishes and re-attaches the
  reconnected socket to it.
- **The receiver drives resumption.** On every fresh data channel it announces
  which file it is on and how many of that file's bytes it holds, and the sender
  seeks there before sending. A first connection and a resume are the same code
  path, which is why the seam can't drift — the receiver's position is always
  authoritative. Files already banked are never re-sent, so a drop during file 8
  of 10 rewinds only file 8.
- **Relinking is single-flight, with a watchdog.** Both sides notice a dead link
  at once, so every reason to reconnect is coalesced into one negotiation, and a
  connection attempt that doesn't complete in 10 seconds is retried on our
  schedule rather than waiting on ICE's.
- **Closing the tab warns you** while a transfer is in flight.
- **Cancelling says so.** Either side can stop a transfer, and the peer is told it
  was a decision rather than left waiting out the resume window for someone who
  has already walked away. The receiver discards whatever partial data arrived.

Verified end-to-end: the resume test kills a live link mid-file and checks the
received file's sha256 against the source, so a duplicated or dropped chunk at
the seam would fail the test.

## Tests

```bash
npm run signal           # in one terminal
npm run test:signal      # 34 protocol checks: session lifecycle, resume tokens,
                         # single-use lock, manifest validation, rate limit,
                         # peer-drop notification

npm run dev:all          # in one terminal
npm run test:e2e         # drives two real Chrome tabs through five scenarios:
                         # a 3 MB transfer verified byte-for-byte; a 64 MB one
                         # whose link is cut mid-flight; four files in one
                         # session each checked by sha256; and a batch cut after
                         # the first file is banked, which must resume across the
                         # file boundary without duplicating or losing a chunk;
                         # and a PIN-gated transfer through the real UI
RESUME_RUNS=5 npm run test:e2e   # repeat the resume scenario to shake out races

npm run build && npm run start   # production, in one terminal
npm run test:pwa         # manifest, real PNG icons at declared sizes, worker
                         # registering and activating, and the UI still opening
                         # with the network cut off via CDP

npm run dev              # signal server NOT running
npm run test:coldstart   # points the page at a dead signaling server: must wait
                         # rather than fail, then recover once it answers

npm run test:pin         # the PIN gate: a locked join leaking nothing, attempts
                         # counted per session so reconnecting can't reset them,
                         # the limit destroying the session, and accept refusing
                         # to skip verification

npm run test:origins     # ALLOWED_ORIGINS: exact match, refusal, and the
                         # trailing-slash case that broke the first deployment
npm run build            # needed by the leak check below
npm run test:turn        # TURN wiring against a stub provider: credentials
                         # delivered over the socket, minted once not per
                         # session, absent from the web bundle, and a provider
                         # outage degrading to STUN instead of breaking

E2E_URL=https://qrdrop-seven.vercel.app npm run test:relay
                         # forces iceTransportPolicy:"relay" via ?relay=1 and
                         # sha256-checks the result — the only way to prove the
                         # relay carries a file, since on one network the direct
                         # path always wins. Needs real TURN credentials and
                         # spends relay quota, so it is opt-in.
```

All eight suites pass on the current tree — **152 checks** (34 signalling, 22 PIN, 14 origins, 16 TURN, 17 PWA, 35 browser transfers, 4 cold start, 6 live relay). The first six run in CI on every push. Leave a minute between
them — the signal suite deliberately trips the 10-sessions-per-IP-per-minute
limit, which would otherwise refuse the e2e run's own session. And don't run
`next build` while `next dev` is live; they share `.next`.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push. Two jobs,
split by what they need:

- **Build + protocol suites** — `next build` (which is also the typecheck), then
  the four suites that need neither a browser nor credentials. Fast, and the one
  that should gate a merge. It boots the signaling server twice on separate ports
  because the signal suite deliberately trips the per-IP rate limit, which would
  otherwise leave the PIN suite refused for the following minute.
- **Browser transfers + PWA** — real Chrome, real WebRTC. The PWA suite needs a
  production server (the worker is not registered in dev) and the resume scenarios
  need a dev one (only that build carries the hook that severs a live link), so
  the job runs one then the other, killing the first and clearing `.next` in
  between.

This exists because of a real near-miss: a breaking protocol change (`files` where
the server expected `file`) shipped to production with nothing but manual testing
standing between it and a broken deployment.

## Deploy

**Live:** <https://qrdrop-seven.vercel.app> (signaling on Render).
Step-by-step, entirely on free tiers: **[DEPLOY.md](DEPLOY.md)**.

The e2e suite runs against the deployment too, which is how the live stack was
verified end to end:

```bash
E2E_URL=https://qrdrop-seven.vercel.app RESUME_RUNS=0 npm run test:e2e
```

The resume scenarios detect that the drop hook is absent from a production build
and report themselves **skipped** rather than passing. That matters: calling the
missing hook is a silent no-op, so without the check they would claim to have cut
a link they never touched — a green tick proving nothing.

In short — the signaling server goes to Render (a free Web Service, because it
must hold WebSockets open, which Vercel's serverless functions cannot), the web
app goes to Vercel, and `ALLOWED_ORIGINS` then locks the two together. Deploy the
signaling server first: its URL is a `NEXT_PUBLIC_` variable, so it is compiled
into the client bundle.

Free hosting idles the signaling server out after ~15 minutes, and waking it
takes 30–60 seconds. Every page pings `/healthz` on load
([components/Prewarm.tsx](components/Prewarm.tsx)) so it boots while the user is
still choosing a file, and a failed first connection is treated as "still
waking", not as an error — the client retries for ~80 seconds and says so.
`npm run test:coldstart` guards that behaviour.

## Installable, and useful offline

The app is a real PWA: Android offers *Install*, iOS *Add to Home Screen*, and it
launches fullscreen with no browser chrome. Chrome only offers to install when the
criteria are genuinely met, which is why [components/InstallButton.tsx](components/InstallButton.tsx)
renders nothing until `beforeinstallprompt` fires — the button appearing is itself
proof the manifest, icons and worker are all in order.

[public/sw.js](public/sw.js) is deliberately conservative, because a service
worker is the easiest way to brick your own deployment:

- **Navigations are network-first.** A cached HTML shell that references chunk
  hashes from a previous build is the classic self-inflicted outage, so the
  network always wins when it can and the cache is only an offline fallback.
- **Only `/_next/static/*` is cache-first**, since those filenames carry a
  content hash and can never change meaning.
- **Cross-origin requests are untouched.** Signalling lives on another origin and
  must never be intercepted or cached.
- **No `skipWaiting()`.** A new worker seizing control mid-session could hand a
  running page assets from a different build, and a transfer in flight is exactly
  the wrong moment. Updates apply on the next visit.

`npm run test:pwa` checks all of that plus the real thing: it cuts the network
with CDP and asserts the UI still opens. The transfer suite was also re-run
against a production build with the worker active, to confirm it doesn't
interfere with a transfer.

## A note on the animation layer

The motion is deliberately cheap, because it runs while the main thread is busy
shipping chunks. Everything animated is `transform`/`opacity` only, the drifting
background fields use soft radial gradients rather than a blur filter, and the
packets travelling the wire are a full-width rail translated on the compositor
instead of an element with an animated `left`.

Progress callbacks are throttled to one per 50ms
([`PROGRESS_INTERVAL_MS`](lib/protocol.ts)). Reporting every 16 KB chunk meant
~5,700 React renders for a 90 MB file, and that measurably slowed the transfer
it was reporting on: 90 MB went 9.0s → 13.0s when the animations landed, and
back to ~10.5s once the renders were throttled and a duplicate React key was
fixed.

The QR scan line is a 3px line rather than a translucent band on purpose — the
code has to survive being read by a phone camera in one pass, and a wash over
the modules costs contrast for no real gain.

Everything respects `prefers-reduced-motion`.

## Is anyone using it?

The app collects nothing about users, so the only honest place to count is the
signalling server, which already creates every session. Open
**`/stats`** in a browser for a readable summary — completion rate, transfers,
files, peak concurrency — or fetch the same data as JSON from any script. A
wildcard `Accept` header gets JSON; only a browser gets the page.

`GET /stats` returns aggregate totals:

```
sessionsCreated · sessionsCompleted · sessionsCancelled · sessionsExpired
pinProtected · pinLockouts · filesOffered · bytesOffered · peakConcurrent
```

Deliberately nothing identifying — no IPs, no filenames, no per-session records,
no cookies, no third-party script. `bytesOffered` is what senders *declared*,
because the server never sees a file byte and so cannot measure what moved. The
signal suite asserts that neither filenames nor session ids appear in the
response.

The numbers live in memory and reset when the process restarts, which on a
free tier that sleeps when idle is often. `since` and `uptimeHours` say how far
back they go; an uptime pinger makes them meaningful.

## Security notes

- **The file never reaches a server.** WebRTC data channels are DTLS-encrypted by
  specification — not an option that can be switched off — and the signaling
  server only ever sees SDP text. The UI reports the negotiated route
  ("Direct · same network"), read back off the ICE candidate pair, so the claim
  is visible rather than just asserted.
- **Session IDs and resume tokens are `crypto.randomUUID()`** — not guessable.
  A rejoin without the matching token is refused.
- **Single use.** Once a receiver accepts, the session is locked to those two
  peers; a third device scanning the same code is refused. Covered by tests.
- **Expiry.** An unscanned code dies after 10 minutes, and a half-dead transfer
  after 2. Idle sessions are reaped at an hour — but a transfer still in flight is
  spared, behind a 6-hour absolute backstop, because the original single ceiling
  killed live transfers on slow links. Everything is in a `Map`; nothing is ever
  written to disk.
- **Input validation and rate limiting** on the server: file metadata is
  type/length checked, device labels are stripped to safe characters, malformed
  SDP is dropped rather than relayed, and session creation is capped at 10 per IP
  per minute.
- **CORS** is restricted to `ALLOWED_ORIGINS` in production; private-network
  origins are additionally allowed when `NODE_ENV !== "production"`.
- The receiver sees the file name and size and must press **Accept** before any
  connection is made.

## Known limits

- **Cross-network needs TURN configured.** Out of the box the two devices must
  reach each other directly — same Wi-Fi, or one on the other's hotspot. On a
  hotspot the file crosses the local Wi-Fi link and costs no mobile data. Set the
  `TURN_*` variables on the signaling server (see [DEPLOY.md](DEPLOY.md)) to add
  a relay for the cases that can't go direct: different networks, or a Wi-Fi that
  blocks device-to-device traffic. Relay is a last resort — ICE prefers direct
  paths, so relay bandwidth is only spent where a transfer would have failed.
- **Files above 256 MB stream to disk**, which removes the memory ceiling — but
  only where the File System Access API exists (desktop Chrome/Edge). Elsewhere
  the receiver buffers in memory, so multi-gigabyte transfers to a phone can
  still fail. The sender warns above 2 GB.
- **Resume needs the page alive.** Backgrounding is survivable; a full reload
  loses the partial data, because it lives in the tab. Persisting progress to
  IndexedDB or a disk file handle would fix that.
- One file per session; zip client-side for multiple.

## Next up

Optional, and none of it changes what the tool does:

- **Transfer history** — last few transfers in `localStorage` (names and sizes
  only, never files).
- **Text and link sharing** — paste a URL or a snippet instead of picking a file.
- **Cross-network at scale.** Relay works but the free TURN allowance is 500 MB a
  month, which suits demos rather than daily use. A paid tier or a self-hosted
  `coturn` would lift it.
- **Resume across a page reload.** Backgrounding is survivable today; a full
  reload is not, because the received bytes live in memory or in a file handle
  that does not outlive the page. IndexedDB or a re-picked directory handle would
  close that.

Deliberately *not* planned: zipping multiple files client-side (the original plan
called for `jszip`). Streaming them sequentially avoids a 2 GB folder needing to
exist twice before a byte moves, and gives the receiver their actual files rather
than an archive to unpack.
