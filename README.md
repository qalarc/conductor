# ◈ CONDUCTOR

**v1.0.0** — protocol frozen, integration-tested against MUSEALL v3.3
(headless-chromium CDP, 18/18 green; harness lives in the museall repo at
`tests/integration_conductor.js`).

A webcam hand-tracking **instrument**. It watches your hands (and optionally
your voice), turns them into ~50 normalised control sources, and **broadcasts
them to other apps** — primarily [MUSEALL](../museall_image_visualiser), a
music visualiser.

CONDUCTOR does not make sound or pictures itself. It is a *control surface*:
the performer's hands are the interface, and the consuming app decides what
those numbers mean. Think of it as a MIDI controller whose knobs are your
fingers.

It is a reimagining of the v5.x `gesture-mapper` demo. The gesture maths is
ported (pinch aperture, per-finger curl, spread, palm roll all behave the same,
so muscle memory carries over) but everything around it is new: modern
MediaPipe Tasks, ES modules with no build step, and a clean broadcast protocol
instead of an in-page binding UI.

---

## Running it

No build step, no dependencies. Just serve the directory:

```bash
./launch.sh          # foreground on port 2610
./launch.sh bg       # background, logs to /tmp/conductor_server.log
./launch.sh stop     # stop it
```

or plainly:

```bash
python3 -m http.server 2610
```

Then open:

| URL | What it is |
| --- | --- |
| `http://127.0.0.1:2610/index.html` | The instrument (standalone) |
| `http://127.0.0.1:2610/test.html`  | A bridge listener for debugging |

