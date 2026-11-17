// Inference engine for the media lab (classic script: loaded with importScripts() in lab/infer-worker.js,
// or with a <script> tag in the offscreen document if workers are unavailable).
// Runs models/isc-xs (OwenElliott/image-safety-classifier-xs, SwiftFormer-XS, MIT) lowered by
// models/isc-xs/.convert.py into a short NHWC op program, using TensorFlow.js on WASM SIMD
// (pure-JS CPU backend as a last resort). No network access besides the extension's own files.
/* global tf, importScripts */
(() => {
  const SIZE = 224;
  const TF_FILES = ['tf-core.es2017.min.js', 'tf-backend-cpu.es2017.min.js', 'tf-backend-wasm.es2017.min.js'];
  let M = null;

  function loadScripts(base) {
    const urls = TF_FILES.map((f) => base + 'vendor/tfjs/' + f);
    if (typeof importScripts === 'function') { importScripts(...urls); return Promise.resolve(); }
    return urls.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = resolve; s.onerror = () => reject(new Error('could not load ' + src));
      document.head.append(s);
    })), Promise.resolve());
  }

  function f16(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + f / 1024);
  }

  function decodeTensor(buf, e) {
    const n = e.shape.reduce((a, b) => a * b, 1);
    if (e.dtype === 'f32') return new Float32Array(buf.slice(e.offset, e.offset + n * 4));
    const out = new Float32Array(n);
    if (e.dtype === 'f16') {
      const h = new Uint16Array(buf.slice(e.offset, e.offset + n * 2));
      for (let i = 0; i < n; i++) out[i] = f16(h[i]);
      return out;
    }
    if (e.dtype !== 'int8') throw new Error('bad tensor dtype ' + e.dtype);
    const q = new Int8Array(buf, e.offset, n);
    const dim = e.shape[e.axis];
    const sc = new Float32Array(buf.slice(e.scales, e.scales + dim * 4));
    const stride = e.shape.slice(e.axis + 1).reduce((a, b) => a * b, 1);
    for (let i = 0; i < n; i++) out[i] = q[i] * sc[Math.floor(i / stride) % dim];
    return out;
  }

  async function pickBackend(base) {
    try {
      tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false); // threads need cross-origin isolation + blob: workers
      tf.wasm.setWasmPaths(base + 'vendor/tfjs/');
      if (await tf.setBackend('wasm')) { await tf.ready(); return 'wasm'; }
    } catch { /* fall through */ }
    await tf.setBackend('cpu');
    await tf.ready();
    return 'cpu';
  }

  const OPS = {
    affine: (op, x) => {
      let y = x;
      if (op.s) y = tf.mul(y, M.W[op.s]);
      if (op.b) y = tf.add(y, M.W[op.b]);
      return y === x ? tf.clone(x) : y;
    },
    conv: (op, x) => (op.dw ? tf.fused.depthwiseConv2d : tf.fused.conv2d)({
      x, filter: M.W[op.w], strides: op.stride, pad: op.pad, bias: op.b ? M.W[op.b] : undefined, activation: op.act,
    }),
    gelu: (op, x) => tf.mul(x, tf.add(tf.mul(tf.erf(tf.mul(x, M.K.rs2)), M.K.half), M.K.half)),
    gelu_s: (op, x) => tf.mul(x, tf.add(tf.erf(x), M.K.one)), // scales folded into neighbouring convs
    relu: (op, x) => tf.relu(x),
    reshape: (op, x) => tf.reshape(x, op.shape.map((d) => (d === -1 ? x.shape[0] : d))),
    transpose: (op, x) => tf.transpose(x, op.perm),
    matmul: (op, x) => {
      const w = M.W[op.w], c = x.shape[x.shape.length - 1];
      const y = tf.fused.matMul({ a: tf.reshape(x, [-1, c]), b: w, bias: op.b ? M.W[op.b] : undefined });
      return tf.reshape(y, [...x.shape.slice(0, -1), w.shape[1]]);
    },
    l2norm: (op, x) => tf.div(x, tf.maximum(tf.sqrt(tf.sum(tf.square(x), op.axis, true)), op.eps)),
    sum: (op, x) => tf.sum(x, op.axes, op.keep),
    mean: (op, x) => tf.mean(x, op.axes, op.keep),
    softmax: (op, x) => tf.softmax(x),
    add: (op, a, b) => tf.add(a, b),
    mul: (op, a, b) => tf.mul(a, b),
    sub: (op, a, b) => tf.sub(a, b),
    div: (op, a, b) => tf.div(a, b),
  };
  const BINARY = new Set(['add', 'mul', 'sub', 'div']);

  // xs: Float32Array of n*224*224*3 RGB values 0..255 (NHWC). Returns n probability rows.
  function forward(xs, n) {
    const { prog } = M;
    const vals = new Map([[prog.input.id, tf.tensor4d(xs, [n, SIZE, SIZE, 3])]]);
    try {
      for (const op of prog.ops) {
        const fn = OPS[op.op];
        if (!fn) throw new Error('unsupported op ' + op.op);
        const y = tf.tidy(() => (BINARY.has(op.op) ? fn(op, vals.get(op.a), vals.get(op.b)) : fn(op, vals.get(op.x))));
        vals.set(op.out, y);
        for (const id of op.free) { vals.get(id)?.dispose(); vals.delete(id); }
      }
      const p = vals.get(prog.output).dataSync();
      const k = prog.labels.length, rows = [];
      for (let i = 0; i < n; i++) rows.push(Array.from(p.subarray(i * k, i * k + k)));
      return rows;
    } finally {
      for (const t of vals.values()) t.dispose();
    }
  }

  async function init(base) {
    if (M) return M.info;
    const t0 = performance.now();
    if (!self.tf?.wasm) await loadScripts(base);
    tf.enableProdMode();
    const backend = await pickBackend(base);
    const [prog, buf] = await Promise.all([
      fetch(base + 'models/isc-xs/model.json').then((r) => r.json()),
      fetch(base + 'models/isc-xs/weights.bin').then((r) => r.arrayBuffer()),
    ]);
    if (prog.format !== 'clicksafe-nhwc-1' || buf.byteLength !== prog.weights.bytes) throw new Error('model files corrupt');
    const W = {};
    for (const [k, e] of Object.entries(prog.tensors)) W[k] = tf.tensor(decodeTensor(buf, e), e.shape, 'float32');
    M = { prog, W, K: { half: tf.scalar(0.5), rs2: tf.scalar(Math.SQRT1_2), one: tf.scalar(1) } };
    forward(new Float32Array(SIZE * SIZE * 3), 1); // warm-up: XNNPACK operator setup
    M.info = { model: prog.name, labels: prog.labels, backend, loadMs: Math.round(performance.now() - t0) };
    return M.info;
  }

  self.ClickSafeEngine = { SIZE, init, forward };
})();
