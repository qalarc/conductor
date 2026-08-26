/* ═══════════════════════════════════════════════════════════════════════════
   CONDUCTOR — app.js
   ---------------------------------------------------------------------------
   Wiring layer. Owns the render loop and the DOM; the engines own the maths.

   Boot order is deliberate: the BRIDGE starts IMMEDIATELY, before any camera
   or mic permission is requested. A consumer (MUSEALL) can therefore discover
   CONDUCTOR, receive the full catalog, and build its binding UI while the
   performer is still deciding whether to switch the camera on. It also means
   the page is useful — and testable — on a machine with no camera at all.
   ═════════════════════════════════════════════════════════════════════════ */

import { GestureEngine, SOURCE_CATALOG } from './gesture-engine.js';
import { VoiceEngine, VOICE_SOURCES }    from './voice.js';
import { Bridge }                        from './bridge.js';
import { Overlay }                       from './overlay.js';

const $ = id => document.getElementById(id);

// Full catalog = gesture + voice. This is what the bridge advertises.
const FULL_CATALOG = [...SOURCE_CATALOG, ...VOICE_SOURCES];

const gesture = new GestureEngine();
const voice   = new VoiceEngine();
const overlay = new Overlay($('overlay'));
const bridge  = new Bridge({ onPeersChange: renderPeers });

const video = $('video');
const bars  = new Map();       // source id -> {row, bar, val}

let cameraOn = false;
let voiceOn  = false;

/* ─── Source panel construction ─────────────────────────────────────────── */

function buildSourcePanel() {
  const host = $('sources');
  const groups = new Map();
  for (const s of FULL_CATALOG) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }

  const frag = document.createDocumentFragment();
  for (const [group, items] of groups) {
    const h = document.createElement('div');
    h.className = 'grp-h';
    h.innerHTML = `${group}<span class="n">${items.length}</span>`;
    frag.appendChild(h);

    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'src' + (s.kind === 'event' ? ' evt' : '');
      row.innerHTML =
        `<div class="lb" title="${s.id}">${s.label}</div>` +
        `<div class="tr"><div class="bar"></div></div>` +
        `<div class="vl">0.00</div>`;
      frag.appendChild(row);
      bars.set(s.id, {
        row,
        bar: row.querySelector('.bar'),
        val: row.querySelector('.vl'),
        kind: s.kind,
      });
    }
  }
  host.appendChild(frag);
  $('src-count').textContent = FULL_CATALOG.length;
}

/** Repaint the bars. Called every frame — kept allocation-free. */
function renderBars(values) {
  for (const [id, el] of bars) {
    const v = values[id] ?? 0;
    el.bar.style.width = (v * 100).toFixed(1) + '%';
    el.val.textContent = v.toFixed(2);
    const active = v > 0.02;
    if (active !== el._active) {
      el.row.classList.toggle('act', active);
      if (el.kind === 'event') el.row.classList.toggle('hot', active);
      el._active = active;
    }
  }
}

/* ─── Bridge panel ──────────────────────────────────────────────────────── */

function renderPeers(peers) {
  const host = $('peers');
  if (!peers.length) {
    host.innerHTML = '<span class="pill">no peers</span>';
  } else {
    host.innerHTML = peers.map(p => `<span class="pill live">${p}</span>`).join('');
  }
  $('peer-count').textContent = peers.length;
}

/* ─── Stage messaging ───────────────────────────────────────────────────── */

function stageMsg(ico, ttl, sub, isErr = false) {
  const el = $('stage-msg');
  el.className = 'stage-msg' + (isErr ? ' err' : '');
  el.querySelector('.ico').textContent = ico;
  el.querySelector('.ttl').textContent = ttl;
  el.querySelector('.sub').innerHTML = sub;
}
const hideStageMsg = () => $('stage-msg').classList.add('hidden');

/* ─── Camera control ────────────────────────────────────────────────────── */

async function startCamera() {
  const btn = $('btn-cam');
  btn.disabled = true;
  stageMsg('◌', 'STARTING…', 'Requesting camera access and loading the hand model.');

  const res = await gesture.start(video);
  btn.disabled = false;

  if (!res.ok) {
    const msgs = {
      'no-camera-api': ['⚠', 'CAMERA API UNAVAILABLE',
        'This browser exposes no <code>mediaDevices.getUserMedia</code>. A secure context (https or localhost) is required.'],
      'no-camera':     ['⚠', 'NO CAMERA FOUND',
        'No video input device is attached. CONDUCTOR still runs — the bridge is broadcasting and the voice panel works independently.'],
      'denied':        ['⚠', 'CAMERA BLOCKED',
        'Permission was denied. Allow camera access in the browser site settings, then press START again.'],
      'model-failed':  ['⚠', 'MODEL FAILED TO LOAD',
        `The MediaPipe hand model could not be fetched. Check your connection.<br><code>${res.detail || ''}</code>`],
    };
    const [ico, ttl, sub] = msgs[res.reason] || ['⚠', 'CAMERA ERROR', res.detail || 'Unknown error.'];
    stageMsg(ico, ttl, sub, true);
    return;
  }

  cameraOn = true;
  hideStageMsg();
  btn.textContent = 'STOP CAMERA';
  btn.classList.add('rec');
  $('kv-delegate').textContent = gesture.delegate || '—';
  $('kv-delegate').className = 'v ok';
}