**The canonical URL when pairing with MUSEALL is same-origin instead** — see
[LINKING with MUSEALL](#linking-with-museall) below:

```
http://127.0.0.1:2601/conductor/index.html
```

**A secure context is required** for camera and microphone access.
`127.0.0.1` / `localhost` counts as secure, so local development is fine; any
other host needs https.

---

## LINKING with MUSEALL

`BroadcastChannel` is **same-origin only** — two pages on different ports
(2601 vs 2610) cannot see each other. So when CONDUCTOR and
[MUSEALL](../museall_image_visualiser) run together, serve CONDUCTOR **from
MUSEALL's own server** under `/conductor/`:

```bash
# one-off: symlink the repo into the museall project (gitignored there)
ln -s ../conductor_instrument  /home/fivelidz/projects/museall_image_visualiser/conductor

# museall's dev server (port 2601) follows the symlink — verify:
curl http://127.0.0.1:2601/conductor/index.html
```

Then:

1. Open **`http://127.0.0.1:2601/museall_v3/index.html`** (the visualiser).
2. Click the **⟠ EXT** pill in MUSEALL's header — it opens
   `/conductor/index.html` in a new tab, same origin.
3. The pill turns **green** and reads **`EXT 50`** (live source count) as soon
   as CONDUCTOR's hello/catalog arrive — which happens **before** any camera
   permission. A grey pill therefore means wrong origin or CONDUCTOR not
   open — never "camera not started yet".
4. MUSEALL's binding wizard immediately shows GESTURE / VOICE source chips;
   bind e.g. `gesture.r.pinch` → `vfx.liquify` and the param follows your
   hand at ~30 Hz.
5. Closing the CONDUCTOR tab (or its heartbeat stopping for >5 s) turns the
   pill grey again; bound values decay to zero over ~600 ms rather than
   sticking at their last value.

**Deployment:** both apps ship on the **same Cloudflare Pages project**
(`museall.qalarc.com`) — upload CONDUCTOR under the `/conductor/` path. Same
origin in production exactly as in dev; nothing else changes.

---

## The bridge protocol — `muse-bridge-v1`

This is the contract. Any app implementing the message shapes below can consume
CONDUCTOR. The canonical copy of this spec is the header comment of
[`bridge.js`](bridge.js).

### Transports

**1. `BroadcastChannel('muse-bridge-v1')`** — same-origin tabs and windows.
Zero setup: both pages open the channel and start talking. This is the primary
path; serve CONDUCTOR and MUSEALL from the same origin and it just works.

**2. `postMessage`** — cross-origin. Two ways to establish the link:

- CONDUCTOR was opened by the consumer (`window.open(...)`) → `window.opener`
  is targeted automatically.
- CONDUCTOR is loaded with `?target=<origin>` → any window that posts to us
  first is registered as a peer and replied to at that origin.

Payloads are byte-identical across both transports, so a consumer can use one
handler for both.

### Messages: producer → consumer

```jsonc
{ "type": "hello", "app": "conductor", "t": 1740000000000 }
```
Sent on start and every **2000 ms** as a heartbeat. Consumers should treat a
producer as dead after ~6 s of silence.

```jsonc
{ "type": "catalog", "app": "conductor",
  "sources": [ { "id": "gesture.r.pinch", "label": "Pinch (thumb–index)",
                 "group": "R HAND", "kind": "continuous" } ] }
```
Sent on start, when a new peer appears, and in reply to `ping`. Describes every
source that may appear in a `sources` message. `kind` is `"continuous"` or
`"event"`.

```jsonc
{ "type": "sources", "app": "conductor", "t": 1740000000000,
  "values": { "gesture.r.pinch": 0.42, "gesture.r.x": 0.61 } }
```
Sent at **~30 Hz** while the camera or mic is running. Every value is a number
in **0..1**. When nothing is producing, these stop entirely (the heartbeat
continues), so a consumer can distinguish live data from silence.

```jsonc
{ "type": "pong", "app": "conductor", "t": 1740000000000 }
```
Reply to a discovery `ping`.

### Messages: consumer → producer

```jsonc
{ "type": "ping" }                      // → replies with pong + catalog
{ "type": "hello", "app": "museall" }   // → appears in the BRIDGE peer list
```

### Value semantics

- **Continuous** sources are exponentially smoothed (α ≈ 0.3) and clamped
  to 0..1. They are safe to map directly onto a parameter.
- **Event** sources are **pulses**: the value spikes to `1` and returns to `0`
  after ~150 ms. At a 30 Hz send rate a consumer is guaranteed to observe at
  least four non-zero frames, so polling is sufficient — no edge detection or
  separate event channel is needed.
- `x` values are **mirrored** to match the mirrored preview: moving your hand
  to your right increases `x`.

---

## How MUSEALL consumes it

MUSEALL needs roughly fifteen lines:

```js
const ch = new BroadcastChannel('muse-bridge-v1');
let sources = {};                 // live values, read by the render loop

ch.onmessage = ({ data }) => {
  if (data.app === 'conductor') {
    if (data.type === 'catalog') buildBindingUI(data.sources);
    if (data.type === 'sources') sources = data.values;
  }
};

ch.postMessage({ type: 'hello', app: 'museall' });   // announce + heartbeat
ch.postMessage({ type: 'ping' });                    // request the catalog

// …then in the existing render loop, drive whatever you like:
fx.bloom     = sources['gesture.r.pinch']  ?? 0;
fx.hue       = sources['gesture.l.roll']   ?? 0;
if (sources['gesture.r.swipeR'] > 0.5) deck.next();
```

The `catalog` message is what makes this pleasant: MUSEALL can render a
source-picker dropdown without hard-coding any ids, and new CONDUCTOR sources
appear automatically.

A working reference consumer is [`test.html`](test.html) — open it alongside
`index.html` to watch the traffic.

---

## Source catalog

**50 sources** = 15 right hand + 15 left hand + 4 two-hand + 12 events + 4 voice.
Continuous unless marked ⚡ (event pulse).

### R HAND / L HAND (15 each — `gesture.r.*` / `gesture.l.*`)

| id suffix | meaning |
| --- | --- |
| `pinch` | thumb↔index aperture — 0 pinched, 1 wide open |
| `pinch.middle` `pinch.ring` `pinch.pinky` | same, thumb vs each other finger |
| `curl.index` `curl.middle` `curl.ring` `curl.pinky` | per-finger curl — 0 straight, 1 fully curled |
| `spread` | index tip → pinky tip, normalised by palm size |
| `x` `y` | palm centre position (x mirrored) |
| `wrist.x` `wrist.y` | wrist position |
| `roll` | palm roll from the knuckle line, −180..180° → 0..1 |
| `z` | depth relative to the wrist |

### TWO-HAND (4 — `gesture.two.*`)

`spread` (distance between palms) · `x` `y` (midpoint) · `angle` (wrist axis)

### EVENTS (12 ⚡)

`gesture.{r,l}.swipeL` `swipeR` `swipeU` `swipeD` · `pinchStart` · `pinchEnd`

Swipes are velocity-based over an 8-frame wrist window with a 350 ms cooldown.
Pinch events use a Schmitt trigger (close < 0.22, open > 0.35) so they don't
chatter at the threshold.

### VOICE (4 — `voice.*`)

`level` (RMS) · `pitch` (autocorrelation f0, 80–800 Hz, log-mapped) ·
`centroid` (spectral brightness) · `onset` ⚡ (spectral-flux transient)

---

## Voice

Voice lives in its own module ([`voice.js`](voice.js)) behind its own panel and
its own permission prompt, deliberately separate from both the gesture engine
and MUSEALL. It does two things:

1. **Analysis → bridge.** The four `voice.*` sources above, broadcast over the
   same bridge as the gesture sources.
2. **A local FX chain.** mic → highpass → distortion → resonant lowpass →
   dry / delay / convolver-reverb → master.

The reverb impulse response is generated procedurally, so there are no audio
assets to ship. Everything uses stock WebAudio nodes — **no AudioWorklet**,
so there is no worklet file to serve and no cross-origin-isolation requirement.
True pitch-shifting does need a worklet and is intentionally out of scope; the
filter and drive give plenty of timbral movement.

> ⚠ **Monitoring is OFF by default.** Enabling it routes the mic to your
> speakers and *will* feed back without headphones. The UI confirms before
> turning it on. Analysis and broadcast work perfectly with monitoring off.

---

## Files

```
index.html          instrument UI — stage, SOURCES, BRIDGE, VOICE panels
app.js              wiring + render loop; owns the DOM, engines own the maths
gesture-engine.js   HandLandmarker wrapper → normalised source catalog
overlay.js          skeleton overlay — bones, pinch circle, trails, roll axis
voice.js            mic capture, analysis, local FX chain
bridge.js           THE PROTOCOL — BroadcastChannel + postMessage
styles.css          synthwave theme, matched to MUSEALL
test.html           reference consumer / debug listener
launch.sh           no-cache dev server on port 2610
tests/harness.js    headless-chromium CDP verification (33 checks, no camera)
```

MediaPipe versions are **pinned** in `gesture-engine.js`
(`@mediapipe/tasks-vision@0.10.14`, `hand_landmarker` float16/1). Do not float
them — a Tasks major bump changes the API.

---

## Testing status

`cd tests && npm install && node harness.js` → **33/33 passing**.
Automated (headless chromium via CDP, no camera or mic present):

- ✅ page boots with **zero console errors** and no failed requests
- ✅ degrades gracefully with no camera — shows the "no camera" state rather
  than throwing
- ✅ bridge broadcasts `hello` and `catalog`; replies to `ping` with `pong`
  — verified from a *second browser page*, not by introspection
- ✅ catalog contains all 50 sources with well-formed ids
- ✅ SOURCES panel renders every source; VOICE panel renders with FX sliders
- ✅ peer discovery: CONDUCTOR lists the listener within one heartbeat
- ✅ an idle producer sends no `sources` frames (heartbeat only)
- ✅ event pulses spike to 1 and return to 0 within ~150 ms
- ✅ MediaPipe versions pinned; GPU delegate with CPU fallback

Needs a human at a real machine:

- ⚠ **camera** — hand tracking, overlay accuracy, per-source feel and range,
  swipe/pinch thresholds. Headless chromium has no webcam, so none of the
  gesture maths is exercised end to end.
- ⚠ **microphone** — pitch tracking accuracy, onset sensitivity, FX chain
  audio quality, monitoring/feedback behaviour.
- ⚠ **latency** — end-to-end hand-movement → MUSEALL-pixel latency.

---

## Roadmap

- [x] **MUSEALL consumer** — shipped in MUSEALL v3.3 (`ext-bridge.js` +
      catalog-driven binding wizard); integration-tested headless, 18/18
- [ ] **Binding/curve layer** — per-source range, curve (ease/exp/log/invert)
      and invert, so a consumer receives pre-shaped values
- [ ] **Presets** — save/load named source→target mappings
- [ ] **WebSocket transport** — for a second machine or a native consumer;
      the message shapes are already transport-agnostic
- [ ] **MIDI out** — CC messages, so CONDUCTOR can drive hardware synths
- [ ] **Pitch shifting** — needs an AudioWorklet (OLA or phase vocoder)
- [ ] **Gesture recording** — capture a source stream and replay it, so
      consumers can be developed and tested without a camera
- [ ] **Pose/face sources** — MediaPipe also ships pose and face landmarkers;
      the same catalog/bridge design extends to them unchanged
