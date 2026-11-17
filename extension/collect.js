// Shared by shield.js (top frame) and frame.js (embedded frames). Runs in the extension's isolated world.
// Finds every image a page shows or holds back (lazy, CSS backgrounds, canvases, <template>/<noscript>,
// images preloaded only from code), every script it runs, and presses play on its videos to sample
// frames across the whole timeline.
(() => {
  'use strict';
  if (globalThis.ClickSafeCollect) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const sameHost = (u) => { try { return new URL(u, location.href).hostname === location.hostname; } catch { return false; } };

  function snapshot(el, w, h, max = 512, q = 0.72) {
    try {
      const sc = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q); // throws if the canvas is tainted
    } catch { return ''; }
  }

  // A scannable source: same-origin, blob: and data: media become a JPEG here (the extension can't fetch
  // blob: URLs); cross-origin ones are fetched by the extension.
  function mediaSrc(el) {
    if (el.tagName === 'VIDEO') {
      if (el.readyState >= 2 && el.videoWidth) { const d = snapshot(el, el.videoWidth, el.videoHeight); if (d) return d; }
      return el.poster ? abs(el.poster) : '';
    }
    const src = el.currentSrc || el.src || '';
    if (/^(blob:|data:)/i.test(src) || (src && sameHost(src))) {
      if (el.complete && el.naturalWidth) { const d = snapshot(el, el.naturalWidth, el.naturalHeight); if (d) return d; }
    }
    return /^https?:/i.test(src) ? src : '';
  }

  const bestFromSrcset = (ss) => {
    let best = '', bw = 0;
    for (const part of String(ss || '').split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      const w = parseFloat(d) || 1;
      if (u && w >= bw) { best = u; bw = w; }
    }
    return best ? abs(best) : '';
  };

  // Every image on the page, visible or not. Returns [{ src, w, h, vis, how }] best-first.
  function gatherImages({ max = 80, snaps = 10 } = {}) {
    const vh = innerHeight || 800;
    const out = new Map();
    const add = (src, w, h, vis, how, el) => {
      if (!src || out.has(src) || /\.svg(\?|#|$)/i.test(src) || /^data:image\/svg/i.test(src)) return;
      out.set(src, { src, w: Math.round(w || 0), h: Math.round(h || 0), vis: !!vis, how, el });
    };
    const shown = (el, r) => r.width > 0 && r.height > 0 && r.bottom > -vh && r.top < vh * 3 && getComputedStyle(el).visibility !== 'hidden';

    for (const img of document.images) {
      const r = img.getBoundingClientRect();
      const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.dataset.lazy || '';
      const cur = img.currentSrc || img.src;
      if (cur) add(/^https?:/i.test(cur) ? cur : cur, Math.max(r.width, img.naturalWidth || 0), Math.max(r.height, img.naturalHeight || 0), shown(img, r), 'img', img);
      if (lazy) add(abs(lazy), r.width, r.height, false, 'lazy');
      if (img.srcset) add(bestFromSrcset(img.srcset), r.width, r.height, false, 'srcset');
    }
    for (const s of document.querySelectorAll('picture source[srcset], img[data-srcset]')) add(bestFromSrcset(s.srcset || s.dataset.srcset), 0, 0, false, 'srcset');
    for (const v of document.querySelectorAll('video[poster]')) { const r = v.getBoundingClientRect(); add(abs(v.poster), r.width, r.height, shown(v, r), 'poster'); }
    for (const i of document.querySelectorAll('svg image')) add(abs(i.getAttribute('href') || i.getAttribute('xlink:href') || ''), 0, 0, false, 'svg');
    for (const i of document.querySelectorAll('input[type=image][src], object[data]')) add(abs(i.getAttribute('src') || i.getAttribute('data') || ''), 0, 0, false, 'object');

    // CSS background images (cheap enough for a few thousand elements).
    let n = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (++n > 4000) break;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none' || !bg.includes('url(')) continue;
      const r = el.getBoundingClientRect();
      for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(abs(m[1]), r.width, r.height, shown(el, r) && r.width >= 64 && r.height >= 64, 'css');
    }
    // Canvases (games, viewers, image "protection").
    let cv = 0;
    for (const c of document.querySelectorAll('canvas')) {
      if (cv >= 4 || c.width * c.height < 128 * 128) continue;
      try { const d = c.toDataURL('image/jpeg', 0.7); if (d.length > 2000) { const r = c.getBoundingClientRect(); add(d, r.width, r.height, shown(c, r), 'canvas'); cv++; } } catch { /* tainted */ }
    }
    // Held back in templates / noscript.
    for (const t of document.querySelectorAll('template')) for (const i of t.content.querySelectorAll('img[src], source[srcset]')) add(abs(i.getAttribute('src') || bestFromSrcset(i.getAttribute('srcset'))), 0, 0, false, 'template');
    for (const ns of document.querySelectorAll('noscript')) for (const m of ns.textContent.matchAll(/src=["']([^"']+)["']/g)) add(abs(m[1]), 0, 0, false, 'noscript');
    // Loaded by code without ever being put on the page (preloads, "surprise" images).
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if ((e.initiatorType === 'img' || e.initiatorType === 'css' || e.initiatorType === 'other' || e.initiatorType === 'link' || e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && IMG_EXT.test(e.name)) add(e.name, 0, 0, false, 'loaded by code');
      }
    } catch { /* ignore */ }

    const list = [...out.values()].filter((x) => /^(https?:|data:image\/|blob:)/i.test(x.src));
    // Tiny visible things are icons; hidden ones are kept (we don't know their size yet).
    const keep = list.filter((x) => !x.vis || x.w * x.h >= 90 * 90 || x.how === 'canvas');
    keep.sort((a, b) => (b.vis - a.vis) || (b.w * b.h - a.w * a.h));
    const picked = keep.slice(0, max);
    // blob:, data: and same-origin images are turned into JPEG data URLs here (the extension can't fetch blob:).
    let s = 0;
    for (const x of picked) {
      if (x.el && s < snaps && (/^blob:/i.test(x.src) || sameHost(x.src)) && x.el.complete && x.el.naturalWidth >= 64) {
        const d = snapshot(x.el, x.el.naturalWidth, x.el.naturalHeight);
        if (d) { x.src = d; s++; }
      }
      delete x.el;
    }
    return picked.filter((x) => !/^blob:/i.test(x.src));
  }

  // Every script: external URLs (incl. ones added later and module preloads) and inline code.
  function gatherScripts({ maxInline = 400_000 } = {}) {
    const urls = new Set();
    for (const s of document.scripts) if (s.src) urls.add(s.src);
    for (const l of document.querySelectorAll('link[rel=modulepreload][href], link[rel=preload][as=script][href]')) urls.add(abs(l.getAttribute('href')));
    try { for (const e of performance.getEntriesByType('resource')) if (e.initiatorType === 'script' || /\.m?js(\?|$)/i.test(e.name)) urls.add(e.name); } catch { /* ignore */ }
    const inline = [];
    let total = 0, i = 0;
    for (const s of document.querySelectorAll('script:not([src])')) {
      const t = s.textContent || '';
      i++;
      if (!t.trim() || total > maxInline) continue;
      const cut = t.slice(0, Math.min(150_000, maxInline - total));
      total += cut.length;
      inline.push({ src: `inline script #${i} (${s.type || 'js'})`, text: cut });
    }
    // Inline event handlers (onclick="...") can hide clipboard / download tricks too.
    let handlers = '';
    for (const el of document.querySelectorAll('[onclick],[onmousedown],[onmouseup],[onload],[onerror]')) {
      for (const a of ['onclick', 'onmousedown', 'onmouseup', 'onload', 'onerror']) { const v = el.getAttribute(a); if (v) handlers += v + ';\n'; }
      if (handlers.length > 40_000) break;
    }
    if (handlers) inline.push({ src: 'inline event handlers', text: handlers });
    return { urls: [...urls].filter((u) => /^https?:/i.test(u)).slice(0, 80), inline };
  }

  // Embedded players we can't reach directly: return their known thumbnail / file locations.
  function embeds() {
    const out = [];
    for (const f of document.querySelectorAll('iframe[src], embed[src]')) {
      const src = f.getAttribute('src') || '';
      let m;
      if ((m = /(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{11})/i.exec(src))) out.push({ kind: 'youtube', id: m[1] });
      else if ((m = /player\.vimeo\.com\/video\/(\d+)/i.exec(src))) out.push({ kind: 'vimeo', id: m[1] });
      else if ((m = /streamable\.com\/(?:e|o|s)\/(\w+)/i.exec(src))) out.push({ kind: 'streamable', id: m[1] });
      else if ((m = /tiktok\.com\/(?:embed\/v2|player\/v1)\/(\d+)/i.exec(src))) out.push({ kind: 'tiktok', id: m[1] });
      if (out.length >= 6) break;
    }
    return out;
  }

  // ---------- video: press play, sample frames across the whole timeline ----------
  const once = (el, ev, ms) => new Promise((r) => { let t = 0; const f = () => { clearTimeout(t); el.removeEventListener(ev, f); r(true); }; el.addEventListener(ev, f); t = setTimeout(() => { el.removeEventListener(ev, f); r(false); }, ms); });
  const frameReady = (v) => new Promise((r) => { if (v.requestVideoFrameCallback) { const t = setTimeout(r, 350); v.requestVideoFrameCallback(() => { clearTimeout(t); r(); }); } else setTimeout(r, 120); });

  function sheet(frames, cols) {
    if (!frames.length) return '';
    cols = Math.min(cols || 3, frames.length);
    const rows = Math.ceil(frames.length / cols), cw = 320, ch = 180;
    const c = document.createElement('canvas');
    c.width = cols * cw; c.height = rows * ch;
    const g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    frames.forEach((f, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      const sc = Math.min(cw / f.width, ch / f.height);
      const w = f.width * sc, h = f.height * sc;
      g.drawImage(f, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(x + 4, y + 4, 26, 20);
      g.fillStyle = '#fff'; g.font = 'bold 14px sans-serif'; g.fillText(String(i + 1), x + 10, y + 19);
    });
    return c.toDataURL('image/jpeg', 0.76);
  }
  function grab(v) {
    try {
      const sc = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(v.videoWidth * sc)); c.height = Math.max(1, Math.round(v.videoHeight * sc));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toDataURL('image/jpeg', 0.1); // throws if tainted
      return c;
    } catch { return null; }
  }

  async function sampleVideos({ max = 2, points = [0.02, 0.2, 0.4, 0.6, 0.8, 0.97], budgetMs = 9000 } = {}) {
    const t0 = Date.now();
    const vids = [...document.querySelectorAll('video')].map((v) => ({ v, r: v.getBoundingClientRect() }))
      .filter(({ v, r }) => (r.width >= 120 && r.height >= 80) || (!r.width && (v.currentSrc || v.src || v.querySelector('source'))))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height).slice(0, max);
    const out = [];
    for (const { v } of vids) {
      if (Date.now() - t0 > budgetMs) break;
      const orig = { t: v.currentTime, paused: v.paused, muted: v.muted };
      const res = { frames: 0, sheet: '', duration: 0, src: '', tainted: false, hidden: !v.getBoundingClientRect().width };
      try {
        v.muted = true;
        if (v.preload === 'none') v.preload = 'auto';
        if (v.readyState < 1) { v.play?.().catch(() => {}); await once(v, 'loadedmetadata', 3000); }
        const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
        if (/^https?:/i.test(src)) res.src = src;
        res.duration = Number.isFinite(v.duration) ? v.duration : 0;
        const frames = [];
        if (res.duration > 0.5) {
          for (const p of points) {
            if (Date.now() - t0 > budgetMs) break;
            v.currentTime = Math.max(0, Math.min(res.duration - 0.05, p * res.duration));
            await once(v, 'seeked', 2200);
            if (v.readyState < 2) await once(v, 'canplay', 1200);
            await frameReady(v);
            const c = v.videoWidth ? grab(v) : null;
            if (!c) { if (v.videoWidth) res.tainted = true; break; }
            frames.push(c);
          }
        } else { // live stream / unknown length: watch it for a couple of seconds
          v.play?.().catch(() => {});
          for (let i = 0; i < 3 && Date.now() - t0 < budgetMs; i++) {
            await sleep(i ? 1100 : 300);
            const c = v.videoWidth ? grab(v) : null;
            if (!c) { if (v.videoWidth) res.tainted = true; break; }
            frames.push(c);
          }
        }
        res.frames = frames.length;
        res.sheet = sheet(frames, 3);
      } catch { /* ignore */ }
      try { v.currentTime = orig.t; } catch { /* ignore */ }
      try { if (orig.paused) v.pause(); v.muted = orig.muted; } catch { /* ignore */ }
      out.push(res);
    }
    return out;
  }

  Object.defineProperty(globalThis, 'ClickSafeCollect', { value: Object.freeze({ snapshot, mediaSrc, gatherImages, gatherScripts, embeds, sampleVideos }) });
})();
