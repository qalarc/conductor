/* ═══════════════════════════════════════════════════════════════════════════
   CONDUCTOR — gesture-engine.js
   ---------------------------------------------------------------------------
   MediaPipe @mediapipe/tasks-vision HandLandmarker wrapper that turns raw hand
   landmarks into a NORMALISED SOURCE CATALOG (every continuous value 0..1,
   exponentially smoothed) plus discrete EVENT PULSES.

   Derivations ported/modernised from the v5.x gesture-mapper
   (~/projects/gesture-control/web/js/gesture-engine.js) — the maths for
   pinchAperture, per-finger curl, spread and palmRoll is preserved so muscle
   memory from the old instrument carries over.

   Key modernisation vs the original:
     - legacy @mediapipe/hands (global `Hands` + camera_utils) is GONE.
       We use HandLandmarker.detectForVideo() driven by our own rAF loop.
     - GPU delegate with automatic CPU fallback.
     - Handedness comes from MediaPipe's `handedness` categories.

   ── LANDMARK INDEX REFERENCE ──────────────────────────────────────────────
     0  wrist
     1-4   thumb  (cmc, mcp, ip,  tip)
     5-8   index  (mcp, pip, dip, tip)
     9-12  middle (mcp, pip, dip, tip)
     13-16 ring   (mcp, pip, dip, tip)
     17-20 pinky  (mcp, pip, dip, tip)
   ═════════════════════════════════════════════════════════════════════════ */

// Pinned versions — do not float these, a tasks-vision major bump changes the API.
const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const WASM_ROOT        = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL        = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// ─── Landmark groups ────────────────────────────────────────────────────────
const TIPS = { thumb: 4,  index: 8,  middle: 12, ring: 16, pinky: 20 };
const PIPS = { thumb: 3,  index: 6,  middle: 10, ring: 14, pinky: 18 };
const DIPS = { thumb: 3,  index: 7,  middle: 11, ring: 15, pinky: 19 };
const MCPS = { thumb: 2,  index: 5,  middle: 9,  ring: 13, pinky: 17 };

/** Bone connections for the skeleton overlay (ported from gesture-renderer). */
export const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],            // thumb
  [0,5],[5,6],[6,7],[7,8],            // index
  [5,9],[9,10],[10,11],[11,12],       // middle
  [9,13],[13,14],[14,15],[15,16],     // ring
  [13,17],[17,18],[18,19],[19,20],    // pinky
  [0,17],                             // palm base
];

// ─── Tunables (ported constants) ────────────────────────────────────────────
const PINCH_MAX          = 0.18;  // approx max thumb↔finger distance (normalised)
const SMOOTHING          = 0.3;   // exponential smoothing factor for source values
const LANDMARK_SMOOTHING = 0.45;  // separate, lighter smoothing for drawn landmarks
const SWIPE_HISTORY      = 8;     // frames of wrist history kept for velocity
const SWIPE_THRESHOLD    = 1.1;   // normalised units/second to count as a swipe
const SWIPE_COOLDOWN_MS  = 350;   // debounce so one flick = one event
const PINCH_CLOSE        = 0.22;  // aperture below this = pinch engaged
const PINCH_OPEN         = 0.35;  // aperture above this = pinch released (hysteresis)
const EVENT_PULSE_MS     = 150;   // how long a discrete event holds at 1.0

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ───────────────────────────────────────────────────────────────────────────
   SOURCE CATALOG
   The single source of truth for what CONDUCTOR broadcasts. The bridge sends
   this verbatim as its `catalog` message, and the UI builds its bars from it.
   `kind` is 'continuous' (smoothed 0..1) or 'event' (pulse to 1 for 150ms).
   ─────────────────────────────────────────────────────────────────────────── */
