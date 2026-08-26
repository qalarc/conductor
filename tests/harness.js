// CONDUCTOR verification harness — CDP, headless chromium, NO CAMERA present.
const WebSocket = require('ws');
const http = require('http');

const BASE     = 'http://127.0.0.1:2610/index.html';
const LISTENER = 'http://127.0.0.1:2610/test.html';
const results = [];
let consoleMsgs = [], netReqs = [];
let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
function onMsg(m) {
  const d = JSON.parse(m);
  if (d.id && pending.has(d.id)) {
    const p = pending.get(d.id); pending.delete(d.id);
    d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
    return;
  }
  if (d.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push({ type: d.params.type, text: (d.params.args || []).map(a => a.value ?? a.description ?? '').join(' ') });
  } else if (d.method === 'Log.entryAdded') {
    const e = d.params.entry;
    consoleMsgs.push({ type: e.level, text: `[${e.source}] ${e.text}` });
  } else if (d.method === 'Runtime.exceptionThrown') {
    const x = d.params.exceptionDetails;
    consoleMsgs.push({ type: 'error', text: 'EXCEPTION: ' + (x.exception?.description || x.text) });
  } else if (d.method === 'Network.responseReceived') {
    netReqs.push({ url: d.params.response.url, status: d.params.response.status });
  } else if (d.method === 'Network.loadingFailed') {
    netReqs.push({ url: d.params.requestId, status: 'FAILED: ' + d.params.errorText });
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evl(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
function pass(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function getJSON(path) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9334, path }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej));
}

