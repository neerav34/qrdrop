# Deploying QRDrop for free

QRDrop is two pieces, and they need two different kinds of host:

| Piece | What it needs | Where it goes |
|---|---|---|
| The web app (`/`) | Static + serverless rendering | **Vercel** — free Hobby plan |
| The signaling server (`/server`) | A process holding open WebSockets | **Render** — free Web Service |

They have to be split because Vercel's serverless functions can't hold a
WebSocket open, and signaling is nothing but a long-lived socket.

**Order matters:** deploy the signaling server first, because the web app needs
its URL at build time (it's a `NEXT_PUBLIC_` variable, so it's baked into the
bundle).

**Live deployment**

| Piece | URL |
|---|---|
| Signaling server (Render) | <https://qrdrop-u0kg.onrender.com> — check `/healthz` |
| Web app (Vercel) | _not deployed yet_ |

> Free tiers change often. The shapes below were correct when this was written —
> confirm the current limits when you sign up rather than trusting this file.

---

## Part 1 — Signaling server on Render

1. Go to **render.com** and sign up with your GitHub account.
2. **New → Web Service**, then connect the `neerav34/qrdrop` repo. If Render
   can't see it, use *Configure account* and grant access to that repo
   (it's private, so this step is required).
3. Fill in the service:

   | Field | Value |
   |---|---|
   | Name | `qrdrop-signal` |
   | Language / Runtime | `Node` |
   | Branch | `main` |
   | **Root Directory** | `server` |
   | Build Command | `npm install` |
   | Start Command | `node index.js` |
   | Instance Type | **Free** |

   The root directory is the important one — it makes Render build only the
   signaling server and ignore the Next.js app.

4. Under **Environment Variables**, add:

   ```
   NODE_ENV = production
   ```

   Leave `ALLOWED_ORIGINS` out for now; you'll add it in Part 3 once you know
   your Vercel URL.

   Render prefills `PORT=10000`, which is fine to leave — the server reads
   `process.env.PORT`. Just make sure the value is digits only. A stray character
   makes Node treat it as a socket path rather than a port, and the deploy hangs
   on "No open ports detected"; the server now warns and falls back to 4000
   rather than failing silently.

5. **Create Web Service** and wait for the first build (a minute or two).
6. When it's live, Render shows a URL like
   `https://qrdrop-signal.onrender.com`. Open `…/healthz` in a browser — you
   should see `{"ok":true,"sessions":0}`. **Copy that base URL.**

---

## Part 2 — Web app on Vercel

1. Go to **vercel.com**, sign up with GitHub.
2. **Add New → Project**, import `neerav34/qrdrop`. Grant repo access if asked.
3. Leave the framework as **Next.js** and the root directory as the repo root —
   both are auto-detected. Don't change the build settings.
4. Expand **Environment Variables** and add, using the URL from Part 1:

   ```
   NEXT_PUBLIC_SIGNAL_URL = https://qrdrop-u0kg.onrender.com
   ```

   No trailing slash. It must be `https`, not `http`, or the browser will block
   it as mixed content.

5. **Deploy.** You'll get a URL like `https://qrdrop.vercel.app`. HTTPS is
   automatic, which is exactly what WebRTC and the camera require.

---

## Part 3 — Lock the signaling server to your site

Back in Render → your service → **Environment**:

```
ALLOWED_ORIGINS = https://qrdrop.vercel.app
```

Use your real Vercel domain, no trailing slash. Save; Render redeploys.

This is what stops any other website from driving your signaling server. Until
you set it, the server accepts every origin.

> If you later add a custom domain, or want Vercel's preview deployments to
> work, list them comma-separated:
> `https://qrdrop.vercel.app,https://qrdrop.example.com`

---

## Part 4 — Test it on two real devices

This is the first test that proves the whole thing, because localhost can't.

1. Open your Vercel URL on your **laptop**. Pick a file.
2. Point your **phone's normal camera** at the QR code and open the link.
3. Tap **Accept & receive**.

For the transfer itself the two devices must be able to reach each other
directly, so either:

- both on the same Wi-Fi, **or**
- laptop connected to the phone's **hotspot** — this works well, and the file
  crosses the local Wi-Fi link rather than your data plan.

If the sender says **"Direct · same network"**, the bytes went straight across
with no server in the path. That line is read back off the negotiated ICE
candidate pair, so it's a measurement, not a claim.

---

## The one real cost of free hosting

Render's free tier **spins the service down after about 15 minutes of
inactivity**, and waking it takes 30–60 seconds. That would land squarely on
your first user, so the app handles it:

- Loading any page immediately pings `/healthz`
  ([components/Prewarm.tsx](components/Prewarm.tsx)), so the server starts
  booting while you're still picking a file.
- A failed first connection isn't treated as an error. The client keeps retrying
  for ~80 seconds and says *"Waking up the connection server — free hosting can
  take up to a minute"* instead of claiming it's unreachable.
- `npm run test:coldstart` is a regression test for exactly this: it points the
  page at a dead server, checks it waits rather than fails, then boots the server
  and checks it recovers with no reload.

**If you want it always warm**, point a free uptime pinger (cron-job.org,
UptimeRobot) at `https://<your-render-url>/healthz` every 10 minutes. Render's
free allowance covers one service running continuously, so this stays free —
just don't add a second always-on service.

---

## Deploys after this

Both hosts watch the repo. `git push` redeploys both automatically:

```bash
git push
```

Change `NEXT_PUBLIC_SIGNAL_URL` and you must **redeploy** Vercel, not just save
the variable — it's compiled into the client bundle.

---

## If something doesn't work

| What you see | Cause | Fix |
|---|---|---|
| `No open ports detected, continuing to scan...` and the log says `listening on …:10000??` or similar | A stray character in the host's `PORT` variable. Node reads a non-numeric string as a Unix socket path, so it opens no TCP port at all | Delete the `PORT` variable (Render injects it) or retype it as digits only, then redeploy |
| "Can't reach the signaling server" | Wrong `NEXT_PUBLIC_SIGNAL_URL`, or set after deploying | Fix it, then **redeploy** Vercel |
| Stuck on "Waking up the connection server" for minutes | Render service failed to boot | Check Render → Logs |
| Sender shows the QR, receiver says "expired or already finished" | The 10-minute code lapsed, or it was already used once | Codes are single-use by design — generate a new one |
| Everything connects, then "Peer-to-peer link failed" | The two devices can't reach each other | Same Wi-Fi, or use a hotspot. Some office/hotel Wi-Fi blocks device-to-device traffic |
| Camera won't open on `/receive` | Not HTTPS | Use the Vercel URL, not a LAN IP |
| CORS / connection refused in the console | `ALLOWED_ORIGINS` doesn't match your domain exactly | Include the scheme, no trailing slash |
| Transfer works laptop↔laptop but not to your phone | Usually the same-network issue above | Try the hotspot route to confirm |

---

## What this costs

| | Plan | Cost |
|---|---|---|
| Vercel | Hobby | £0 — non-commercial use only, which a portfolio project is |
| Render | Free Web Service | £0 — sleeps when idle, no card needed |
| Domain | `*.vercel.app` | £0 (a custom domain is ~£8/year if you want one) |
| Bandwidth for transfers | — | £0, because file bytes never touch either host |

That last row is the interesting one: the only traffic your hosts ever see is
page loads and a few KB of handshake per transfer. The files themselves go
device to device, so a thousand 1 GB transfers cost you nothing.
