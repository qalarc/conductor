/* ═══════════════════════════════════════════════════════════════════════════
   CONDUCTOR — bridge.js
   ---------------------------------------------------------------------------
   THE PROTOCOL. This module is the contract between CONDUCTOR (producer) and
   consumers such as MUSEALL. Any app implementing the message shapes below can
   receive live control sources.

   ── TRANSPORTS ────────────────────────────────────────────────────────────
   1. BroadcastChannel('muse-bridge-v1')
      Same-origin tabs/windows. Zero setup — both pages just open the channel.
      This is the primary path (serve CONDUCTOR and MUSEALL from one origin).

   2. postMessage (cross-origin)
      Used when the origins differ. Two ways to establish the link:
        a) CONDUCTOR was opened by the consumer  → `window.opener` is targeted.
        b) CONDUCTOR is loaded with `?target=<origin>` → any window that
           postMessages us first is registered as a peer and replied to.
      Payloads are byte-identical to the BroadcastChannel ones, so a consumer
      can share one handler for both.

   ── MESSAGES (producer → consumer) ────────────────────────────────────────
     { type:'hello',   app:'conductor', t }
         On start and every 2000ms as a heartbeat. Consumers use the gap
         between hellos to mark a producer as dead.

     { type:'catalog', app:'conductor', sources:[{id,label,group,kind}] }
         On start, and in response to {type:'ping'}. Describes every source
         that may appear in a `sources` message.

     { type:'sources', app:'conductor', t, values:{ <id>: number } }
         ~30Hz while the camera (or mic) is running. Every value is 0..1.
         Only sent when there is something to send — a stopped CONDUCTOR is
         silent apart from its heartbeat.

     { type:'pong', app:'conductor', t }
         Reply to a {type:'ping'} discovery probe.

   ── MESSAGES (consumer → producer) ────────────────────────────────────────
     { type:'ping' }     Discovery. CONDUCTOR replies with `pong` + `catalog`.
     { type:'hello', app:'<name>' }  Announces a consumer; it appears in the
                                     BRIDGE panel's peer list.

   ── SOURCE ID NAMESPACE ───────────────────────────────────────────────────
     gesture.r.*    right hand   (pinch, curl.index, x, y, roll, z, …)
     gesture.l.*    left hand
     gesture.two.*  two-hand     (spread, x, y, angle)
     voice.*        microphone   (level, pitch, centroid, onset)
   Discrete events (swipes, pinchStart/End, voice.onset) are sent as PULSES:
   the value spikes to 1 and returns to 0 after ~150ms, so a consumer polling
   at 30Hz is guaranteed to observe at least one non-zero frame.
   ═════════════════════════════════════════════════════════════════════════ */

export const CHANNEL_NAME  = 'muse-bridge-v1';
export const APP_NAME      = 'conductor';
const HEARTBEAT_MS         = 2000;
const SEND_HZ              = 30;
const PEER_TIMEOUT_MS      = 6000;   // a peer silent this long is dropped

export class Bridge {
  constructor({ onPeersChange = () => {} } = {}) {
    this.channel     = null;
    this.peers       = new Map();  // app name -> last-seen timestamp
    this.onPeersChange = onPeersChange;

    this.sendHz      = 0;          // measured outgoing rate, for the UI
    this._sent       = 0;
    this._hzAt       = performance.now();
    this._lastSend   = 0;
    this._catalog    = [];
    this._targets    = new Set();  // cross-origin windows we postMessage to
    this._targetOrigin = '*';

    this._connect();
  }

  _connect() {
    // BroadcastChannel is absent in some sandboxes; degrade rather than throw.
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = e => this._onMessage(e.data);
      } catch (e) {
        console.warn('[bridge] BroadcastChannel unavailable:', e.message);
      }
    }

    // ── Cross-origin wiring ──
    const params = new URLSearchParams(location.search);
    const target = params.get('target');
    if (target) this._targetOrigin = target;
    if (window.opener) this._targets.add(window.opener);

    window.addEventListener('message', e => {
      const d = e.data;
      if (!d || typeof d !== 'object' || !d.type) return;
      // Any window that talks to us becomes a peer we talk back to.
      if (e.source && e.source !== window) this._targets.add(e.source);
      this._onMessage(d);
    });

    this._prunePeers();
  }

  /** Announce ourselves + publish the catalog. Call once on boot. */
  start(catalog) {
    this._catalog = catalog.map(({ id, label, group, kind }) => ({ id, label, group, kind }));
    this._hello();
    this._sendCatalog();
    this._heartbeat = setInterval(() => this._hello(), HEARTBEAT_MS);
  }

  stop() {
    clearInterval(this._heartbeat);
    clearInterval(this._pruneTimer);
    this.channel?.close();
    this.channel = null;
  }

  _hello()       { this._post({ type: 'hello',   app: APP_NAME, t: Date.now() }); }
  _sendCatalog() { this._post({ type: 'catalog', app: APP_NAME, sources: this._catalog }); }

  /**
   * Broadcast a values snapshot. Throttled to SEND_HZ — call it every frame
   * and it will quietly drop the surplus.
   */
  sendSources(values) {
    const now = performance.now();
    if (now - this._lastSend < 1000 / SEND_HZ) return false;
    this._lastSend = now;

    this._post({ type: 'sources', app: APP_NAME, t: Date.now(), values });

    this._sent++;
    if (now - this._hzAt >= 1000) {
      this.sendHz = Math.round((this._sent * 1000) / (now - this._hzAt));
      this._sent = 0;
      this._hzAt = now;
    }
    return true;
  }

  /** Called when the producer goes idle so the UI's Hz readout falls to 0. */
  markIdle() {
    const now = performance.now();
    if (now - this._hzAt >= 1000) { this.sendHz = 0; this._sent = 0; this._hzAt = now; }
  }

  /** Send on every transport we have. */
  _post(msg) {
    try { this.channel?.postMessage(msg); } catch { /* channel closed mid-send */ }
    for (const w of this._targets) {
      try { w.postMessage(msg, this._targetOrigin); }
      catch { this._targets.delete(w); }   // window closed
    }
  }

  _onMessage(d) {
    if (d.app === APP_NAME && d.type !== 'ping') return;   // ignore our own echo

    switch (d.type) {
      case 'ping':
        this._post({ type: 'pong', app: APP_NAME, t: Date.now() });
        this._sendCatalog();
        break;
      case 'hello':
      case 'pong':
        if (d.app && d.app !== APP_NAME) this._touchPeer(d.app);
        break;
      case 'catalog':
        // Another producer exists — track it as a peer but don't consume it.
        if (d.app && d.app !== APP_NAME) this._touchPeer(d.app);
        break;
    }
  }

  _touchPeer(app) {
    const isNew = !this.peers.has(app);
    this.peers.set(app, Date.now());
    if (isNew) {
      this._sendCatalog();          // a fresh peer needs the catalog immediately
      this.onPeersChange([...this.peers.keys()]);
    }
  }

  _prunePeers() {
    this._pruneTimer = setInterval(() => {
      const cutoff = Date.now() - PEER_TIMEOUT_MS;
      let changed = false;
      for (const [app, t] of this.peers) {
        if (t < cutoff) { this.peers.delete(app); changed = true; }
      }
      if (changed) this.onPeersChange([...this.peers.keys()]);
    }, 2000);
  }

  get peerList() { return [...this.peers.keys()]; }
  get connected() { return !!this.channel || this._targets.size > 0; }
}
