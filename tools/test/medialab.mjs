// Media lab test: loads a COPY of extension/ (manifest patched with "offscreen", the wasm CSP and a tiny
// relay service worker) in Playwright's Chromium and exercises every lab op through the real offscreen
// document. Only benign, locally generated images/video are used.
//   node tools/test/medialab.mjs            (needs ffmpeg on PATH for the WebM fixtures; else MediaRecorder)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const SRC = path.resolve(import.meta.dirname, '../../extension');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clicksafe-lab-'));
const HOST = 'media.clicksafe-e2e.com';
const PORT = 8791;
const BASE = `http://${HOST}:${PORT}`;
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let failures = 0;
const check = (cond, what) => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${what}`); if (!cond) failures++; };
const short = (r) => JSON.stringify(r, (k, v) => (typeof v === 'string' && v.startsWith('data:') ? `${v.slice(0, 22)}…(${v.length})` : v));

// ---------- fixtures (all benign, generated here) ----------
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'ascii'); d.copy(b, 8); b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pattern(kind) {
  const b = Buffer.alloc(224 * 224 * 3);
  for (let y = 0; y < 224; y++) for (let x = 0; x < 224; x++) {
    const o = (y * 224 + x) * 3, i = Math.floor(x / 28), j = Math.floor(y / 28);
    if (kind === 1) { b[o] = (i * 37 + 20) % 256; b[o + 1] = (j * 53 + 90) % 256; b[o + 2] = ((i + j) * 29 + 150) % 256; }
    else { b[o] = x; b[o + 1] = y; b[o + 2] = (x + y) >> 1; }
  }
  return b;
}
// Reference probabilities [NSFL, NSFW, SFW] from onnxruntime (fp32 ONNX, same pixels).
const REF = { 1: [0.02808, 0.11349, 0.85843], 2: [0.0336, 0.03301, 0.93339] };

// Minimal GIF89a encoder (uncompressed LZW: 9-bit literal codes with a CLEAR every 250 pixels).
function gif(w, h, frames, delayCs = 20) {
  const pal = Buffer.alloc(768);
  for (let k = 0; k < 216; k++) { pal[k * 3] = Math.floor(k / 36) * 51; pal[k * 3 + 1] = (Math.floor(k / 6) % 6) * 51; pal[k * 3 + 2] = (k % 6) * 51; }
  const out = [Buffer.from('GIF89a'), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0]), pal,
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0])];
  for (const px of frames) {
    out.push(Buffer.from([0x21, 0xf9, 4, 0x04, delayCs & 255, delayCs >> 8, 0, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 8]));
    const bytes = []; let acc = 0, nb = 0;
    const put = (c) => { acc |= c << nb; nb += 9; while (nb >= 8) { bytes.push(acc & 255); acc >>= 8; nb -= 8; } };
    put(256);
    px.forEach((p, i) => { if (i && i % 250 === 0) put(256); put(p); });
    put(257); if (nb) bytes.push(acc & 255);
    for (let i = 0; i < bytes.length; i += 255) { const s = bytes.slice(i, i + 255); out.push(Buffer.from([s.length, ...s])); }
    out.push(Buffer.from([0]));
  }
  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}
const cube = (r, g, b) => Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
function gifFrames(w, h, n) {
  return Array.from({ length: n }, (_, f) => Array.from({ length: w * h }, (_, i) => {
    const x = i % w, y = Math.floor(i / w);
    return f === 0 ? cube(0, 102, 204) : cube((x * 255) / w, ((y + f * 20) % h) * 255 / h, (f * 40) % 255);
  }));
}

function makeVideos() {
  const ff = process.env.FFMPEG || 'ffmpeg';
  try { execFileSync(ff, ['-version'], { stdio: 'ignore' }); } catch { return null; }
  const clip = path.join(TMP, 'clip.webm'), live = path.join(TMP, 'live.webm');
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '4', '-c:v', 'libvpx', '-b:v', '300k', '-pix_fmt', 'yuv420p'];
  execFileSync(ff, [...common, clip]);
  execFileSync(ff, [...common, '-live', '1', '-f', 'webm', live]);
  return { clip: fs.readFileSync(clip), live: fs.readFileSync(live), how: 'ffmpeg' };
}

// ---------- extension copy with patched manifest + relay service worker ----------
const EXT = path.join(TMP, 'ext');
fs.cpSync(SRC, EXT, { recursive: true, filter: (s) => !s.split(path.sep).includes('_metadata') });
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
man.permissions = [...new Set([...(man.permissions || []), 'offscreen'])];
man.content_security_policy = { extension_pages: CSP };
man.background = { service_worker: '__labtest_bg.js', type: 'module' };
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2));
fs.writeFileSync(path.join(EXT, '__labtest_bg.js'), `
let creating = null;
async function ensureLab() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_SCRAPING'], justification: 'ClickSafe media lab test' }).finally(() => { creating = null; });
  await creating;
}
globalThis.lab = async (msg) => { await ensureLab(); return chrome.runtime.sendMessage({ ...msg, to: 'lab' }); };
`);
fs.writeFileSync(path.join(EXT, '__labtest_page.html'), '<!doctype html><meta charset="utf-8"><title>lab test page</title>');
// Control copy WITHOUT host permissions, to show what <all_urls> changes for <video crossorigin>.
const EXT2 = path.join(TMP, 'ext-nohost');
fs.cpSync(EXT, EXT2, { recursive: true });
fs.writeFileSync(path.join(EXT2, 'manifest.json'), JSON.stringify({ ...man, host_permissions: [] }, null, 2));

// ---------- local server (NO CORS headers anywhere) ----------
const sunset = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/sunset.jpg'));
const animGif = gif(160, 120, gifFrames(160, 120, 8));
const tinyPng = png(16, 16, Buffer.alloc(16 * 16 * 3, 200));
let videos = makeVideos();
const reqLog = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  reqLog.push({ path: u.pathname, mode: req.headers['sec-fetch-mode'] || '', range: req.headers.range || '', origin: req.headers.origin || '', dest: req.headers['sec-fetch-dest'] || '' });
  const send = (type, body) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range && u.pathname !== '/live.webm') {
      const a = Number(range[1]), b = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
      res.writeHead(206, { 'content-type': type, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${body.length}`, 'accept-ranges': 'bytes' });
      return res.end(body.subarray(a, b + 1));
    }
    if (u.pathname === '/live.webm') { res.writeHead(200, { 'content-type': type }); return res.end(body); } // chunked, no length
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'accept-ranges': 'bytes' });
    res.end(body);
  };
  switch (u.pathname) {
    case '/sunset.jpg': return send('image/jpeg', sunset);
    case '/anim.gif': return send('image/gif', animGif);
    case '/tiny.png': return send('image/png', tinyPng);
    case '/mislabeled.jpg': return send('image/jpeg', Buffer.from('<!doctype html><title>x</title>' + 'x'.repeat(100)));
    case '/redirect.jpg': res.writeHead(302, { location: '/sunset.jpg' }); return res.end();
    case '/clip.webm': return videos ? send('video/webm', videos.clip) : (res.writeHead(404), res.end());
    case '/live.webm': return videos ? send('video/webm', videos.live) : (res.writeHead(404), res.end());
    case '/stream.webm': { // simulated live stream: chunked, no length, bytes arrive in real time
      if (!videos) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'video/webm' });
      const n = 40, step = Math.ceil(videos.live.length / n); // ~realtime: 4 s of video over 4 s
      let k = 0;
      const tick = () => { if (res.destroyed) return; if (k >= n) return res.end(); res.write(videos.live.subarray(k * step, (k + 1) * step)); k++; setTimeout(tick, 100); };
      return tick();
    }
    default: res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

