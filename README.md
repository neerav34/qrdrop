# QRDrop

Send a file from one device to another by scanning a QR code. The file goes
straight between the two browsers over an encrypted WebRTC data channel — no
upload, no cloud storage, no account, and no server that can see the bytes.

```
Sender picks a file ──► QR code appears (it holds a session link, not the file)
                              │
Receiver scans it ────────────┘
                              │
        Both browsers hand each other an address via the signaling server
                              │
        File streams device → device, 16 KB at a time
```

## What's in here

| Path | What it is |
|---|---|
| [app/](app/) | Next.js pages: home, `/send`, `/receive` (camera scanner), `/r/[id]` (the scanned link) |
| [lib/peer.ts](lib/peer.ts) | The whole transfer engine — signaling, WebRTC setup, chunking, backpressure |
| [lib/protocol.ts](lib/protocol.ts) | Shared constants and message shapes for both sides |
| [components/Receiver.tsx](components/Receiver.tsx) | Receiver UI, shared by the scanned link route |
| [server/](server/) | Socket.io signaling server — relays SDP/ICE only, deployed separately |
| [test/](test/) | Protocol tests + a real-Chrome two-tab transfer test |

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
not one. So LAN testing over plain HTTP will fail on the phone. Two options:

- **Deploy first, test on the deployed URL.** This is the fastest path and it's
  what the transfer is actually meant to run on.
- Or tunnel: `npx localtunnel --port 3000` (and a second tunnel for :4000, with
  `NEXT_PUBLIC_SIGNAL_URL` pointed at it).

## Tests

```bash
npm run signal           # in one terminal
npm run test:signal      # 12 protocol checks: session lifecycle, single-use lock,
                         # input validation, rate limit, peer-drop notification

npm run dev:all          # in one terminal
npm run test:e2e         # drives two real Chrome tabs through a 3 MB transfer and
                         # sha256-compares the received file against the source
```

Both suites pass on the current tree. Leave a minute between them — the signal
suite deliberately trips the 10-sessions-per-IP-per-minute limit, which would
otherwise refuse the e2e run's own session.

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
  specification — it isn't an option that can be switched off, and the signaling
  server only ever sees SDP text.
- **Session IDs are `crypto.randomUUID()`** — 122 bits of randomness, not guessable.
- **Single use.** Once a receiver accepts, the session is locked to those two
  peers; a third device scanning the same code is refused. Covered by a test.
- **10-minute expiry.** Sessions live in a `Map` and are swept out; nothing is
  ever written to disk.
- **Input validation and rate limiting** on the server: file metadata is
  type/length checked, malformed SDP is dropped rather than relayed, and session
  creation is capped at 10 per IP per minute.
- **CORS** is restricted to `ALLOWED_ORIGINS` in production; private-network
  origins are additionally allowed when `NODE_ENV !== "production"` so LAN
  testing works.
- The receiver sees the file name and size and must press **Accept** before any
  connection is made.

## Known limits

- **Same network.** There is no TURN relay, so transfers work when the two
  devices can reach each other directly — same Wi-Fi, typically. Adding a TURN
  server would fix cross-network transfers but costs money to run.
- **The receiver buffers the file in memory** before saving, so multi-gigabyte
  transfers can fail on phones. The sender warns above 2 GB. Streaming to disk
  via the File System Access API would lift this on desktop Chrome.
- One file per session; zip client-side for multiple.

## Next up

Password-protected sessions, multi-file/folder support via `jszip`, transfer
history in `localStorage`, and text/link sharing — see the project plan.
