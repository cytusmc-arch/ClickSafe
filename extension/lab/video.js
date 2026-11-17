// Video sampling: seek a <video> to fractions of its duration and grab frames.
// Direct load first (crossOrigin=anonymous, untainted thanks to the extension's host permission);
// if that fails or comes back tainted, fetch the bytes (<= 30 MB, hardened) and play them from a blob URL.
import { fetchable } from '../lib/ai.js';
import { fetchBytes, canvas2d, sleep } from './media.js';

export const VIDEO_MAX_BYTES = 30 << 20;
const DEFAULT_POINTS = [0.02, 0.25, 0.5, 0.75, 0.97];

function waitFor(el, ok, ms, bad = ['error']) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(t); for (const e of ok) el.removeEventListener(e, onOk); for (const e of bad) el.removeEventListener(e, onBad); fn(v); };
    const onOk = (e) => done(resolve, e.type);
    const onBad = () => done(reject, new Error(el.error ? `media error ${el.error.code}${el.error.message ? ': ' + el.error.message : ''}` : 'media error'));
    const t = setTimeout(() => done(reject, new Error('timed out')), Math.max(1, ms));
    for (const e of ok) el.addEventListener(e, onOk);
    for (const e of bad) el.addEventListener(e, onBad);
  });
}

export function videoSrcAllowed(src) {
  return typeof src === 'string' && /^https?:/i.test(src) && fetchable(src);
}

// Cheap pre-flight with redirect:'error': the media element itself follows redirects, so make sure the
// URL does not bounce (e.g. to a LAN address) and is not an HTML page before handing it to <video>.
async function probe(src, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(src, { headers: { Range: 'bytes=0-1' }, signal: ctl.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (/text\/html|json|xml|javascript/.test(type)) throw new Error('not a video');
    return type;
  } catch (e) {
    throw new Error(ctl.signal.aborted ? 'timed out' : /HTTP|not a video/.test(e.message) ? e.message : 'network error or redirect');
  } finally {
    clearTimeout(t);
    ctl.abort();
  }
}

function grab(v, maxSide) {
  const w = v.videoWidth, h = v.videoHeight;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const [c, ctx] = canvas2d(w * s, h * s);
  ctx.drawImage(v, 0, 0, c.width, c.height);
  let tainted = false;
  try { ctx.getImageData(0, 0, 1, 1); } catch { tainted = true; }
  return { canvas: c, tainted };
}

// Load url into a fresh <video> and capture frames. Returns { duration, w, h, tainted, frames:[{t, canvas}] }.
export async function sampleVideo(url, { cors = true, points = DEFAULT_POINTS, deadline, maxSide = 320 } = {}) {
  const left = () => deadline - performance.now();
  const v = document.createElement('video');
  if (cors) v.crossOrigin = 'anonymous';
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.disableRemotePlayback = true;
  document.body.append(v);
  try {
    v.src = url;
    if (v.readyState < 1) await waitFor(v, ['loadedmetadata'], Math.min(left(), 8000));
    if (!v.videoWidth || !v.videoHeight) throw new Error('no video track');
    let duration = v.duration;
    if (!Number.isFinite(duration)) {
      // Files without a duration header (e.g. MediaRecorder WebM): a far seek makes Chrome compute it.
      v.currentTime = 1e101;
      await waitFor(v, ['durationchange', 'seeked'], Math.min(left(), 1000)).catch(() => {});
      duration = v.duration;
    }
    const out = { duration: Number.isFinite(duration) ? duration : null, w: v.videoWidth, h: v.videoHeight, tainted: false, frames: [] };
    if (Number.isFinite(duration) && duration > 0) {
      for (const p of points) {
        if (left() < 300) break;
        const t = Math.min(Math.max(0, p * duration), Math.max(0, duration - 0.04));
        if (Math.abs(v.currentTime - t) > 0.001 || v.seeking) {
          v.currentTime = t;
          await waitFor(v, ['seeked'], Math.min(left(), 4000));
        }
        if (v.readyState < 2) await waitFor(v, ['loadeddata', 'canplay'], Math.min(left(), 2000)).catch(() => {});
        if (Math.abs(v.currentTime - t) > Math.max(0.5, duration * 0.05)) { out.unseekable = true; break; } // server without range support
        const g = grab(v, maxSide);
        if (g.tainted) return { ...out, tainted: true, frames: [] };
        out.frames.push({ t: Math.round(v.currentTime * 1000) / 1000, canvas: g.canvas });
      }
    } else {
      // Live / unknown length: play and take ~4 frames over ~3 s.
      if (v.seeking || v.currentTime > 0) v.currentTime = 0; // undo the far seek
      v.play().catch(() => {});
      if (v.readyState < 2) await waitFor(v, ['canplay', 'playing'], Math.min(left() - 300, 2000)).catch(() => {});
      let last = -1;
      for (let i = 0; i < 4 && left() > 300; i++) {
        if (i) await sleep(Math.min(1000, left() - 250));
        if (v.readyState < 2 || v.currentTime === last) continue;
        last = v.currentTime;
        const g = grab(v, maxSide);
        if (g.tainted) return { ...out, tainted: true, frames: [] };
        out.frames.push({ t: Math.round(v.currentTime * 1000) / 1000, canvas: g.canvas });
      }
      v.pause();
    }
    return out;
  } finally {
    v.removeAttribute('src');
    try { v.load(); } catch { /* ignore */ }
    v.remove();
  }
}

const VIDEO_MAGIC = (b) => (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 ? 'video/webm'
  : String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' ? 'video/mp4'
    : String.fromCharCode(...b.subarray(0, 4)) === 'OggS' ? 'video/ogg' : '');

// Full pipeline for one URL. Returns { duration, w, h, tainted, via, frames:[{t, canvas}], directError? }.
export async function captureVideo(src, { points = DEFAULT_POINTS, timeoutMs = 12000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  await probe(src, Math.min(4000, timeoutMs / 2));
  let direct = null, directError = null;
  try {
    direct = await sampleVideo(src, { cors: true, points, deadline });
    if (!direct.tainted && direct.frames.length && !direct.unseekable) return { ...direct, via: 'direct' };
    if (!direct.tainted && direct.duration == null) return { ...direct, via: 'direct' }; // live: nothing to download
    if (direct.unseekable) directError = 'not seekable';
  } catch (e) {
    directError = e.message;
  }
  const left = deadline - performance.now();
  if (left < 500) {
    if (direct?.frames.length && !direct.tainted) return { ...direct, via: 'direct', directError };
    throw new Error(directError || 'timed out');
  }
  let bytes;
  try {
    ({ bytes } = await fetchBytes(src, { maxBytes: VIDEO_MAX_BYTES, timeoutMs: left }));
  } catch (e) {
    if (direct?.frames.length && !direct.tainted) return { ...direct, via: 'direct', directError: directError + '; fetch: ' + e.message };
    throw directError ? new Error(`${directError}; fetch: ${e.message}`) : e;
  }
  const type = VIDEO_MAGIC(bytes);
  if (!type) throw new Error('not a supported video');
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const r = await sampleVideo(url, { cors: false, points, deadline });
    return { ...r, tainted: direct?.tainted ?? null, via: 'fetch', directError };
  } finally {
    URL.revokeObjectURL(url);
  }
}
