// Dedicated inference worker (classic script). One single-threaded WASM tfjs instance per worker; the
// offscreen document runs a small pool of these so a page full of images uses several cores without
// needing cross-origin isolation.
/* global importScripts, ClickSafeEngine */
importScripts('engine.js');

self.onmessage = async ({ data }) => {
  const { id, type } = data || {};
  try {
    if (type === 'init') {
      self.postMessage({ id, ok: true, info: await ClickSafeEngine.init(data.base) });
    } else if (type === 'run') {
      self.postMessage({ id, ok: true, rows: ClickSafeEngine.forward(data.xs, data.n) });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
