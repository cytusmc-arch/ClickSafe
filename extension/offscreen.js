// ClickSafe media lab (offscreen document). Heavy image/video work for the service worker:
// local NSFW/NSFL image classification, contact sheets for vision LLMs, and video frame sampling.
// Only answers {to:'lab'} messages from this extension's own non-tab contexts.
import { loadModel, modelInfo, classifyInput } from './lab/model.js';
import { loadImageBytes, decodeForModel, canvasToDataUrl, pool, thumb, toInput } from './lab/media.js';
import { composeSheet, MAX_CELLS } from './lab/sheet.js';
import { captureVideo, videoSrcAllowed } from './lab/video.js';

const ORIGIN = chrome.runtime.getURL('');
const MAX_ITEMS = 100;
const CONCURRENCY = 8;
const THUMB = 320;

const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const errMsg = (e) => String(e?.message || e || 'error').slice(0, 200);

function trusted(sender) {
  return !!sender && sender.id === chrome.runtime.id && !sender.tab && typeof sender.url === 'string' && sender.url.startsWith(ORIGIN);
}

// ---- small result cache (same image URL asked again within a few minutes) ----
const CACHE_MAX = 400, CACHE_MS = 10 * 60e3;
const cache = new Map();
function cacheKey(src, frames) {
  if (src.length <= 2048) return frames + '|' + src;
  let h = 2166136261; // FNV-1a over long data: URLs
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619);
  return `${frames}|${src.length}|${(h >>> 0).toString(36)}|${src.slice(0, 64)}`;
}
function cacheGet(k) {
  const e = cache.get(k);
  if (!e || e.at + CACHE_MS < Date.now()) { cache.delete(k); return null; }
  cache.delete(k); cache.set(k, e);
  return e.v;
}
function cachePut(k, v) {
  cache.set(k, { at: Date.now(), v });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Score every model input of a decoded image; returns per-frame probabilities and the worst frame.
async function scoreDecoded(d) {
  const per = await Promise.all(d.frames.map(async (f) => {
    const rows = await Promise.all(f.inputs.map(classifyInput));
    const worst = rows.reduce((a, b) => (Math.max(b.NSFW, b.NSFL) > Math.max(a.NSFW, a.NSFL) ? b : a));
    return { scores: worst, nsfw: Math.max(...rows.map((r) => r.NSFW)), gore: Math.max(...rows.map((r) => r.NSFL)), views: rows.length };
  }));
  let wi = 0;
  per.forEach((p, i) => { if (Math.max(p.scores.NSFW, p.scores.NSFL) > Math.max(per[wi].scores.NSFW, per[wi].scores.NSFL)) wi = i; });
  return { per, worstIndex: wi, examined: per.reduce((a, p) => a + p.views, 0) };
}

const labelOf = (s) => (s.NSFW >= s.NSFL && s.NSFW >= s.SFW ? 'nsfw' : s.NSFL >= s.SFW ? 'nsfl' : 'sfw');

async function classifyOne(src, frames) {
  const img = await loadImageBytes(src);
  const d = await decodeForModel(img, { frames, keep: img.animated ? THUMB : 0 });
  if (d.tiny) return { ok: true, nsfw: 0, gore: 0, label: 'tiny', scores: {}, w: d.w, h: d.h, frames: 0 };
  const s = await scoreDecoded(d);
  const worst = s.per[s.worstIndex];
  const res = {
    ok: true,
    nsfw: r4(Math.max(...s.per.map((p) => p.nsfw))),
    gore: r4(Math.max(...s.per.map((p) => p.gore))),
    label: labelOf(worst.scores),
    scores: worst.scores,
    w: d.w, h: d.h,
    frames: s.examined,
  };
  if (d.animated) {
    res.animated = true;
    res.frameCount = d.frameCount;
    res.worstFrame = await canvasToDataUrl(d.frames[s.worstIndex].canvas, 0.78);
  }
  return res;
}

async function opClassify(msg) {
  if (!Array.isArray(msg.items)) throw new Error('items must be an array');
  const frames = Math.round(num(msg.frames, 6, 1, 12));
  const items = msg.items.slice(0, MAX_ITEMS);
  loadModel().catch(() => {}); // start loading while the first images download
  const inflight = new Map();
  const results = await pool(items, CONCURRENCY, async (it) => {
    const id = it?.id;
    try {
      const src = String(it?.src || '');
      const key = cacheKey(src, frames);
      const hit = cacheGet(key);
      if (hit) return { id, ...hit };
      if (!inflight.has(key)) inflight.set(key, classifyOne(src, frames).then((r) => { cachePut(key, r); return r; }));
      return { id, ...(await inflight.get(key)) };
    } catch (e) {
      return { id, ok: false, error: errMsg(e) };
    }
  });
  for (const it of msg.items.slice(MAX_ITEMS)) results.push({ id: it?.id, ok: false, error: 'too many items' });
  return { ok: true, results };
}

async function opSheet(msg) {
  if (!Array.isArray(msg.items)) throw new Error('items must be an array');
  const cell = Math.round(num(msg.cell, 256, 64, 512));
  const cols = Math.round(num(msg.cols, 4, 1, 8));
  const quality = num(msg.quality, 0.82, 0.3, 0.95);
  const items = msg.items.slice(0, MAX_CELLS);
  const skipped = msg.items.slice(MAX_CELLS).map((it) => ({ id: it?.id, error: 'sheet full' }));
  const drawn = await pool(items, CONCURRENCY, async (it) => {
    try {
      const img = await loadImageBytes(String(it?.src || ''));
      const d = await decodeForModel(img, { frames: 6, keep: cell });
      if (d.tiny) throw new Error('tiny');
      let pick = 0;
      if (d.animated && d.frames.length > 1) pick = await scoreDecoded(d).then((s) => s.worstIndex, () => 0);
      return { id: it?.id, canvas: d.frames[pick].canvas };
    } catch (e) {
      return { id: it?.id, error: errMsg(e) };
    }
  });
  const ok = drawn.filter((x) => x.canvas);
  for (const x of drawn) if (!x.canvas) skipped.push({ id: x.id, error: x.error });
  if (!ok.length) return { ok: false, error: 'no drawable images', placed: [], skipped };
  const sheet = composeSheet(ok.map((x) => x.canvas), { cell, cols });
  return { ok: true, dataUrl: await canvasToDataUrl(sheet, quality), placed: ok.map((x) => x.id), skipped, w: sheet.width, h: sheet.height };
}

async function opVideo(msg) {
  const src = String(msg.src || '');
  if (!videoSrcAllowed(src)) throw new Error('src not allowed');
  const points = (Array.isArray(msg.points) ? msg.points : [0.02, 0.25, 0.5, 0.75, 0.97])
    .map(Number).filter((p) => Number.isFinite(p) && p >= 0 && p <= 1).slice(0, 12);
  if (!points.length) throw new Error('no valid points');
  const timeoutMs = Math.round(num(msg.timeoutMs, 12000, 2000, 30000));
  loadModel().catch(() => {});
  const v = await captureVideo(src, { points, timeoutMs });
  if (!v.frames.length) return { ok: false, duration: v.duration, w: v.w, h: v.h, tainted: v.tainted, via: v.via, frames: [], error: v.directError || 'no frames captured' };
  const scored = await Promise.all(v.frames.map(async (f) => {
    const d = { frames: [{ inputs: [toInput(f.canvas)] }] };
    const s = await scoreDecoded(d).catch(() => null);
    return {
      t: f.t,
      dataUrl: await canvasToDataUrl(f.canvas.width > THUMB || f.canvas.height > THUMB ? thumb(f.canvas, THUMB) : f.canvas, 0.8),
      nsfw: s ? r4(s.per[0].nsfw) : null,
      gore: s ? r4(s.per[0].gore) : null,
    };
  }));
  const sheet = composeSheet(v.frames.map((f) => f.canvas), { cell: 240, cols: v.frames.length <= 4 ? v.frames.length : 3 });
  const valid = scored.filter((f) => f.nsfw != null);
  return {
    ok: true,
    duration: v.duration, w: v.w, h: v.h, tainted: v.tainted, via: v.via,
    nsfw: valid.length ? Math.max(...valid.map((f) => f.nsfw)) : null,
    gore: valid.length ? Math.max(...valid.map((f) => f.gore)) : null,
    frames: scored,
    sheet: await canvasToDataUrl(sheet, 0.8),
    ...(v.directError ? { directError: v.directError } : {}),
  };
}

async function opPing() {
  const i = await modelInfo();
  return { ok: true, model: i.model, backend: i.backend, loadMs: i.loadMs, labels: i.labels, workers: i.workers };
}

const OPS = { ping: opPing, classify: opClassify, sheet: opSheet, video: opVideo };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.to !== 'lab') return false;
  if (!trusted(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return false; }
  const op = OPS[msg.op];
  if (!op) { sendResponse({ ok: false, error: 'unknown op' }); return false; }
  const t0 = performance.now();
  Promise.resolve()
    .then(() => op(msg))
    .then((r) => sendResponse({ ...r, ms: Math.round(performance.now() - t0) }),
      (e) => sendResponse({ ok: false, error: errMsg(e) }));
  return true;
});
