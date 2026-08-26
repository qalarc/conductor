/* ═══════════════════════════════════════════════════════════════════════════
   CONDUCTOR — voice.js
   ---------------------------------------------------------------------------
   Microphone capture, analysis, and a local FX chain. DELIBERATELY SEPARATE
   from the gesture engine and from MUSEALL: voice processing is opt-in, has
   its own permission prompt, and its own monitoring risk (feedback), so it
   lives behind its own module and its own panel.

   ── ANALYSIS → BRIDGE SOURCES ─────────────────────────────────────────────
     voice.level     RMS loudness, soft-kneed to 0..1
     voice.pitch     fundamental f0 via autocorrelation, 80–800Hz → 0..1 (log)
     voice.centroid  spectral centroid — "brightness" — 0..1
     voice.onset     attack pulse (spectral-flux transient), 1 for 150ms

   ── LOCAL FX CHAIN ────────────────────────────────────────────────────────
     mic → [analyser tap]
         → highpass → distortion(waveshaper) → filter(lowpass, resonant)
         → ┬→ dry ─────────────────────────────────┐
            ├→ delay (feedback loop) → delayWet ───┤→ master → destination
            └→ convolver (generated IR) → revWet ──┘

   Everything here is achievable with stock WebAudio nodes — NO AudioWorklet,
   so there is no separate worklet file to serve and no cross-origin isolation
   requirement. True pitch-shifting needs a worklet (or an OLA implementation)
   and is intentionally out of scope; the filter + distortion give plenty of
   timbral movement for a gesture instrument.

   ⚠ MONITORING IS OFF BY DEFAULT. Enabling it routes the mic to the speakers,
   which will feed back without headphones. The UI warns before enabling.
   ═════════════════════════════════════════════════════════════════════════ */

const FFT_SIZE      = 2048;
const MIN_F0        = 80;    // Hz — low male voice
const MAX_F0        = 800;   // Hz — high female voice / whistle register
const ONSET_PULSE_MS = 150;
const SMOOTHING      = 0.3;  // matches the gesture engine
const RMS_FLOOR      = 0.002;

export const VOICE_SOURCES = [
  { id: 'voice.level',    label: 'Level (RMS)',    group: 'VOICE', kind: 'continuous' },
  { id: 'voice.pitch',    label: 'Pitch (f0)',     group: 'VOICE', kind: 'continuous' },
  { id: 'voice.centroid', label: 'Brightness',     group: 'VOICE', kind: 'continuous' },
  { id: 'voice.onset',    label: 'Onset',          group: 'VOICE', kind: 'event' },
];

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

export class VoiceEngine {
  constructor() {
    this.ctx     = null;
    this.stream  = null;
    this.running = false;
    this.error   = null;
    this.monitoring = false;

    this.values = { 'voice.level': 0, 'voice.pitch': 0, 'voice.centroid': 0, 'voice.onset': 0 };

    // FX parameters (0..1, driven by the UI or later by gestures)
    this.fx = { filter: 1, distortion: 0, delay: 0, reverb: 0, wet: 0.5 };

    this._onsetUntil = 0;
    this._prevSpectrum = null;
    this._timeBuf = null;
    this._freqBuf = null;
  }