(async () => {
  const { execFile } = require('child_process');
  execFile('/usr/lib/chromium/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1600,1000', '--remote-debugging-port=9334',
    "--remote-allow-origins=*", '--user-data-dir=/tmp/conductor_test/profile', 'about:blank'
  ], () => {});
  await sleep(2500);

  const tabs = await getJSON('/json');
  const page = tabs.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { headers: { Origin: 'http://127.0.0.1' } });
  await new Promise(r => ws.on('open', r));
  ws.on('message', onMsg);
  await send('Runtime.enable'); await send('Log.enable');
  await send('Network.enable'); await send('Page.enable');

  // ── T1: boots clean with NO camera ──
  await send('Page.navigate', { url: BASE });
  await sleep(3500);

  const title = await evl('document.title');
  pass('T1 title = CONDUCTOR', title === 'CONDUCTOR', `got "${title}"`);

  const errs = consoleMsgs.filter(m => ['error'].includes(m.type));
  pass('T1 no console errors', errs.length === 0,
    errs.map(e => `[${e.type}] ${e.text}`).join(' | ') || 'clean');

  const warns = consoleMsgs.filter(m => m.type === 'warning');
  pass('T1 no console warnings', warns.length === 0,
    warns.map(e => e.text).join(' | ') || 'clean');

  const f404 = netReqs.filter(r => r.status === 404 || String(r.status).startsWith('FAILED'));
  pass('T1 no 404/failed local requests', f404.length === 0,
    f404.map(f => `${f.status} ${f.url}`).join('\n') || 'clean');

  // ── T2: graceful no-camera degradation ──
  const stageState = await evl(`(() => {
    const m = document.getElementById('stage-msg');
    return { hidden: m.classList.contains('hidden'),
             ttl: m.querySelector('.ttl').textContent,
             sub: m.querySelector('.sub').textContent.slice(0,80) };
  })()`);
  pass('T2 stage shows a state (not blank)', !stageState.hidden && !!stageState.ttl,
    `"${stageState.ttl}"`);

  const camBtn = await evl(`document.getElementById('btn-cam').textContent`);
  pass('T2 camera button present', /START CAMERA/.test(camBtn), `"${camBtn}"`);

  // Click START with no camera — must show an error state, not throw.
  consoleMsgs = [];
  await evl(`document.getElementById('btn-cam').click()`);
  await sleep(2500);
  const afterClick = await evl(`(() => {
    const m = document.getElementById('stage-msg');
    return { ttl: m.querySelector('.ttl').textContent, err: m.classList.contains('err') };
  })()`);
  pass('T2 no-camera click → error state, no crash',
    afterClick.err && /NO CAMERA|CAMERA/.test(afterClick.ttl), `"${afterClick.ttl}"`);
  const clickErrs = consoleMsgs.filter(m => m.type === 'error' && !/getUserMedia|NotFound|Requested device/i.test(m.text));
  pass('T2 no unexpected exceptions on click', clickErrs.length === 0,
    clickErrs.map(e => e.text).join(' | ') || 'clean');

  // ── T3: catalog ──
  const cat = await evl(`window.CONDUCTOR.catalog.map(s => s.id)`);
  pass('T3 catalog exposed', Array.isArray(cat) && cat.length > 0, `${cat.length} sources`);
  pass('T3 catalog is 50 sources', cat.length === 50, `got ${cat.length}`);

  const groups = await evl(`[...new Set(window.CONDUCTOR.catalog.map(s=>s.group))]`);
  pass('T3 groups R/L/TWO/EVENTS/VOICE',
    ['R HAND','L HAND','TWO-HAND','EVENTS','VOICE'].every(g => groups.includes(g)),
    groups.join(', '));

  const badIds = cat.filter(id => !/^(gesture|voice)\./.test(id));
  pass('T3 all ids namespaced gesture.*/voice.*', badIds.length === 0, badIds.join(', ') || 'clean');

  const wellFormed = await evl(`window.CONDUCTOR.catalog.every(s =>
    typeof s.id==='string' && typeof s.label==='string' && typeof s.group==='string' &&
    (s.kind==='continuous'||s.kind==='event'))`);
  pass('T3 every entry has id/label/group/kind', wellFormed === true);

  const expected = ['gesture.r.pinch','gesture.r.curl.index','gesture.r.x','gesture.r.y',
    'gesture.r.roll','gesture.l.pinch','gesture.two.spread','gesture.two.x','gesture.two.y',
    'gesture.r.swipeL','gesture.r.pinchStart','voice.level','voice.pitch','voice.centroid','voice.onset'];
  const missing = expected.filter(id => !cat.includes(id));
  pass('T3 all spec-required ids present', missing.length === 0, missing.join(', ') || 'all present');

  // ── T4: values initialised ──
  const vals = await evl(`(() => {
    const v = {...window.CONDUCTOR.gesture.snapshot(), ...window.CONDUCTOR.voice.snapshot()};
    return { n: Object.keys(v).length,
             allNum: Object.values(v).every(x => typeof x==='number' && x>=0 && x<=1 && !isNaN(x)) };
  })()`);
  pass('T4 all values are numbers in 0..1', vals.allNum === true, `${vals.n} values`);

  // ── T5: UI rendered ──
  const ui = await evl(`({
    bars:    document.querySelectorAll('#sources .src').length,
    groups:  document.querySelectorAll('#sources .grp-h').length,
    sliders: document.querySelectorAll('.fx-row input[type=range]').length,
    mic:     !!document.getElementById('btn-mic'),
    mon:     document.getElementById('btn-monitor').disabled,
    warn:    !!document.querySelector('.warn-box'),
    count:   document.getElementById('src-count').textContent
  })`);
  pass('T5 SOURCES panel renders a bar per source', ui.bars === 50, `${ui.bars} bars, ${ui.groups} groups`);
  pass('T5 source count readout correct', ui.count === '50', `"${ui.count}"`);
  pass('T5 VOICE panel renders (5 FX sliders + mic btn)', ui.sliders === 5 && ui.mic,
    `${ui.sliders} sliders`);
  pass('T5 monitor disabled until mic starts', ui.mon === true);
  pass('T5 headphone warning shown', ui.warn === true);

  // ── T6: bridge broadcasting — verified from a SECOND page ──
  const t2 = await send('Target.createTarget', { url: 'about:blank' });
  const att = await send('Target.attachToTarget', { targetId: t2.targetId, flatten: true });
  const sid = att.sessionId;
  await send('Runtime.enable', {}, sid);
  await send('Page.enable', {}, sid);
  await send('Page.navigate', { url: LISTENER }, sid);
  await sleep(4500);

  const lr = await send('Runtime.evaluate', {
    expression: `(() => {
      const rows = [...document.querySelectorAll('#log .row .ty')].map(e=>e.textContent);
      return { types: [...new Set(rows)], n: +document.getElementById('n').textContent,
               prod: document.getElementById('prod').textContent,
               catalog: window.LISTENER.catalog.length,
               cells: document.querySelectorAll('#live .lv').length };
    })()`, returnByValue: true }, sid);
  const L = lr.result.value;

  pass('T6 listener received hello', L.types.includes('hello'), `types: ${L.types.join(', ')}`);
  pass('T6 listener received catalog', L.types.includes('catalog'), `${L.catalog} sources`);
  pass('T6 catalog over bridge = 50', L.catalog === 50, `got ${L.catalog}`);
  pass('T6 producer identified as "conductor"', L.prod === 'conductor', `"${L.prod}"`);
  pass('T6 live grid built from catalog', L.cells === 50, `${L.cells} cells`);

  // ping → pong
  const pr = await send('Runtime.evaluate', {
    expression: `(async () => {
      const before = document.querySelectorAll('#log .row').length;
      document.getElementById('ping').click();
      await new Promise(r=>setTimeout(r,1200));
      const types = [...document.querySelectorAll('#log .row .ty')].map(e=>e.textContent);
      return { grew: document.querySelectorAll('#log .row').length > before,
               pong: types.includes('pong') };
    })()`, returnByValue: true, awaitPromise: true }, sid);
  pass('T6 ping → pong + catalog reply', pr.result.value.pong === true);

  // ── T7: peer discovery back on the CONDUCTOR page ──
  await sleep(2000);
  const peers = await evl(`window.CONDUCTOR.bridge.peerList`);
  pass('T7 conductor sees the listener as a peer', peers.includes('listener'),
    `peers: [${peers.join(', ')}]`);
  const peerUI = await evl(`document.getElementById('peer-count').textContent`);
  pass('T7 peer count shown in BRIDGE panel', +peerUI >= 1, `"${peerUI}"`);

  // ── T8: no 'sources' spam while idle (camera+mic off) ──
  const idle = await send('Runtime.evaluate', {
    expression: `(async () => {
      const before = [...document.querySelectorAll('#log .row .ty')].filter(e=>e.textContent==='sources').length;
      await new Promise(r=>setTimeout(r,2000));
      const after = [...document.querySelectorAll('#log .row .ty')].filter(e=>e.textContent==='sources').length;
      return { before, after, hz: +document.getElementById('hz').textContent };
    })()`, returnByValue: true, awaitPromise: true }, sid);
  const I = idle.result.value;
  pass('T8 idle producer sends no `sources`', I.before === I.after && I.hz === 0,
    `sources logs ${I.before}→${I.after}, ${I.hz} Hz`);

  // ── T9: event pulse mechanics (synthetic — no camera needed) ──
  const pulse = await evl(`(async () => {
    const g = window.CONDUCTOR.gesture;
    g.fire('gesture.r.swipeL');
    const immediate = g.values['gesture.r.swipeL'];
    await new Promise(r=>setTimeout(r,260));
    return { immediate, after: g.values['gesture.r.swipeL'] };
  })()`, true);
  pass('T9 event pulses to 1 then decays to 0',
    pulse.immediate === 1 && pulse.after === 0,
    `spike=${pulse.immediate} after260ms=${pulse.after}`);

  // ── T10: MediaPipe module URLs pinned ──
  const src = await new Promise((res, rej) => http.get(
    { host: '127.0.0.1', port: 2610, path: '/gesture-engine.js' },
    r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>res(b)); }).on('error', rej));
  pass('T10 tasks-vision version pinned (not @latest)',
    /tasks-vision@\d+\.\d+\.\d+/.test(src) && !/tasks-vision@latest/.test(src),
    (src.match(/tasks-vision@[\w.]+/) || [])[0]);
  pass('T10 hand_landmarker model URL present',
    /storage\.googleapis\.com\/mediapipe-models\/hand_landmarker/.test(src));
  pass('T10 GPU delegate with CPU fallback', /\['GPU', 'CPU'\]/.test(src));

  // ── Summary ──
  const failed = results.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`\n  FAILURES:`);
    for (const f of failed) console.log(`   ✗ ${f.name} — ${f.detail}`);
  }
  console.log(`${'─'.repeat(62)}\n`);

  await send('Browser.close').catch(() => {});
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