export const SOURCE_CATALOG = [
  // ── Right hand ──
  { id: 'gesture.r.pinch',        label: 'Pinch (thumb–index)', group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.pinch.middle', label: 'Pinch middle',        group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.pinch.ring',   label: 'Pinch ring',          group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.pinch.pinky',  label: 'Pinch pinky',         group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.curl.index',   label: 'Curl index',          group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.curl.middle',  label: 'Curl middle',         group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.curl.ring',    label: 'Curl ring',           group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.curl.pinky',   label: 'Curl pinky',          group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.spread',       label: 'Spread (all)',        group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.x',            label: 'Palm X',              group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.y',            label: 'Palm Y',              group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.wrist.x',      label: 'Wrist X',             group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.wrist.y',      label: 'Wrist Y',             group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.roll',         label: 'Palm roll',           group: 'R HAND',   kind: 'continuous' },
  { id: 'gesture.r.z',            label: 'Depth (Z)',           group: 'R HAND',   kind: 'continuous' },

  // ── Left hand ──
  { id: 'gesture.l.pinch',        label: 'Pinch (thumb–index)', group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.pinch.middle', label: 'Pinch middle',        group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.pinch.ring',   label: 'Pinch ring',          group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.pinch.pinky',  label: 'Pinch pinky',         group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.curl.index',   label: 'Curl index',          group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.curl.middle',  label: 'Curl middle',         group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.curl.ring',    label: 'Curl ring',           group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.curl.pinky',   label: 'Curl pinky',          group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.spread',       label: 'Spread (all)',        group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.x',            label: 'Palm X',              group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.y',            label: 'Palm Y',              group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.wrist.x',      label: 'Wrist X',             group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.wrist.y',      label: 'Wrist Y',             group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.roll',         label: 'Palm roll',           group: 'L HAND',   kind: 'continuous' },
  { id: 'gesture.l.z',            label: 'Depth (Z)',           group: 'L HAND',   kind: 'continuous' },

  // ── Two-hand ──
  { id: 'gesture.two.spread',     label: 'Hands apart',         group: 'TWO-HAND', kind: 'continuous' },
  { id: 'gesture.two.x',          label: 'Midpoint X',          group: 'TWO-HAND', kind: 'continuous' },
  { id: 'gesture.two.y',          label: 'Midpoint Y',          group: 'TWO-HAND', kind: 'continuous' },
  { id: 'gesture.two.angle',      label: 'Wrist axis angle',    group: 'TWO-HAND', kind: 'continuous' },

  // ── Discrete events (pulse to 1.0 for EVENT_PULSE_MS then decay to 0) ──
  { id: 'gesture.r.swipeL',       label: 'R swipe ←',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.r.swipeR',       label: 'R swipe →',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.r.swipeU',       label: 'R swipe ↑',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.r.swipeD',       label: 'R swipe ↓',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.r.pinchStart',   label: 'R pinch start',       group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.r.pinchEnd',     label: 'R pinch end',         group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.l.swipeL',       label: 'L swipe ←',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.l.swipeR',       label: 'L swipe →',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.l.swipeU',       label: 'L swipe ↑',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.l.swipeD',       label: 'L swipe ↓',           group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.l.pinchStart',   label: 'L pinch start',       group: 'EVENTS',   kind: 'event' },
  { id: 'gesture.l.pinchEnd',     label: 'L pinch end',         group: 'EVENTS',   kind: 'event' },
];

/** Fresh per-hand tracking state. */
function newHandState() {
  return {
    present: false,
    landmarks: null,          // raw, this frame
    smoothed: null,           // smoothed, for drawing
    metrics: null,
    history: [],              // wrist positions for swipe velocity
    pinching: false,
    lastSwipeAt: 0,
    trail: [],                // index-fingertip motion trail
  };
}

export class GestureEngine {
  constructor() {
    this.landmarker = null;
    this.video      = null;
    this.stream     = null;
    this.running    = false;
    this.ready      = false;
    this.delegate   = null;   // 'GPU' | 'CPU' — which one actually loaded
    this.error      = null;

    this.hands  = { Right: newHandState(), Left: newHandState() };
    this.values = {};         // id -> smoothed 0..1
    this._eventUntil = {};    // id -> timestamp the pulse ends
    this._eventTimers = {};   // id -> setTimeout handle that clears the pulse
    this._lastVideoTime = -1;

    this.fps = 0;
    this._frames = 0;
    this._fpsAt = performance.now();

    // Every catalog id starts at 0 so consumers never see `undefined`.
    for (const s of SOURCE_CATALOG) this.values[s.id] = 0;
  }

  /* ─── Model loading ──────────────────────────────────────────────────────
     Dynamic import so that a CDN failure is catchable and the page can
     degrade gracefully instead of dying at parse time.                     */
  async init() {
    if (this.ready) return true;
    let vision;
    try {
      vision = await import(/* @vite-ignore */ `${TASKS_VISION_URL}/vision_bundle.mjs`);
    } catch (e) {
      this.error = `Could not load MediaPipe tasks-vision: ${e.message}`;
      return false;
    }

    const { HandLandmarker, FilesetResolver } = vision;
    const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);

    // GPU first, silently fall back to CPU (some headless/VM setups have no GL).
    for (const delegate of ['GPU', 'CPU']) {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions:  { modelAssetPath: MODEL_URL, delegate },
          runningMode:  'VIDEO',
          numHands:     2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence:  0.5,
          minTrackingConfidence:      0.5,
        });
        this.delegate = delegate;
        this.ready = true;
        return true;
      } catch (e) {
        this.error = e.message;
      }
    }
    return false;
  }

  /* ─── Camera lifecycle ─────────────────────────────────────────────────── */

  /** Start webcam + detection loop. Returns {ok} or {ok:false, reason}. */
  async start(videoEl) {
    if (this.running) return { ok: true };

    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, reason: 'no-camera-api' };
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
    } catch (e) {
      // NotFoundError = no device; NotAllowedError = permission denied.
      return { ok: false, reason: e.name === 'NotFoundError' ? 'no-camera' : 'denied', detail: e.message };
    }

    if (!this.ready) {
      const ok = await this.init();
      if (!ok) {
        this.stop();
        return { ok: false, reason: 'model-failed', detail: this.error };
      }
    }

    this.video = videoEl;
    videoEl.srcObject = this.stream;
    await videoEl.play();

    this.running = true;
    this._loop();
    return { ok: true };
  }

  stop() {
    this.running = false;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
    // Cancel in-flight event pulses so none land after the camera is gone.
    for (const id in this._eventTimers) clearTimeout(this._eventTimers[id]);
    this._eventTimers = {};
    this._eventUntil = {};
    this.hands = { Right: newHandState(), Left: newHandState() };
    for (const s of SOURCE_CATALOG) this.values[s.id] = 0;
    this.fps = 0;
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();

    if (this.video && this.video.readyState >= 2 && this.video.currentTime !== this._lastVideoTime) {
      this._lastVideoTime = this.video.currentTime;
      try {
        const res = this.landmarker.detectForVideo(this.video, now);
        this._consume(res, now);
      } catch (e) {
        // A single bad frame must never kill the loop.
        console.warn('[gesture] detect failed:', e.message);
      }
      this._frames++;
    }

    // FPS every ~500ms
    if (now - this._fpsAt >= 500) {
      this.fps = Math.round((this._frames * 1000) / (now - this._fpsAt));
      this._frames = 0;
      this._fpsAt = now;
    }

    requestAnimationFrame(() => this._loop());
  }

  /* ─── Frame consumption ────────────────────────────────────────────────── */

  _consume(res, now) {
    const seen = new Set();
    const marks = res?.landmarks || [];

    for (let i = 0; i < marks.length; i++) {
      // MediaPipe reports handedness from the CAMERA's point of view. With a
      // front-facing (mirrored) camera the user's right hand is labelled
      // "Left", so we flip it to match what the performer perceives.
      const raw   = res.handednesses?.[i]?.[0]?.categoryName || 'Right';
      const label = raw === 'Left' ? 'Right' : 'Left';
      seen.add(label);

      const st = this.hands[label];
      st.present   = true;
      st.landmarks = marks[i];
      st.smoothed  = this._smoothLandmarks(marks[i], st.smoothed);
      st.metrics   = this._metrics(st.smoothed);

      // Wrist history drives swipe velocity.
      const wrist = st.smoothed[0];
      st.history.push({ x: wrist.x, y: wrist.y, t: now });
      if (st.history.length > SWIPE_HISTORY * 2) st.history.shift();

      // Fingertip trail for the overlay.
      const tip = st.smoothed[TIPS.index];
      st.trail.push({ x: tip.x, y: tip.y, t: now });
      if (st.trail.length > 24) st.trail.shift();

      this._writeHandSources(label, st, now);
    }

    // Hands that vanished: reset so stale values don't stick at their last position.
    for (const label of ['Right', 'Left']) {
      if (!seen.has(label) && this.hands[label].present) {
        this.hands[label] = newHandState();
        const p = label === 'Right' ? 'gesture.r' : 'gesture.l';
        for (const s of SOURCE_CATALOG) {
          if (s.kind === 'continuous' && s.id.startsWith(p + '.')) this.values[s.id] = 0;
        }
      }
    }

    this._writeTwoHandSources();
  }

  /** Exponential smoothing on landmark positions (keeps the skeleton calm). */
  _smoothLandmarks(fresh, prev) {
    if (!prev || prev.length !== fresh.length) return fresh.map(p => ({ ...p }));
    const a = LANDMARK_SMOOTHING;
    return fresh.map((p, i) => ({
      x: prev[i].x + (p.x - prev[i].x) * a,
      y: prev[i].y + (p.y - prev[i].y) * a,
      z: (prev[i].z ?? 0) + ((p.z ?? 0) - (prev[i].z ?? 0)) * a,
    }));
  }

  /* ─── Metrics (ported maths) ───────────────────────────────────────────── */

  _metrics(lm) {
    // Wrist → middle MCP is a stable scale reference that survives the hand
    // moving toward/away from the camera.
    const palmSize = dist3(lm[0], lm[MCPS.middle]) || 0.15;

    // Pinch apertures: 0 = fully pinched, 1 = wide open.
    const aperture = tip => clamp01(dist3(lm[TIPS.thumb], lm[tip]) / PINCH_MAX);
    const pinch = {
      index:  aperture(TIPS.index),
      middle: aperture(TIPS.middle),
      ring:   aperture(TIPS.ring),
      pinky:  aperture(TIPS.pinky),
    };

    // Per-finger curl: when a finger is straight the tip sits ~2× further from
    // the MCP than the PIP does. Ratio → 1 means open, so we invert it.
    const fingerCurl = (tip, pip, mcp) => {
      const tipToMcp = dist3(lm[tip], lm[mcp]);
      const pipToMcp = dist3(lm[pip], lm[mcp]);
      return clamp01(1 - tipToMcp / (pipToMcp * 2.0 + 0.001));
    };
    const curl = {
      index:  fingerCurl(TIPS.index,  PIPS.index,  MCPS.index),
      middle: fingerCurl(TIPS.middle, PIPS.middle, MCPS.middle),
      ring:   fingerCurl(TIPS.ring,   PIPS.ring,   MCPS.ring),
      pinky:  fingerCurl(TIPS.pinky,  PIPS.pinky,  MCPS.pinky),
    };

    // Spread: index tip → pinky tip, scaled by palm size then by 0.8 (the
    // empirical gain from v5 that makes a natural full spread reach ~1.0).
    const spread = clamp01((dist2(lm[TIPS.index], lm[TIPS.pinky]) / palmSize) * 0.8);

    // Palm roll: angle of the knuckle line (index MCP → pinky MCP), -180..180.
    const rollDeg = Math.atan2(
      lm[MCPS.index].y - lm[MCPS.pinky].y,
      lm[MCPS.index].x - lm[MCPS.pinky].x
    ) * (180 / Math.PI);

    const palm = {
      x: (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5,
      y: (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5,
    };

    // Pinch midpoint — the overlay draws its aperture circle here.
    const pinchPoint = {
      x: (lm[TIPS.thumb].x + lm[TIPS.index].x) / 2,
      y: (lm[TIPS.thumb].y + lm[TIPS.index].y) / 2,
    };

    return { palmSize, pinch, curl, spread, rollDeg, palm, pinchPoint, wrist: lm[0] };
  }

  /* ─── Source writing ───────────────────────────────────────────────────── */

  /** Exponentially smooth a continuous source toward `v`, clamped 0..1. */
  _set(id, v) {
    const prev = this.values[id] ?? 0;
    this.values[id] = prev + (clamp01(v) - prev) * SMOOTHING;
  }

  /**
   * Fire a discrete event: hold at 1.0 for EVENT_PULSE_MS, then return to 0.
   *
   * The expiry is scheduled on a TIMER rather than left to the frame loop.
   * requestAnimationFrame is throttled (or stopped entirely) in a background
   * tab, so a frame-driven decay would leave a pulse latched at 1.0 for as
   * long as the tab stays hidden — a consumer reconnecting later would read a
   * stale event as live. setTimeout still fires when hidden, so the pulse
   * always has the duration the protocol promises.
   */
  fire(id, now = performance.now()) {
    this.values[id] = 1;
    this._eventUntil[id] = now + EVENT_PULSE_MS;
    clearTimeout(this._eventTimers[id]);
    this._eventTimers[id] = setTimeout(() => {
      this.values[id] = 0;
      delete this._eventUntil[id];
      delete this._eventTimers[id];
    }, EVENT_PULSE_MS);
  }

  /**
   * Belt-and-braces expiry from the app loop, in case a timer was starved.
   * Cheap: the loop is almost always empty.
   */
  decayEvents(now = performance.now()) {
    for (const id in this._eventUntil) {
      if (now >= this._eventUntil[id]) {
        this.values[id] = 0;
        delete this._eventUntil[id];
      }
    }
  }

  _writeHandSources(label, st, now) {
    const p = label === 'Right' ? 'gesture.r' : 'gesture.l';
    const m = st.metrics;

    this._set(`${p}.pinch`,        m.pinch.index);
    this._set(`${p}.pinch.middle`, m.pinch.middle);
    this._set(`${p}.pinch.ring`,   m.pinch.ring);
    this._set(`${p}.pinch.pinky`,  m.pinch.pinky);

    this._set(`${p}.curl.index`,  m.curl.index);
    this._set(`${p}.curl.middle`, m.curl.middle);
    this._set(`${p}.curl.ring`,   m.curl.ring);
    this._set(`${p}.curl.pinky`,  m.curl.pinky);

    this._set(`${p}.spread`, m.spread);

    // X is mirrored so that moving your hand right raises the value — the
    // preview is mirrored too, so this matches what the performer sees.
    this._set(`${p}.x`,       1 - m.palm.x);
    this._set(`${p}.y`,       m.palm.y);
    this._set(`${p}.wrist.x`, 1 - m.wrist.x);
    this._set(`${p}.wrist.y`, m.wrist.y);

    // Roll -180..180 → 0..1
    this._set(`${p}.roll`, (m.rollDeg + 180) / 360);

    // MediaPipe z is roughly -0.15..0.15 relative to the wrist.
    this._set(`${p}.z`, ((m.wrist.z ?? 0) + 0.15) / 0.3);

    this._detectPinchEvents(p, st, m, now);
    this._detectSwipe(p, st, now);
  }

  /** Schmitt-trigger pinch detection — hysteresis stops chatter at threshold. */
  _detectPinchEvents(p, st, m, now) {
    const a = m.pinch.index;
    if (!st.pinching && a < PINCH_CLOSE) {
      st.pinching = true;
      this.fire(`${p}.pinchStart`, now);
    } else if (st.pinching && a > PINCH_OPEN) {
      st.pinching = false;
      this.fire(`${p}.pinchEnd`, now);
    }
  }

  /** Velocity-based swipe over the wrist history window. */
  _detectSwipe(p, st, now) {
    if (st.history.length < SWIPE_HISTORY) return;
    if (now - st.lastSwipeAt < SWIPE_COOLDOWN_MS) return;

    const recent = st.history.slice(-SWIPE_HISTORY);
    const first = recent[0], last = recent[recent.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return;

    const dx = last.x - first.x;
    const dy = last.y - first.y;
    if (Math.hypot(dx, dy) / dt < SWIPE_THRESHOLD) return;

    st.lastSwipeAt = now;
    if (Math.abs(dx) > Math.abs(dy)) {
      // dx is in camera space; mirrored preview means dx>0 reads as "left".
      this.fire(dx > 0 ? `${p}.swipeL` : `${p}.swipeR`, now);
    } else {
      this.fire(dy > 0 ? `${p}.swipeD` : `${p}.swipeU`, now);
    }
    st.history.length = 0;   // consume the window so one flick = one event
  }

  _writeTwoHandSources() {
    const R = this.hands.Right, L = this.hands.Left;
    if (!R.present || !L.present || !R.metrics || !L.metrics) {
      this._set('gesture.two.spread', 0);
      return;
    }
    const rp = R.metrics.palm, lp = L.metrics.palm;

    // Hands apart: 0.8 normalised units ≈ arms wide across the frame.
    this._set('gesture.two.spread', clamp01(dist2(rp, lp) / 0.8));
    this._set('gesture.two.x', 1 - (rp.x + lp.x) / 2);
    this._set('gesture.two.y', (rp.y + lp.y) / 2);

    const ang = Math.atan2(rp.y - lp.y, rp.x - lp.x) * (180 / Math.PI);
    this._set('gesture.two.angle', (ang + 180) / 360);
  }

  /** Snapshot of every source value (what the bridge broadcasts). */
  snapshot() { return { ...this.values }; }
}
