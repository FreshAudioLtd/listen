# Audio Stream App

Stream live audio from one device's microphone (or a line-in source plugged into
it) to up to 5 other devices listening in real time — over cellular data, wifi,
or any mix of the two. Built with WebRTC, so audio goes directly between devices
(or through a TURN relay) — low latency, and no audio data passes through the
app server itself.

Tested end-to-end locally (5 simultaneous listeners, all receiving live audio,
6th listener correctly rejected) before delivery.

## How it works

- **Broadcaster** opens `/broadcast.html` and grants microphone access — the
  room code is always the same fixed code (`FRESH` by default, see below),
  so there's nothing to share each time.
- **Listeners** open `/listen.html`, which is pre-filled with that code (or
  tap a shared link), and hear the broadcaster's audio live.
- A small Node.js server only handles *signaling* (tiny text messages to set up
  each connection) — it does **not** carry the actual audio, so it stays cheap
  to run even on a free hosting tier.
- The actual audio flows peer-to-peer over WebRTC, using a TURN server to relay
  it when a direct connection isn't possible (very common on cellular networks,
  which sit behind carrier-grade NAT).

## 1. Run it locally first (optional but recommended)

```bash
npm install
npm start
```

Open `http://localhost:3000` in two browser tabs to try it — one as broadcaster,
one as listener. (On localhost, mic access works over plain HTTP; once deployed,
you'll be on HTTPS automatically, which is required for microphone access.)

## 2. Deploy so phones on cellular can reach it

You need this running somewhere with a public HTTPS URL. **Render's free tier**
is the easiest path:

1. Push this folder to a new GitHub repo (or use Render's "public Git repo"
   option if you don't want to make one).
2. Go to [render.com](https://render.com) → **New +** → **Web Service** →
   connect your repo.
3. Render should auto-detect Node. If asked:
   - Build command: `npm install`
   - Start command: `npm start`
4. Click **Create Web Service**. You'll get a URL like
   `https://your-app.onrender.com`.
5. Open that URL on the broadcasting device and each listening device.

A `render.yaml` is included if you prefer Render's one-click **Blueprint**
deploy instead of the manual steps above.

**Free-tier note:** Render's free web services spin down after inactivity and
take ~30–50 seconds to wake up on the next request. If you want the app ready
instantly whenever you go to broadcast, either open the URL a minute before you
start, or upgrade to Render's paid tier (~$7/mo) for an always-on instance.
(Railway, Fly.io, etc. work too — same `npm install` / `npm start` setup, just
follow whichever platform's own deploy flow.)

## 3. Get your own free TURN server (do this — it's what makes cellular work)

Cellular carriers almost always put phones behind NAT that a direct
peer-to-peer connection can't punch through, so in practice **you need a TURN
server for this app to reliably work over cellular data**. The app ships with
a fallback (Google's public STUN server + the Open Relay Project's old shared
TURN credentials), but Metered — who run Open Relay — now require a free
account to use their TURN service, so that shared fallback is best-effort only
and may simply fail to connect once both devices are on cellular. Don't rely
on it for anything real.

Get your own free TURN credentials (~2 minutes, no credit card):

1. Sign up free at [metered.ca](https://www.metered.ca/) (Global TURN Server
   product).
2. Create an app — it gives you a subdomain (e.g. `yourapp`, part of
   `yourapp.metered.live`) and an API key.
3. On Render, go to your service → **Environment**, and add:
   - `METERED_SUBDOMAIN` = `yourapp`
   - `METERED_API_KEY` = `your-api-key`
4. Redeploy (Render does this automatically when env vars change).

The server will now fetch fresh, private TURN credentials automatically — no
code changes needed. The free tier includes 500 MB/month of TURN relay
traffic plus a $30 signup credit. Audio-only streaming is low-bandwidth
(roughly 15–30 MB/hour per relayed listener), so that covers meaningful
testing; for frequent or long sessions, keep an eye on usage in the Metered
dashboard and add a card for pay-as-you-go if needed.

## Using it

**Broadcasting:**
1. Open the site on the device with the mic/audio input you want to send.
2. Tap **Broadcast** → **Start Broadcasting** → allow microphone access.
   - If you're feeding in an external source (instrument, mixer, etc. via an
     input adapter), select it as the input device in your browser/OS
     permission prompt before starting.
3. Share the room code (or the link under it) with up to 5 listeners.
4. Keep the tab open, in the foreground, with the screen on — see limitations
   below.

**Listening:**
1. Open the site on the listening device.
2. Tap **Listen**, enter the code (or open the shared link, which prefills it),
   and tap **Join Broadcast**.
3. Adjust volume with the on-screen slider.

## Known limitations

- **This is a web app, not a native app**, so mobile browsers suspend
  microphone capture and audio playback when the tab is backgrounded or the
  screen locks. Keep the broadcasting and listening tabs in the foreground
  with the screen on. The app requests a screen wake lock automatically where
  supported, but you should still disable auto-lock for long sessions.
- **The room code is fixed** (`FRESH` by default) rather than randomly
  generated — set your own via the `ROOM_CODE` environment variable. If the
  broadcaster's connection drops and reconnects (e.g. a cellular handoff kills
  the WebSocket), it re-hosts under the same code automatically, so listeners
  don't need a new one.
- **Only one broadcaster can be live on the fixed code at a time.** Starting a
  new broadcast takes over the code from whichever device was already
  broadcasting — that device is disconnected and shown a message, and its
  listeners see "the broadcast ended" until they rejoin the new one.
- **5 listeners is the default cap**, adjustable via the `MAX_LISTENERS`
  environment variable — mesh WebRTC (one broadcaster connecting directly to
  each listener) scales fine to that range; going much higher would need a
  dedicated SFU media server instead of this architecture.
- Audio quality/latency depends on both parties' connections, as with any
  live call; typical latency is well under a second on decent cellular data.

## Troubleshooting

- **No sound on the listener side:** tap "Join Broadcast" again — some mobile
  browsers (notably iOS Safari) block audio autoplay until you've interacted
  with the page at least once per session.
- **Never connects / spinner forever:** almost always a TURN issue — try the
  "get your own TURN credentials" step above, since the shared fallback can be
  congested or occasionally rate-limited.
- **Mic permission denied:** the site must be served over HTTPS (it will be,
  once deployed) — browsers block mic access on plain HTTP except for
  localhost.
