// Classifier front-end for the offscreen document: a small pool of inference workers (lab/infer-worker.js,
// each running lab/engine.js on TF.js WASM SIMD) fed by an auto-batching queue. Falls back to running the
// engine on this thread if workers cannot start.

export const SIZE = 224;
const MAX_BATCH = 4;
const POOL = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 4)));
const BASE = chrome.runtime.getURL('');

let ready = null; // Promise<{ info, runners }>

function workerRunner() {
  const w = new Worker(chrome.runtime.getURL('lab/infer-worker.js'));
  const pending = new Map();
  let seq = 0, dead = null;
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.ok) p.resolve(data); else p.reject(new Error(data.error));
  };
  w.onerror = (e) => {
    dead = new Error('worker failed: ' + (e.message || 'error'));
    for (const p of pending.values()) p.reject(dead);
    pending.clear();
  };
  const call = (msg, transfer) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id }, transfer || []);
  });
  return {
    busy: false,
    init: () => call({ type: 'init', base: BASE }).then((r) => r.info),
    run: (xs, n) => call({ type: 'run', xs, n }, [xs.buffer]).then((r) => r.rows),
    close: () => w.terminate(),
  };
}

async function localRunner() {
  if (!globalThis.ClickSafeEngine) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('lab/engine.js');
      s.onload = resolve; s.onerror = () => reject(new Error('could not load engine'));
      document.head.append(s);
    });
  }
  const E = globalThis.ClickSafeEngine;
  return { busy: false, init: () => E.init(BASE), run: async (xs, n) => E.forward(xs, n), close() {} };
}

async function start() {
  const t0 = performance.now();
  let runners = [], info;
  try {
    const first = workerRunner();
    info = await first.init();
    runners.push(first);
    // The rest warm up in the background and join the pool as they become ready.
    for (let i = 1; i < POOL; i++) {
      const r = workerRunner();
      r.busy = true;
      runners.push(r);
      r.init().then(() => { r.busy = false; pump(); }, () => { r.close(); runners.splice(runners.indexOf(r), 1); });
    }
    info = { ...info, workers: POOL };
  } catch {
    for (const r of runners) r.close();
    const r = await localRunner();
    info = { ...(await r.init()), workers: 0 };
    runners = [r];
  }
  info.loadMs = Math.round(performance.now() - t0);
  return { info, runners };
}

export function loadModel() {
  ready ??= start().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function modelInfo() {
  return (await loadModel()).info;
}

// ---- auto-batching queue ----
const queue = [];
let starting = false;

function scoresOf(labels, row) {
  const s = {};
  labels.forEach((l, i) => { s[l] = Math.round(row[i] * 1e4) / 1e4; });
  return s;
}

async function pump() {
  if (!queue.length) return;
  let m;
  if (!ready) starting = true;
  try {
    m = await loadModel();
  } catch (e) {
    for (const q of queue.splice(0)) q.reject(e);
    return;
  } finally {
    starting = false;
  }
  await new Promise((r) => setTimeout(r, 0)); // let concurrent decoders add more inputs
  for (const r of m.runners) {
    if (r.busy || !queue.length) continue;
    const batch = queue.splice(0, MAX_BATCH);
    const xs = new Float32Array(batch.length * SIZE * SIZE * 3);
    batch.forEach((q, i) => xs.set(q.x, i * SIZE * SIZE * 3));
    r.busy = true;
    r.run(xs, batch.length)
      .then((rows) => batch.forEach((q, i) => q.resolve(scoresOf(m.info.labels, rows[i]))),
        (e) => batch.forEach((q) => q.reject(e)))
      .finally(() => { r.busy = false; pump(); });
  }
}

// x: Float32Array(224*224*3) RGB 0..255 (NHWC). Resolves to {NSFL, NSFW, SFW} probabilities.
export function classifyInput(x) {
  return new Promise((resolve, reject) => {
    queue.push({ x, resolve, reject });
    if (!starting) pump();
  });
}
