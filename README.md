# QRDrop

Send a file from one device to another by scanning a QR code. The file goes
straight between the two browsers over an encrypted WebRTC data channel — no
upload, no cloud storage, no account, and no server that can see the bytes.

It works **between any two ecosystems**, which is the gap the built-in tools
leave: AirDrop is Apple-to-Apple, Quick Share is Android and Windows. A browser
is the only runtime that exists everywhere, so Android → iPhone, laptop → phone
and Windows → Mac all work the same way here.

```
Sender picks a file ──► QR code appears (it holds a session link, not the file)
                              │
Receiver scans it ────────────┘
                              │
        Both browsers hand each other an address via the signaling server
                              │
        File streams device → device, 16 KB at a time, resuming if it drops
```

## What's in here

| Path | What it is |
|---|---|
| [app/](app/) | Pages: home, `/send`, `/receive` (camera scanner), `/r/[id]` (the scanned link) |
| [lib/peer.ts](lib/peer.ts) | The transfer engine — signaling, WebRTC, chunking, backpressure, resume |
| [lib/protocol.ts](lib/protocol.ts) | Shared message shapes and tuning constants for both sides |
| [lib/sink.ts](lib/sink.ts) | Where received bytes go: memory blob, or streamed to disk for big files |
| [lib/keepAwake.ts](lib/keepAwake.ts) | Screen wake lock held for the duration of a transfer |
| [components/DeviceLink.tsx](components/DeviceLink.tsx) | The two-device visual — the live state of the link |
| [server/](server/) | Socket.io signaling server — relays SDP/ICE only, deployed separately |
| [test/](test/) | Protocol tests + real-Chrome transfer and resume tests |

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

## Surviving interruptions

A phone that sleeps or switches apps kills the connection, so the transfer is
built to expect that rather than hope it doesn't happen:

- **The screen is held awake** for the duration via the Screen Wake Lock API,
  which prevents the most common cause outright.
- **Sessions outlive the socket.** Each side gets a resume token; the server
  holds the session for two minutes after a peer vanishes and re-attaches the
  reconnected socket to it.
- **The receiver drives resumption.** On every fresh data channel it announces
  how many bytes it already holds, and the sender seeks there before sending.
  A first connection and a resume are the same code path, which is why the seam
  can't drift — the receiver's count is always authoritative.
- **Relinking is single-flight, with a watchdog.** Both sides notice a dead link
  at once, so every reason to reconnect is coalesced into one negotiation, and a
  connection attempt that doesn't complete in 10 seconds is retried on our
  schedule rather than waiting on ICE's.
- **Closing the tab warns you** while a transfer is in flight.

Verified end-to-end: the resume test kills a live link mid-file and checks the
received file's sha256 against the source, so a duplicated or dropped chunk at
the seam would fail the test.

## Tests

```bash
npm run signal           # in one terminal
npm run test:signal      # 28 protocol checks: session lifecycle, resume tokens,
                         # single-use lock, validation, rate limit, peer-drop

npm run dev:all          # in one terminal
npm run test:e2e         # drives two real Chrome tabs: a 3 MB transfer verified
                         # byte-for-byte, then a 64 MB transfer whose link is cut
                         # mid-flight and must resume and still match by sha256
RESUME_RUNS=5 npm run test:e2e   # repeat the resume scenario to shake out races
```

Both suites pass on the current tree (28 + 39 checks). Leave a minute between
them — the signal suite deliberately trips the 10-sessions-per-IP-per-minute
limit, which would otherwise refuse the e2e run's own session. And don't run
`next build` while `next dev` is live; they share `.next`.

## Deploy

**Signaling server → Railway** (or Render/Fly — anything that keeps a WebSocket
open; Vercel's serverless functions cannot).

1. New project → deploy from this repo → set the root directory to `server/`.
2. Set `ALLOWED_ORIGINS=https://your-app.vercel.app` and `NODE_ENV=production`.
3. Copy the public URL Railway gives you.

**Web app → Vercel.**

1. Import the repo (root directory = repo root).
2. Set `NEXT_PUBLIC_SIGNAL_URL` to the Railway URL from above.
3. Deploy. HTTPS is automatic, which is what WebRTC needs.

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
- **Expiry.** An unscanned code dies after 10 minutes, a half-dead transfer after
  2, and no session outlives an hour. Everything is in a `Map`; nothing is ever
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

- **Same network.** There is no TURN relay, so the two devices must be able to
  reach each other directly — same Wi-Fi, or one device on the other's hotspot.
  On a hotspot the file crosses the local Wi-Fi link and costs no mobile data;
  only the page load and handshake go over the network. Some office and hotel
  Wi-Fi blocks device-to-device traffic and will break it.
- **Files above 256 MB stream to disk**, which removes the memory ceiling — but
  only where the File System Access API exists (desktop Chrome/Edge). Elsewhere
  the receiver buffers in memory, so multi-gigabyte transfers to a phone can
  still fail. The sender warns above 2 GB.
- **Resume needs the page alive.** Backgrounding is survivable; a full reload
  loses the partial data, because it lives in the tab. Persisting progress to
  IndexedDB or a disk file handle would fix that.
- One file per session; zip client-side for multiple.

## Next up

Password-protected sessions, multi-file/folder support via `jszip`, transfer
history in `localStorage`, text/link sharing, and PWA install (needs 192/512 PNG
icons and a service worker).
