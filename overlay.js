/* ═══════════════════════════════════════════════════════════════════════════
   CONDUCTOR — overlay.js
   ---------------------------------------------------------------------------
   The skeleton overlay. A modernised distillation of the v5.x
   gesture-renderer.js (which had grown to 1000+ lines of optional decorations)
   down to the four things that actually help a performer:

     1. BONES + LANDMARKS  — see that tracking is locked on
     2. PINCH APERTURE     — a circle at the thumb/index midpoint whose radius
                             and colour track the aperture; the single most
                             important readout, because pinch is the primary
                             expressive axis
     3. MOTION TRAILS      — fingertip history, so fast gestures read as motion
     4. PALM ROLL AXIS     — a dashed line through the knuckles

   Everything is drawn MIRRORED to match the preview, so what the performer
   sees moves the way their hand moves.
   ═════════════════════════════════════════════════════════════════════════ */

import { HAND_CONNECTIONS } from './gesture-engine.js';

const COLORS = {
  Right: { main: '#ff9a3c', glow: '#ff9a3c', dim: '#ff9a3c44' },
  Left:  { main: '#b16cff', glow: '#b16cff', dim: '#b16cff44' },
};
const CYAN = '#3cf0ff';

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** Size the backing store to the video, capped for fill-rate sanity. */
  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * @param {HTMLVideoElement|null} video  drawn mirrored as the backdrop
   * @param {object} hands  engine.hands — { Right: state, Left: state }
   */
  draw(video, hands) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // ── Mirrored video backdrop ──
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    if (video && video.readyState >= 2) {
      ctx.globalAlpha = 0.62;               // dim so the skeleton stays legible
      ctx.drawImage(video, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    for (const label of ['Left', 'Right']) {
      const st = hands[label];
      if (st?.present && st.smoothed) this._drawHand(st, label, W, H);
    }
    ctx.restore();

    // Vignette sits un-mirrored on top (symmetric, so it makes no difference,
    // but keeping it outside the transform avoids surprises if it changes).
    this._vignette(W, H);
  }

  _drawHand(st, label, W, H) {
    const { ctx } = this;
    const lm = st.smoothed;
    const c = COLORS[label];
    const px = p => p.x * W;
    const py = p => p.y * H;

    this._trail(st.trail, c, W, H);

    // ── Bones ──
    ctx.strokeStyle = c.main;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = c.glow;
    ctx.shadowBlur = 9;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(px(lm[a]), py(lm[a]));
      ctx.lineTo(px(lm[b]), py(lm[b]));
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // ── Landmarks — fingertips larger than joints ──
    const TIPS = new Set([4, 8, 12, 16, 20]);
    for (let i = 0; i < lm.length; i++) {
      const isTip = TIPS.has(i);
      ctx.beginPath();
      ctx.arc(px(lm[i]), py(lm[i]), isTip ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isTip ? '#ffffff' : c.main;
      if (isTip) { ctx.shadowColor = c.glow; ctx.shadowBlur = 11; }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (st.metrics) {
      this._pinchCircle(st.metrics, c, W, H);
      this._rollAxis(st.metrics, lm, W, H);
      this._label(st.metrics, label, c, W, H);
    }
  }

  /** Fingertip motion trail — older points fade and thin out. */
  _trail(trail, c, W, H) {
    if (!trail || trail.length < 2) return;
    const { ctx } = this;
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const t = i / trail.length;              // 0 = oldest, 1 = newest
      ctx.globalAlpha = t * 0.5;
      ctx.strokeStyle = c.main;
      ctx.lineWidth = t * 4;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x * W, trail[i - 1].y * H);
      ctx.lineTo(trail[i].x * W, trail[i].y * H);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Pinch aperture circle: radius follows the aperture, and it flares cyan +
   * fills as it closes, so a pinch is unmistakable at a glance.
   */
  _pinchCircle(m, c, W, H) {
    const { ctx } = this;
    const x = m.pinchPoint.x * W, y = m.pinchPoint.y * H;
    const a = m.pinch.index;                        // 0 closed .. 1 open
    const r = 8 + a * 42;
    const closing = a < 0.3;

    ctx.strokeStyle = closing ? CYAN : c.main;
    ctx.lineWidth = closing ? 3 : 1.8;
    ctx.shadowColor = closing ? CYAN : c.glow;
    ctx.shadowBlur = closing ? 18 : 7;
    ctx.globalAlpha = 0.55 + (1 - a) * 0.45;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    if (closing) {
      ctx.fillStyle = CYAN + '33';
      ctx.fill();
      // Crosshair marks the exact pinch point when engaged.
      ctx.beginPath();
      ctx.moveTo(x - r * 0.55, y); ctx.lineTo(x + r * 0.55, y);
      ctx.moveTo(x, y - r * 0.55); ctx.lineTo(x, y + r * 0.55);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  /** Dashed axis through the knuckles showing palm roll. */
  _rollAxis(m, lm, W, H) {
    const { ctx } = this;
    const cx = m.palm.x * W, cy = m.palm.y * H;
    const rad = (m.rollDeg * Math.PI) / 180;
    const half = 46;
    const dx = Math.cos(rad) * half, dy = Math.sin(rad) * half;

    ctx.strokeStyle = '#b16cffcc';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(cx - dx, cy - dy);
    ctx.lineTo(cx + dx, cy + dy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#b16cff';
    ctx.fill();
  }

  /**
   * Hand label + pinch readout. Text must be un-mirrored or it reads backwards,
   * so we flip back locally around the anchor point.
   */
  _label(m, label, c, W, H) {
    const { ctx } = this;
    const x = m.palm.x * W, y = m.palm.y * H - 66;

    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);      // undo the mirror
    const tx = W - x;

    const text = `${label === 'Right' ? 'R' : 'L'}  ${m.pinch.index.toFixed(2)}`;
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = 'rgba(10,10,20,0.82)';
    this._rrect(ctx, tx - w / 2, y - 9, w, 18, 5);
    ctx.fill();
    ctx.strokeStyle = c.dim;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = c.main;
    ctx.fillText(text, tx, y);
    ctx.restore();
  }

  _vignette(W, H) {
    const { ctx } = this;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  _rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Idle state: faint grid so the stage doesn't look broken when off. */
  drawIdle() {
    const { ctx, canvas } = this;
    const W = canvas.width || 960, H = canvas.height || 540;
    this.resize(W, H);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#ffffff08';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y < H; y += 40) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    this._vignette(W, H);
  }
}
