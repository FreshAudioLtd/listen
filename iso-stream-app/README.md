# ISO Mixer App

Streams individual, isolated mic channels (e.g. radio mics fed through a Dante Virtual
Soundcard) from one broadcasting device to up to 5 listeners — each listener taps to
choose any combination of channels to monitor live, over cellular data, wifi, or any mix
of the two.

This is a companion app to the main Fresh Audio broadcast tool, kept separate on purpose —
that app sends one mixed audio feed; this one sends each mic as its own track so listeners
can pick and choose.

## How it works

- **Broadcaster** opens `/broadcast.html`, picks the audio input device carrying the ISO
  feeds (e.g. the Dante Virtual Soundcard), names each detected channel, and goes live.
  The room code is fixed (`ISO` by default — set your own via the `ROOM_CODE` environment
  variable), so there's nothing to share each time.
- **Listeners** open `/listen.html` (pre-filled with that code), and see a list of every
  channel the broadcaster named. Tapping a channel starts playing it; tapping again mutes
  it. Any combination can be active at once.
- A small Node.js server only handles *signaling* (SDP/ICE messages, plus the channel
  name list) — it never touches the actual audio, so it stays cheap to run on a free tier.
- Each mic channel is its own WebRTC audio track, split out of the multi-channel input
  using the Web Audio API (`ChannelSplitterNode`) in the broadcaster's browser, and sent
  directly to each listener (through a TURN relay when a direct connection isn't
  possible, same as the main app).

## Setup

Same hosting approach as the main app: run `npm install && npm start` locally to try it,
then deploy to a host with a public HTTPS URL (Render free tier works well) and set the
same `METERED_TURN_USERNAME` / `METERED_TURN_CREDENTIAL` environment variables for a
reliable TURN relay on cellular. See the main app's README for the full walkthrough —
the steps are identical, just pointed at this app's folder.

## Using it

**Broadcasting:**
1. Open the site on the device connected to your multi-channel input (Dante Virtual
   Soundcard, an audio interface, etc.) and tap **Broadcast**.
2. Grant microphone permission, then pick the correct input device from the list —
   browsers only show device names after permission is granted once.
3. The app detects how many channels that device offers and shows a meter + name field
   for each one. Speak/play into each mic and confirm the right meter moves before
   relying on the auto-detected count — **browser support for high channel counts on a
   virtual sound card device varies, so double-check the meters rather than assuming the
   detected number is correct.** You can adjust the channel count and re-apply if needed.
4. Name each channel (e.g. "Vocal 1", "Guitar DI") and, optionally, tap the round photo
   button next to a channel to add a picture of that person/mic — listeners see it as the
   background of that channel's tile. Tap **Go Live**. Names and photos can still be
   changed while live — listeners see the update immediately.
5. Changing the input device or channel count requires tapping **Stop** and starting
   again.
6. Channel names and photos are remembered in this browser, by channel position — next
   time you broadcast (even after closing the tab), channel 1, 2, 3… are pre-filled with
   whatever you named/pictured them last time. Just overwrite a name or photo to update
   it. This is per-browser/device, not shared across the room code.

**Listening:**
1. Open the site, tap **Listen**, and tap **Join to Listen** (the code is pre-filled).
2. Every channel starts muted. Tap any channel to hear it; tap again to mute it. Listen
   to as many at once as you like.

## Known limitations

- **No per-channel volume — just mute/unmute.** This keeps the listener UI simple and
  avoids one more thing to get wrong live; if you need actual fader control later, that's
  a bigger follow-up (this app currently just toggles each channel's audio element on/off).
- **No guaranteed sample-accurate sync between channels.** Each channel is its own WebRTC
  track with its own independent jitter buffer on the receiving end. Listening to one
  channel at a time is completely fine. Listening to two closely related, bleed-prone mic
  sources *at the same time* could occasionally show a few milliseconds of drift between
  them — WebRTC doesn't give the sample-locked guarantees a real Dante/AES67 network does.
- **Bandwidth scales with channels × listeners.** Every listener receives every channel
  (so they can freely switch), and the broadcaster's browser encodes and uploads each
  channel separately to each connected listener (mesh, no media server in the middle).
  With 16 channels and 5 listeners that's meaningfully more upload load on the
  broadcasting machine than the single-stream app — a wired or solid wifi connection at
  the broadcast location is strongly recommended, especially with more than a handful of
  channels.
- **Shares the same Metered TURN relay quota** as the main broadcast app if you reuse the
  same credentials — multi-channel relay traffic will use it up faster. Keep an eye on
  usage in the Metered dashboard.
- **Only one broadcaster can be live on the fixed code at a time**, same as the main app —
  starting a new broadcast takes over the code from whichever device was already live.
- **5 listeners is the default cap**, adjustable via `MAX_LISTENERS`.