function stopCamera() {
  gesture.stop();
  cameraOn = false;
  const btn = $('btn-cam');
  btn.textContent = 'START CAMERA';
  btn.classList.remove('rec');
  overlay.drawIdle();
  stageMsg('◉', 'CAMERA OFF', 'Press <b>START CAMERA</b> to begin hand tracking.');
  $('kv-delegate').textContent = '—';
  $('kv-delegate').className = 'v off';
}

/* ─── Voice control ─────────────────────────────────────────────────────── */

async function startVoice() {
  const btn = $('btn-mic');
  btn.disabled = true;
  const res = await voice.start();
  btn.disabled = false;

  if (!res.ok) {
    const txt = { 'no-mic-api': 'no mic API', 'no-mic': 'no microphone', 'denied': 'permission denied' }[res.reason]
      || 'error';
    $('kv-mic').textContent = txt;
    $('kv-mic').className = 'v warn';
    return;
  }
  voiceOn = true;
  btn.textContent = 'STOP MIC';
  btn.classList.add('rec');
  $('kv-mic').textContent = 'live';
  $('kv-mic').className = 'v ok';
  $('btn-monitor').disabled = false;
}

function stopVoice() {
  voice.stop();
  voiceOn = false;
  const btn = $('btn-mic');
  btn.textContent = 'START MIC';
  btn.classList.remove('rec');
  $('kv-mic').textContent = 'off';
  $('kv-mic').className = 'v off';
  const m = $('btn-monitor');
  m.disabled = true; m.classList.remove('on'); m.textContent = 'MONITOR OFF';
}

function toggleMonitor() {
  const on = !voice.monitoring;
  // Feedback risk is real and immediate — make the user confirm once.
  if (on && !confirm('Enable speaker monitoring?\n\nWithout headphones this WILL cause feedback howl.\n\nContinue?')) return;
  voice.setMonitoring(on);
  const btn = $('btn-monitor');
  btn.classList.toggle('on', on);
  btn.textContent = on ? 'MONITOR ON' : 'MONITOR OFF';
}

/* ─── FX sliders ────────────────────────────────────────────────────────── */

function wireFx() {
  for (const key of ['filter', 'distortion', 'delay', 'reverb', 'wet']) {
    const el = $(`fx-${key}`);
    const out = $(`fx-${key}-v`);
    const sync = () => {
      const v = +el.value / 100;
      voice.fx[key] = v;
      out.textContent = v.toFixed(2);
      voice.applyFx();
    };
    el.addEventListener('input', sync);
    sync();
  }
}

/* ─── Main loop ─────────────────────────────────────────────────────────── */

function loop() {
  const now = performance.now();

  if (cameraOn) {
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) overlay.resize(w, h);
    overlay.draw(video, gesture.hands);
  }
  if (voiceOn) voice.tick(now);

  // Always run — event pulses must expire even with the camera off.
  gesture.decayEvents(now);

  // Merge both engines into one flat values object for UI + bridge.
  const values = { ...gesture.snapshot(), ...voice.snapshot() };
  renderBars(values);

  // Only broadcast when a producer is actually producing; otherwise stay quiet
  // (heartbeat still goes out) so consumers can tell live data from silence.
  if (cameraOn || voiceOn) bridge.sendSources(values);
  else bridge.markIdle();

  $('kv-fps').textContent = cameraOn ? gesture.fps : '—';
  $('kv-hz').textContent  = bridge.sendHz;
  $('kv-hands').textContent =
    ['Right', 'Left'].filter(l => gesture.hands[l].present).join(' + ') || 'none';

  requestAnimationFrame(loop);
}

/* ─── Boot ──────────────────────────────────────────────────────────────── */

function boot() {
  buildSourcePanel();
  wireFx();
  renderPeers([]);

  // Bridge goes live first — see the note at the top of this file.
  bridge.start(FULL_CATALOG);
  $('kv-channel').textContent = 'muse-bridge-v1';
  $('kv-channel').className = 'v ok';

  overlay.drawIdle();
  stageMsg('◉', 'CAMERA OFF', 'Press <b>START CAMERA</b> to begin hand tracking.');

  $('btn-cam').addEventListener('click', () => (cameraOn ? stopCamera() : startCamera()));
  $('btn-mic').addEventListener('click', () => (voiceOn ? stopVoice() : startVoice()));
  $('btn-monitor').addEventListener('click', toggleMonitor);

  // Warn early (not as an error) when the environment has no camera at all,
  // so the "no camera" state is explained before the user clicks START.
  if (!navigator.mediaDevices?.getUserMedia) {
    stageMsg('⚠', 'NO CAMERA API',
      'This context has no <code>getUserMedia</code>. Serve over <code>localhost</code> or https. The bridge and voice panel are unaffected.', true);
    $('btn-cam').disabled = true;
    $('btn-mic').disabled = true;
  }

  requestAnimationFrame(loop);

  // Expose for the CDP test harness and for console debugging.
  window.CONDUCTOR = { gesture, voice, bridge, overlay, catalog: FULL_CATALOG };
}

boot();