async function launch(ext, tag) {
  const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile-' + tag), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
  });
  let sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/__labtest_bg.js'));
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/__labtest_bg.js') });
  for (let i = 0; i < 50 && !(await sw.evaluate(() => typeof globalThis.lab === 'function').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
  const lab = async (msg) => { const t = Date.now(); const r = await sw.evaluate((m) => globalThis.lab(m), msg); return { r, ms: Date.now() - t }; };
  return { ctx, sw, lab, id: new URL(sw.url()).host };
}

// Raw <video> load from an extension page (same origin and permissions as the offscreen document).
async function videoProbe(c, crossOrigin) {
  const p = await c.ctx.newPage();
  await p.goto(`chrome-extension://${c.id}/__labtest_page.html`);
  const r = await p.evaluate(async ({ url, co }) => {
    const v = document.createElement('video');
    if (co) v.crossOrigin = 'anonymous';
    v.muted = true; v.src = url;
    const ev = await new Promise((res) => { v.onloadeddata = () => res('loadeddata'); v.onerror = () => res('error ' + (v.error?.code || '')); setTimeout(() => res('timeout'), 6000); });
    if (ev !== 'loadeddata') return ev;
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
    const x = cv.getContext('2d'); x.drawImage(v, 0, 0, 8, 8);
    try { x.getImageData(0, 0, 1, 1); return 'loaded, untainted'; } catch { return 'loaded, TAINTED'; }
  }, { url: `${BASE}/clip.webm?probe=${Math.random()}`, co: crossOrigin });
  await p.close();
  return r;
}
const dataUrl = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;
const { ctx, lab, id: extId } = await launch(EXT, 'main');
console.log(`extension copy: ${EXT}\nid ${extId}`);

try {
  // ---- videos without ffmpeg: record a benign canvas animation with MediaRecorder ----
  if (!videos) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/__labtest_page.html`);
    const b64 = await p.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const x = c.getContext('2d'); const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
      const parts = []; rec.ondataavailable = (e) => parts.push(e.data); rec.start();
      for (let f = 0; f < 45; f++) { x.fillStyle = `hsl(${f * 8},70%,50%)`; x.fillRect(0, 0, 320, 240); x.fillStyle = '#fff'; x.fillRect(f * 6, 100, 40, 40); await new Promise((r) => setTimeout(r, 66)); }
      rec.stop(); await new Promise((r) => (rec.onstop = r));
      const buf = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ''; for (const v of buf) s += String.fromCharCode(v); return btoa(s);
    });
    await p.close();
    const clip = Buffer.from(b64, 'base64');
    videos = { clip, live: clip, how: 'MediaRecorder' };
  }
  console.log(`video fixtures: ${videos.how} (${videos.clip.length} B, live ${videos.live.length} B)`);

  console.log('\n== ping (cold: creates offscreen doc, loads tfjs + model)');
  let { r, ms } = await lab({ op: 'ping' });
  console.log(`  ${short(r)}  [${ms} ms round trip]`);
  check(r.ok && r.model === 'image-safety-classifier-xs' && ['wasm', 'cpu'].includes(r.backend), `ping ok (${r.workers} inference workers)`);
  check(r.backend === 'wasm', 'WASM backend active');
  ({ r, ms } = await lab({ op: 'ping' }));
  console.log(`  warm ping ${ms} ms`);

  console.log('\n== classify: fidelity vs onnxruntime (exact-pixel PNG patterns)');
  ({ r } = await lab({ op: 'classify', items: [1, 2].map((k) => ({ id: 'pat' + k, src: dataUrl('image/png', png(224, 224, pattern(k))) })) }));
  for (const it of r.results) {
    const ref = REF[it.id.slice(3)], got = [it.scores.NSFL, it.scores.NSFW, it.scores.SFW];
    const d = Math.max(...got.map((v, i) => Math.abs(v - ref[i])));
    console.log(`  ${it.id}: got ${got.join('/')}  ref ${ref.join('/')}  max|d| ${d.toFixed(4)}`);
    check(it.ok && d < 0.01, `${it.id} matches the fp32 ONNX reference (|d| < 0.01)`);
  }

  console.log('\n== classify: mixed batch');
  const items = [
    { id: 'http-jpg', src: `${BASE}/sunset.jpg` },
    { id: 'data-jpg', src: dataUrl('image/jpeg', sunset) },
    { id: 'gif-http', src: `${BASE}/anim.gif` },
    { id: 'gif-data', src: dataUrl('image/gif', animGif) },
    { id: 'tiny', src: `${BASE}/tiny.png` },
    { id: 'wide', src: dataUrl('image/png', png(900, 200, Buffer.alloc(900 * 200 * 3, 120))) },
    { id: 'redirect', src: `${BASE}/redirect.jpg` },
    { id: 'notimage', src: `${BASE}/mislabeled.jpg` },
    { id: '404', src: `${BASE}/missing.jpg` },
    { id: 'private', src: 'http://127.0.0.1:8791/sunset.jpg' },
    { id: 'localhost', src: 'http://localhost:8791/sunset.jpg' },
    { id: 'svgdata', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
  ];
  ({ r, ms } = await lab({ op: 'classify', items, frames: 6 }));
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  for (const x of r.results) console.log(`  ${x.id.padEnd(10)} ${short(x)}`);
  console.log(`  [${ms} ms]`);
  check(by['http-jpg'].ok && by['http-jpg'].nsfw < 0.2 && by['http-jpg'].label === 'sfw' && by['http-jpg'].frames === 1, 'sunset via http: safe, low nsfw');
  check(by['data-jpg'].ok && Math.abs(by['data-jpg'].nsfw - by['http-jpg'].nsfw) < 1e-6, 'sunset via data: URL: same score');
  check(by['gif-http'].ok && by['gif-http'].animated && by['gif-http'].frames === 6 && by['gif-http'].frameCount === 8 && /^data:image\/jpeg/.test(by['gif-http'].worstFrame || ''), 'animated GIF: 6 of 8 frames examined, worstFrame jpeg');
  check(by['gif-data'].ok && by['gif-data'].frames === 6, 'animated GIF via data: URL');
  check(by.tiny.ok && by.tiny.label === 'tiny' && by.tiny.nsfw === 0, 'tiny image skipped as tiny');
  check(by.wide.ok && by.wide.frames === 4, 'very wide image: full view + 3 crops');
  check(!by.redirect.ok && /redirect/.test(by.redirect.error), 'redirect refused');
  check(!by.notimage.ok && /not a supported image/.test(by.notimage.error), 'HTML served as image/jpeg refused');
  check(!by['404'].ok && /404/.test(by['404'].error), '404 reported');
  check(!by.private.ok && /not allowed/.test(by.private.error), 'private IP blocked by fetchable()');
  check(!by.localhost.ok && /not allowed/.test(by.localhost.error), 'localhost blocked by fetchable()');
  check(!by.svgdata.ok, 'svg data: URL refused');

  console.log('\n== classify: 32 distinct images (24 JPEG, 4 animated GIF, 4 PNG data:), cold cache');
  const many = [
    ...Array.from({ length: 24 }, (_, i) => ({ id: 'j' + i, src: `${BASE}/sunset.jpg?n=${i}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: 'g' + i, src: `${BASE}/anim.gif?n=${i}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: 'p' + i, src: dataUrl('image/png', png(300 + i, 200, Buffer.alloc((300 + i) * 200 * 3, 40 + i * 30))) })),
  ];
  ({ r, ms } = await lab({ op: 'classify', items: many, frames: 6 }));
  const okN = r.results.filter((x) => x.ok).length, inputs = r.results.reduce((a, x) => a + (x.frames || 0), 0);
  console.log(`  ${okN}/${many.length} ok, ${inputs} model inputs, ${ms} ms total (${(ms / inputs).toFixed(1)} ms/input), max nsfw ${Math.max(...r.results.map((x) => x.nsfw ?? 0)).toFixed(3)}`);
  check(okN === many.length && ms < 8000, '32 images classified in < 8 s');
  ({ r, ms } = await lab({ op: 'classify', items: many, frames: 6 }));
  console.log(`  same request again (result cache): ${ms} ms`);

  console.log('\n== sheet');
  ({ r, ms } = await lab({ op: 'sheet', items: [
    { id: 'a', src: `${BASE}/sunset.jpg` }, { id: 'b', src: `${BASE}/anim.gif` }, { id: 'c', src: dataUrl('image/png', png(224, 224, pattern(2))) },
    { id: 'd', src: `${BASE}/missing.jpg` }, { id: 'e', src: dataUrl('image/png', png(120, 400, Buffer.alloc(120 * 400 * 3, 90))) },
  ], cell: 256, cols: 4, quality: 0.82 }));
  console.log(`  ${short(r)}  [${ms} ms]`);
  check(r.ok && /^data:image\/jpeg;base64,/.test(r.dataUrl) && r.placed.join() === 'a,b,c,e' && r.skipped.length === 1 && r.w === 1024 && r.h === 256, 'sheet: 4 placed in order, 1 skipped, 4x1 grid of 256px');
  fs.writeFileSync(path.join(TMP, 'sheet.jpg'), Buffer.from(r.dataUrl.split(',')[1], 'base64'));
  ({ r } = await lab({ op: 'sheet', items: Array.from({ length: 18 }, (_, i) => ({ id: i, src: `${BASE}/sunset.jpg?s=${i}` })), cell: 128, cols: 4 }));
  check(r.ok && r.placed.length === 16 && r.skipped.filter((s) => s.error === 'sheet full').length === 2 && r.w === 512 && r.h === 512, 'sheet: capped at 16 cells');

  console.log('\n== video (server sends NO CORS headers)');
  reqLog.length = 0;
  ({ r, ms } = await lab({ op: 'video', src: `${BASE}/clip.webm`, points: [0.02, 0.25, 0.5, 0.75, 0.97], timeoutMs: 12000 }));
  console.log(`  ${short(r)}  [${ms} ms]`);
  const vreq = reqLog.filter((q) => q.path === '/clip.webm');
  console.log('  server saw:', vreq.map((q) => `${q.dest || '-'}/${q.mode || '-'}${q.range ? ' ' + q.range : ''}`).join(', '));
  check(r.ok && r.frames.length === 5 && r.frames.every((f) => /^data:image\/jpeg/.test(f.dataUrl) && f.nsfw < 0.5) && /^data:image\/jpeg/.test(r.sheet), 'video: 5 frames, scored, sheet');
  check(Math.abs(r.duration - 4) < 0.3 && r.w === 320 && r.h === 240, 'video: duration/size');
  console.log(`  CORS finding: via=${r.via} tainted=${r.tainted}${r.directError ? ' directError=' + r.directError : ''}`);

  reqLog.length = 0;
  ({ r, ms } = await lab({ op: 'video', src: `${BASE}/live.webm`, timeoutMs: 12000 }));
  console.log(`  no-duration webm, server without Range support: ${short({ ...r, frames: r.frames?.map((f) => ({ t: f.t, nsfw: f.nsfw })) })}  [${ms} ms]`);
  check(r.ok && new Set(r.frames.map((f) => f.t)).size >= 4, 'unseekable video: fetch fallback gives distinct frames');

  ({ r, ms } = await lab({ op: 'video', src: `${BASE}/stream.webm`, timeoutMs: 12000 }));
  console.log(`  simulated live stream (bytes trickle in): ${short({ ...r, frames: r.frames?.map((f) => ({ t: f.t, nsfw: f.nsfw })) })}  [${ms} ms]`);
  check(r.ok && r.duration === null && r.frames.length >= 2, 'live stream (unknown duration): >= 2 frames over ~3 s');

  const main = { ctx, id: extId };
  const cors = { withCO: await videoProbe(main, true), noCO: await videoProbe(main, false) };
  console.log(`  raw <video> on extension origin with <all_urls>: crossOrigin=anonymous -> ${cors.withCO}; no crossOrigin -> ${cors.noCO}`);
  check(cors.withCO === 'loaded, untainted', '<all_urls> lets a crossOrigin video load untainted from a no-CORS server');

  ({ r } = await lab({ op: 'video', src: 'http://192.168.1.1/cam.mp4' }));
  check(!r.ok && /not allowed/.test(r.error), 'video: private address refused');
  ({ r } = await lab({ op: 'video', src: `${BASE}/missing.webm`, timeoutMs: 4000 }));
  check(!r.ok && /404/.test(r.error), 'video: 404 reported');

  console.log('\n== message guard');
  ({ r } = await lab({ op: 'nope' }));
  check(!r.ok && r.error === 'unknown op', 'unknown op rejected');
  const tab = await ctx.newPage();
  await tab.goto(`chrome-extension://${extId}/__labtest_page.html`);
  const fromTab = await tab.evaluate(() => chrome.runtime.sendMessage({ to: 'lab', op: 'ping' }).catch((e) => ({ thrown: String(e) })));
  console.log(`  extension page in a tab -> ${short(fromTab)}`);
  check(fromTab && fromTab.ok === false && fromTab.error === 'forbidden', 'message from a tab (sender.tab set) rejected');
  await tab.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await ctx.close();
}

// ---- control: same video with NO host permissions ----
try {
  console.log('\n== control: extension copy without host_permissions');
  const c = await launch(EXT2, 'nohost');
  console.log(`  raw <video> without host permission: crossOrigin=anonymous -> ${await videoProbe(c, true)}; no crossOrigin -> ${await videoProbe(c, false)}`);
  reqLog.length = 0;
  const { r } = await c.lab({ op: 'video', src: `${BASE}/clip.webm`, timeoutMs: 8000 });
  console.log(`  ${short({ ...r, frames: r.frames?.length })}`);
  console.log('  server saw:', reqLog.filter((q) => q.path === '/clip.webm').map((q) => `${q.dest || '-'}/${q.mode || '-'}`).join(', ') || '(nothing)');
  check(!r.ok, 'without host permission the no-CORS video cannot be read (direct load fails, fetch fallback blocked by CORS)');
  await c.ctx.close();
} catch (e) {
  console.error(e);
  failures++;
}

server.close();
console.log(`\n${failures ? `FAILED (${failures})` : 'ALL PASSED'}   artifacts: ${TMP}`);
process.exit(failures ? 1 : 0);
