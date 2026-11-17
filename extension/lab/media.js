// Hardened fetching, type sniffing and decoding of untrusted images for the media lab.
import { fetchable } from '../lib/ai.js';
import { SIZE } from './model.js';

export const IMG_MAX_BYTES = 8 << 20;
const MAX_PIXELS = 40e6; // decompression-bomb guard (a 8 MB PNG can claim 30000x30000)
export const MIN_SIDE = 48;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch() with the same hardening as lib/ai.js: no cookies, no referrer, no redirects (a public URL must
// not bounce us to a private address), hard timeout and a byte cap enforced while streaming.
export async function fetchBytes(src, { maxBytes = IMG_MAX_BYTES, timeoutMs = 8000, signal } = {}) {
  const sig = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let r;
  try {
    r = await fetch(src, { signal: sig, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'default' });
  } catch (e) {
    throw new Error(sig.aborted ? 'timed out' : 'network error or redirect');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const len = Number(r.headers.get('content-length'));
  if (len > maxBytes) { r.body?.cancel().catch(() => {}); throw new Error('too large'); }
  const reader = r.body.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { reader.cancel().catch(() => {}); throw new Error('too large'); }
      parts.push(value);
    }
  } catch (e) {
    if (e.message === 'too large') throw e;
    throw new Error(sig.aborted ? 'timed out' : 'read failed');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return { bytes: out, type: (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
}

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

// Identify the format from magic bytes (never trust Content-Type), whether it may be animated,
// and the declared pixel size when the header carries it.
export function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let o = 2, w = 0, h = 0;
    while (o + 9 < b.length && b[o] === 0xff) {
      const mk = b[o + 1], len = u16be(b, o + 2);
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) { h = u16be(b, o + 5); w = u16be(b, o + 7); break; }
      o += 2 + len;
    }
    return { type: 'image/jpeg', animated: false, w, h };
  }
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    let animated = false;
    for (let o = 8; o + 8 <= b.length;) {
      const len = u32be(b, o), t = ascii(b, o + 4, 4);
      if (t === 'acTL') { animated = true; break; }
      if (t === 'IDAT') break;
      o += 12 + len;
    }
    return { type: 'image/png', animated, w: u32be(b, 16), h: u32be(b, 20) };
  }
  if (ascii(b, 0, 4) === 'GIF8') return { type: 'image/gif', animated: true, w: u16le(b, 6), h: u16le(b, 8) };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const c = ascii(b, 12, 4);
    if (c === 'VP8X') return { type: 'image/webp', animated: !!(b[20] & 0x02), w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
    if (c === 'VP8 ') return { type: 'image/webp', animated: false, w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    if (c === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { type: 'image/webp', animated: false, w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    return { type: 'image/webp', animated: false, w: 0, h: 0 };
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brands = ascii(b, 8, Math.min(32, b.length - 8));
    if (/avif|avis/.test(brands)) return { type: 'image/avif', animated: brands.includes('avis'), w: 0, h: 0 };
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return { type: 'image/bmp', animated: false, w: Math.abs(b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)), h: Math.abs(b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)) };
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { type: 'image/x-icon', animated: false, w: b[6] || 256, h: b[7] || 256 };
  return null;
}

// Load an item's bytes. src: data:image/... or public http(s) URL (checked with fetchable()).
export async function loadImageBytes(src, signal) {
  if (typeof src !== 'string' || !src) throw new Error('missing src');
  if (!/^(https?:|data:)/i.test(src) || !fetchable(src)) throw new Error('src not allowed');
  const { bytes } = await fetchBytes(src, { signal });
  const info = sniffImage(bytes);
  if (!info) throw new Error('not a supported image');
  if (info.w * info.h > MAX_PIXELS) throw new Error('image too large');
  return { bytes, ...info };
}

function canvas2d(w, h) {
  const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = c.getContext('2d', { willReadFrequently: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}

const inputCtx = (() => { const c = new OffscreenCanvas(SIZE, SIZE); return c.getContext('2d', { willReadFrequently: true }); })();

// Squash a source rect of a drawable into the model's 224x224 RGB float input (0..255, NHWC).
export function toInput(src, sx = 0, sy = 0, sw = src.width ?? src.displayWidth, sh = src.height ?? src.displayHeight) {
  const ctx = inputCtx;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE); // transparent pixels -> white, like a browser page would show them
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const x = new Float32Array(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { x[j] = px[i]; x[j + 1] = px[i + 1]; x[j + 2] = px[i + 2]; }
  return x;
}

// Downscaled copy (longest side <= max) of a drawable, on a canvas we own.
export function thumb(src, max, w = src.width ?? src.displayWidth, h = src.height ?? src.displayHeight) {
  const s = Math.min(1, max / Math.max(w, h));
  const [c, ctx] = canvas2d(w * s, h * s);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Model views of a still image: the whole picture, plus square crops along very long/tall images
// (long screenshots, stacked memes) where squashing would hide the detail.
function stillViews(w, h) {
  const v = [[0, 0, w, h]];
  const long = Math.max(w, h), short = Math.min(w, h);
  if (long / short >= 2.2) {
    const k = Math.min(3, Math.round(long / short));
    for (let i = 0; i < k; i++) {
      const o = Math.round(((long - short) * i) / (k - 1));
      v.push(w >= h ? [o, 0, short, short] : [0, o, short, short]);
    }
  }
  return v;
}

// Decode bytes into model inputs. Animated GIF/WebP/APNG/AVIF: up to `frames` evenly spaced frames.
// keep > 0 also returns a canvas copy (longest side <= keep) of every frame.
// Returns { w, h, animated, frames: [{ inputs:[Float32Array], canvas? }] }.
export async function decodeForModel(img, { frames = 6, keep = 0 } = {}) {
  const blobType = img.type;
  if (img.animated && 'ImageDecoder' in globalThis && await ImageDecoder.isTypeSupported(blobType).catch(() => false)) {
    let dec;
    try {
      dec = new ImageDecoder({ data: img.bytes, type: blobType, preferAnimation: true });
      await dec.tracks.ready;
      await Promise.race([dec.completed, sleep(3000)]);
      const track = dec.tracks.selectedTrack;
      const count = Math.max(1, track?.frameCount || 1);
      if (track?.animated && count > 1) {
        const n = Math.min(frames, count);
        const idx = [...new Set(Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round((i * (count - 1)) / (n - 1)))))];
        const out = [];
        let w = 0, h = 0;
        for (const frameIndex of idx) {
          const { image } = await dec.decode({ frameIndex, completeFramesOnly: true });
          try {
            w = image.displayWidth; h = image.displayHeight;
            if (w * h > MAX_PIXELS) throw new Error('image too large');
            if (w < MIN_SIDE || h < MIN_SIDE) return { w, h, animated: true, tiny: true, frames: [] };
            out.push({ index: frameIndex, inputs: [toInput(image, 0, 0, w, h)], canvas: keep ? thumb(image, keep, w, h) : null });
          } finally { image.close(); }
        }
        return { w, h, animated: true, frameCount: count, frames: out };
      }
    } catch (e) {
      if (/too large/.test(e.message)) throw e;
      /* fall back to a still decode */
    } finally {
      try { dec?.close(); } catch { /* closed */ }
    }
  }
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([img.bytes], { type: blobType }));
  } catch {
    throw new Error('image could not be decoded');
  }
  try {
    const { width: w, height: h } = bmp;
    if (w * h > MAX_PIXELS) throw new Error('image too large');
    if (w < MIN_SIDE || h < MIN_SIDE) return { w, h, animated: false, tiny: true, frames: [] };
    const inputs = stillViews(w, h).map(([sx, sy, sw, sh]) => toInput(bmp, sx, sy, sw, sh));
    return { w, h, animated: false, frames: [{ index: 0, inputs, canvas: keep ? thumb(bmp, keep, w, h) : null }] };
  } finally { bmp.close(); }
}

export async function canvasToDataUrl(c, quality = 0.8) {
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('encode failed'));
    fr.readAsDataURL(blob);
  });
}

// Run a list of async tasks with limited concurrency, preserving order.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export { canvas2d, sleep };