  /** Request the mic and build the graph. Returns {ok} or {ok:false, reason}. */
  async start() {
    if (this.running) return { ok: true };

    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'no-mic-api' };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Off: these would fight the FX chain and squash the dynamics we analyse.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        },
      });
    } catch (e) {
      return { ok: false, reason: e.name === 'NotFoundError' ? 'no-mic' : 'denied', detail: e.message };
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this._buildGraph();
    this.running = true;
    return { ok: true };
  }

  stop() {
    this.running = false;
    this.monitoring = false;
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    for (const k in this.values) this.values[k] = 0;
  }

  _buildGraph() {
    const ctx = this.ctx;
    const src = ctx.createMediaStreamSource(this.stream);

    // ── Analysis tap (pre-FX: we analyse the raw voice, not the processed one) ──
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.6;
    src.connect(this.analyser);
    this._timeBuf = new Float32Array(this.analyser.fftSize);
    this._freqBuf = new Float32Array(this.analyser.frequencyBinCount);
    this._prevSpectrum = new Float32Array(this.analyser.frequencyBinCount);

    // ── FX chain ──
    // Highpass kills desk rumble / plosives before the distortion stage.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 80;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this._distortionCurve(0);
    this.shaper.oversample = '4x';

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 8000;
    this.filter.Q.value = 1;

    src.connect(hp); hp.connect(this.shaper); this.shaper.connect(this.filter);

    // Dry path
    this.dryGain = ctx.createGain(); this.dryGain.gain.value = 1;
    this.filter.connect(this.dryGain);

    // Delay with feedback
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.28;
    this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.35;
    this.delayWet = ctx.createGain(); this.delayWet.gain.value = 0;
    this.filter.connect(this.delay);
    this.delay.connect(this.delayFb);
    this.delayFb.connect(this.delay);           // the feedback loop
    this.delay.connect(this.delayWet);

    // Reverb — convolver fed a procedurally generated impulse response, so we
    // ship no audio assets.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._makeImpulse(2.4, 2.6);
    this.reverbWet = ctx.createGain(); this.reverbWet.gain.value = 0;
    this.filter.connect(this.convolver);
    this.convolver.connect(this.reverbWet);

    // Master → speakers, gated by the monitor switch.
    this.master = ctx.createGain();
    this.master.gain.value = 0;                 // muted until monitoring is on
    this.dryGain.connect(this.master);
    this.delayWet.connect(this.master);
    this.reverbWet.connect(this.master);
    this.master.connect(ctx.destination);

    this.applyFx();
  }

  /** Classic tanh-ish waveshaper curve; amount 0..1. */
  _distortionCurve(amount) {
    const n = 1024, curve = new Float32Array(n);
    const k = amount * 100;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /** Exponentially-decaying noise burst = a serviceable room reverb IR. */
  _makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** Push this.fx into the audio graph. Safe to call every frame. */
  applyFx() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = this.fx;

    // Filter: exponential 200Hz→12kHz feels linear to the ear.
    this.filter.frequency.setTargetAtTime(200 * Math.pow(60, clamp01(f.filter)), t, 0.02);
    this.filter.Q.setTargetAtTime(1 + clamp01(f.distortion) * 8, t, 0.02);

    this.shaper.curve = this._distortionCurve(clamp01(f.distortion));

    this.delayWet.gain.setTargetAtTime(clamp01(f.delay) * clamp01(f.wet), t, 0.05);
    this.reverbWet.gain.setTargetAtTime(clamp01(f.reverb) * clamp01(f.wet), t, 0.05);
    this.dryGain.gain.setTargetAtTime(1 - clamp01(f.wet) * 0.4, t, 0.05);
  }

  /** Route to speakers. OFF by default — feedback risk without headphones. */
  setMonitoring(on) {
    if (!this.ctx) return;
    this.monitoring = !!on;
    this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
  }

  /* ─── Analysis ─────────────────────────────────────────────────────────── */

  /** Call once per animation frame while running. */
  tick(now = performance.now()) {
    if (!this.running || !this.analyser) return;

    this.analyser.getFloatTimeDomainData(this._timeBuf);
    this.analyser.getFloatFrequencyData(this._freqBuf);

    this._level(now);
    this._pitch();
    this._centroid();
    this._onset(now);

    if (now >= this._onsetUntil && this.values['voice.onset'] > 0) {
      this.values['voice.onset'] = 0;
    }
  }

  _set(id, v) {
    this.values[id] += (clamp01(v) - this.values[id]) * SMOOTHING;
  }

  _level() {
    const b = this._timeBuf;
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    const rms = Math.sqrt(sum / b.length);
    // Log-ish curve: quiet speech should already move the bar meaningfully.
    this._set('voice.level', rms < RMS_FLOOR ? 0 : clamp01(Math.log10(rms / RMS_FLOOR) / 2.2));
  }

  /**
   * Autocorrelation pitch detection (ACF with a normalised square difference
   * flavour). Robust enough for voice; ignores frames that are too quiet.
   */
  _pitch() {
    const b = this._timeBuf, rate = this.ctx.sampleRate;

    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    const rms = Math.sqrt(sum / b.length);
    if (rms < 0.01) { this._set('voice.pitch', this.values['voice.pitch'] * 0.9); return; }

    const minLag = Math.floor(rate / MAX_F0);
    const maxLag = Math.min(Math.floor(rate / MIN_F0), b.length - 1);

    let bestLag = -1, bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, normA = 0, normB = 0;
      for (let i = 0; i < b.length - lag; i++) {
        corr  += b[i] * b[i + lag];
        normA += b[i] * b[i];
        normB += b[i + lag] * b[i + lag];
      }
      const denom = Math.sqrt(normA * normB) || 1;
      const n = corr / denom;
      if (n > bestCorr) { bestCorr = n; bestLag = lag; }
    }

    // Below ~0.5 correlation it's noise/unvoiced — decay instead of jumping.
    if (bestLag < 0 || bestCorr < 0.5) { this._set('voice.pitch', this.values['voice.pitch'] * 0.9); return; }

    const f0 = rate / bestLag;
    // Log mapping so an octave is an equal distance anywhere in the range.
    this._set('voice.pitch', Math.log2(f0 / MIN_F0) / Math.log2(MAX_F0 / MIN_F0));
  }

  /** Spectral centroid = perceived brightness. */
  _centroid() {
    const f = this._freqBuf, rate = this.ctx.sampleRate;
    const nyquist = rate / 2;
    let weighted = 0, total = 0;
    for (let i = 0; i < f.length; i++) {
      const mag = Math.pow(10, f[i] / 20);     // dB → linear
      weighted += mag * (i / f.length) * nyquist;
      total += mag;
    }
    if (total <= 0) { this._set('voice.centroid', 0); return; }
    // 4kHz is a sensible "very bright" ceiling for voice.
    this._set('voice.centroid', (weighted / total) / 4000);
  }

  /** Spectral flux onset detector — fires on attacks/consonants. */
  _onset(now) {
    const f = this._freqBuf, prev = this._prevSpectrum;
    let flux = 0;
    for (let i = 0; i < f.length; i++) {
      const mag = Math.pow(10, f[i] / 20);
      const d = mag - prev[i];
      if (d > 0) flux += d;                    // rectified: only rising energy
      prev[i] = mag;
    }
    if (flux > 0.9 && now >= this._onsetUntil) {
      this.values['voice.onset'] = 1;
      this._onsetUntil = now + ONSET_PULSE_MS;
    }
  }

  snapshot() { return { ...this.values }; }
}
