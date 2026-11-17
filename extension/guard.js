// ClickSafe page guard. Runs in the page's own JS world at document_start, only on sites that are not on
// the allowed list. It talks to shield.js over a private, randomly named event channel.
//  1. While the page is hidden: holds back pop-ups, dialogs, fullscreen, file pickers and device prompts.
//  2. Time warp: can fast-forward every page timer (setTimeout/setInterval/Date/performance/rAF/animations)
//     by N minutes, so "looks normal for a minute, then the surprise" pages show their surprise while hidden.
//  3. Always on unchecked sites: never lets the page put a system command on the clipboard, strips STUN
//     servers from WebRTC (no public-IP leak), denies camera/mic/location/notification prompts, blocks
//     keyboard lock, history floods, leave-page traps and programs that download themselves.
//  4. Records behaviour (IP lookups, webhook exfiltration, wallet requests, WebAssembly + workers, code
//     generated at runtime) so the background can analyse it.
(() => {
  'use strict';
  if (window.top !== window || window.__clickSafeGuard) return;
  Object.defineProperty(window, '__clickSafeGuard', { value: true });

  // ---------- natives, captured before any page script runs ----------
  const W = window;
  const N = {
    setTimeout: W.setTimeout, clearTimeout: W.clearTimeout, setInterval: W.setInterval, clearInterval: W.clearInterval,
    rAF: W.requestAnimationFrame, Date: W.Date, dateNow: W.Date.now, perfNow: Performance.prototype.now,
    dispatch: EventTarget.prototype.dispatchEvent, addEL: EventTarget.prototype.addEventListener,
    CustomEvent: W.CustomEvent, JSON_stringify: JSON.stringify, JSON_parse: JSON.parse,
    reportError: W.reportError, getAnimations: Document.prototype.getAnimations, Reflect_apply: Reflect.apply,
    Proxy: W.Proxy, defineProperty: Object.defineProperty, URL: W.URL, now: () => N.dateNow.call(N.Date),
  };
  const doc = document;
  const proxy = (target, handler) => new N.Proxy(target, handler); // proxied natives keep their [native code] toString

  // ---------- private channel with shield.js ----------
  let nonce = '';
  const emit = (type, detail = {}) => {
    if (!nonce) { early.push([type, detail]); return; }
    try { N.dispatch.call(doc, new N.CustomEvent('clicksafe:g:' + nonce, { detail: N.JSON_stringify({ type, ...detail }) })); } catch { /* ignore */ }
  };
  const early = [];
  N.addEL.call(doc, 'clicksafe:hello', (e) => {
    if (nonce || typeof e.detail !== 'string' || !/^[a-z0-9]{24,}$/.test(e.detail)) return;
    nonce = e.detail;
    N.addEL.call(doc, 'clicksafe:s:' + nonce, onCommand);
    for (const [t, d] of early.splice(0)) emit(t, d);
  });
  try { N.dispatch.call(doc, new N.CustomEvent('clicksafe:ready')); } catch { /* ignore */ }

  let locked = true;
  const cfg = { clipboardGuard: true, blockPrompts: true, blockIpLookups: true };
  const sig = { iplookup: [], exfil: [], webrtc: 0, prompts: [], kbLock: 0, fullscreen: 0, unloadTraps: 0, historyFlood: 0, downloads: [], wallet: [], wasm: 0, wasmBytes: 0, workers: 0, clipboard: [], code: [], codeBytes: 0, writes: 0, warped: 0 };
  const alertOnce = new Set();
  const alert = (type, detail) => { if (alertOnce.has(type)) return; alertOnce.add(type); emit('alert', { alert: type, ...detail }); };

  function onCommand(e) {
    let m; try { m = N.JSON_parse(e.detail); } catch { return; }
    if (m.op === 'lock') locked = true;
    else if (m.op === 'release') { locked = false; restoreEval(); }
    else if (m.op === 'config') Object.assign(cfg, m.cfg || {});
    else if (m.op === 'warp') warp(Math.max(0, Math.min(30 * 60e3, Number(m.ms) || 0))).then((n) => emit('warped', { fired: n }));
    else if (m.op === 'signals') { wrapWallet(); emit('signals', { sig }); }
  }

  // ---------- 1. pop-ups and dialogs while hidden ----------
  const lockWrap = (obj, name, fallback) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = proxy(orig, { apply: (t, self, args) => (locked ? (typeof fallback === 'function' ? fallback(...args) : fallback) : N.Reflect_apply(t, self, args)) });
  };
  lockWrap(W, 'alert', undefined);
  lockWrap(W, 'confirm', false);
  lockWrap(W, 'prompt', null);
  lockWrap(W, 'print', undefined);
  lockWrap(W, 'open', null);
  const reject = (msg) => Promise.reject(new DOMException(msg || 'Blocked by ClickSafe', 'NotAllowedError'));
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) lockWrap(W, name, () => reject());

  // ---------- 2. time warp ----------
  let skew = 0;
  const vnow = () => N.now() + skew;
  const timers = new Map(); // native id -> { due, period, fire }

  const DateProxy = proxy(N.Date, {
    construct: (t, args, nt) => Reflect.construct(t, args.length ? args : [vnow()], nt === DateProxy ? t : nt),
    apply: (t) => new t(vnow()).toString(),
  });
  try { N.defineProperty(N.Date, 'now', { value: proxy(N.dateNow, { apply: () => Math.floor(vnow()) }), writable: true, configurable: true }); } catch { /* ignore */ }
  W.Date = DateProxy;
  Performance.prototype.now = proxy(N.perfNow, { apply: (t, self) => N.Reflect_apply(t, self, []) + skew });
  W.requestAnimationFrame = proxy(N.rAF, { apply: (t, self, [cb]) => N.Reflect_apply(t, W, [typeof cb === 'function' ? (ts) => cb(ts + skew) : cb]) });

  W.setTimeout = proxy(N.setTimeout, {
    apply(t, self, args) {
      const [fn, delay, ...rest] = args;
      if (typeof fn !== 'function') { code(String(fn), 'string timer'); return N.Reflect_apply(t, W, args); }
      const d = Math.max(0, Number(delay) || 0);
      let id = 0;
      const fire = () => { timers.delete(id); fn.apply(W, rest); };
      id = N.Reflect_apply(t, W, [fire, d]);
      timers.set(id, { due: vnow() + d, period: 0, fire });
      return id;
    },
  });
  W.setInterval = proxy(N.setInterval, {
    apply(t, self, args) {
      const [fn, delay, ...rest] = args;
      if (typeof fn !== 'function') { code(String(fn), 'string timer'); return N.Reflect_apply(t, W, args); }
      const p = Math.max(4, Number(delay) || 0);
      let id = 0;
      const call = () => fn.apply(W, rest);
      id = N.Reflect_apply(t, W, [() => { const e = timers.get(id); if (e) e.due = vnow() + p; call(); }, p]);
      timers.set(id, { due: vnow() + p, period: p, fire: call });
      return id;
    },
  });
  const clear = (t) => proxy(t, { apply: (tt, self, [id]) => { timers.delete(id); return N.Reflect_apply(tt, W, [id]); } });
  W.clearTimeout = clear(N.clearTimeout);
  W.clearInterval = clear(N.clearInterval);

  const tick = () => new Promise((r) => N.setTimeout.call(W, r, 0));
  async function warp(ms) {
    if (!ms) return 0;
    const target = vnow() + ms;
    const perInterval = new Map();
    let fired = 0;
    while (fired < 6000) {
      let best = null, bestId = null;
      for (const [id, e] of timers) if (e.due <= target && (!best || e.due < best.due)) { best = e; bestId = id; }
      if (!best) break;
      if (best.period) {
        const n = (perInterval.get(bestId) || 0) + 1;
        perInterval.set(bestId, n);
        if (n > 400) { best.due = target + best.period; continue; } // a busy interval: it has run enough
      }
      skew = Math.max(skew, best.due - N.now());
      if (best.period) best.due += best.period; else { timers.delete(bestId); N.clearTimeout.call(W, bestId); }
      try { best.fire(); } catch (err) { try { N.reportError?.call(W, err); } catch { /* ignore */ } }
      fired++;
      if (fired % 25 === 0) await tick(); // let promises, fetches and rendering catch up
    }
    skew = Math.max(skew, target - N.now());
    try { for (const a of N.getAnimations.call(doc)) if (a.playState === 'running' && a.currentTime != null) a.currentTime += ms; } catch { /* ignore */ }
    sig.warped += fired;
    await tick();
    return fired;
  }

  // ---------- 3. clipboard: no system commands from unchecked sites ----------
  const CMD = /(\bpowershell\b|\bpwsh\b|\bmshta\b|\bcmd(\.exe)?\s*\/[ck]\b|\biex\b|invoke-(expression|webrequest|restmethod)|\birm\s+\S|\biwr\s+\S|certutil|bitsadmin|rundll32|regsvr32|\bwscript\b|\bcscript\b|msiexec|frombase64string|-e(nc(odedcommand)?)?\s+[a-z0-9+/=]{24,}|start-process|\bschtasks\b|%comspec%|curl\s+[^\n|]*\|\s*(ba|z)?sh|wget\s+[^\n|]*\|\s*(ba|z)?sh|\bbash\s+-c\b|\bosascript\b|\bnohup\b.*https?:)/i;
  const badClip = (text) => {
    const t = String(text || '');
    if (!t || !CMD.test(t)) return false;
    sig.clipboard.push(t.slice(0, 300));
    alert('clipboardCmd', { sample: t.slice(0, 200) });
    return cfg.clipboardGuard;
  };
  if (W.Clipboard) {
    const CP = Clipboard.prototype;
    if (CP.writeText) CP.writeText = proxy(CP.writeText, { apply: (t, self, args) => (badClip(args[0]) ? Promise.resolve() : N.Reflect_apply(t, self, args)) });
    if (CP.write) {
      CP.write = proxy(CP.write, {
        apply: async (t, self, args) => {
          try {
            for (const item of args[0] || []) {
              if (item?.types?.includes('text/plain')) { const b = await item.getType('text/plain'); if (badClip(await b.text())) return undefined; }
            }
          } catch { /* fall through */ }
          return N.Reflect_apply(t, self, args);
        },
      });
    }
  }
  if (W.DataTransfer) {
    const sd = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = proxy(sd, { apply: (t, self, args) => (/text/i.test(String(args[0])) && badClip(args[1]) ? undefined : N.Reflect_apply(t, self, args)) });
  }
  const execCommand = Document.prototype.execCommand;
  Document.prototype.execCommand = proxy(execCommand, {
    apply(t, self, args) {
      if (/^(copy|cut)$/i.test(String(args[0]))) { let sel = ''; try { sel = String(W.getSelection?.() || ''); } catch { /* ignore */ } if (badClip(sel)) return false; }
      return N.Reflect_apply(t, self, args);
    },
  });

  // ---------- 4. device and permission prompts ----------
  const deny = (what, fallback) => () => { sig.prompts.push(what); emit('note', { note: what }); return fallback(); };
  const promptGate = (obj, name, what, fallback) => {
    const orig = obj?.[name];
    if (typeof orig !== 'function') return;
    obj[name] = proxy(orig, { apply: (t, self, args) => (cfg.blockPrompts || locked ? deny(what, () => fallback(args))() : N.Reflect_apply(t, self, args)) });
  };
  if (W.Notification) promptGate(Notification, 'requestPermission', 'notifications', () => Promise.resolve('denied'));
  if (W.PushManager) promptGate(PushManager.prototype, 'subscribe', 'push', () => reject());
  if (W.Geolocation) {
    const geoErr = (args) => { const cb = args[1]; if (typeof cb === 'function') N.setTimeout.call(W, () => cb({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }), 0); return 0; };
    promptGate(Geolocation.prototype, 'getCurrentPosition', 'location', geoErr);
    promptGate(Geolocation.prototype, 'watchPosition', 'location', geoErr);
  }
  if (W.MediaDevices) {
    promptGate(MediaDevices.prototype, 'getUserMedia', 'camera/microphone', () => reject());
    promptGate(MediaDevices.prototype, 'getDisplayMedia', 'screen capture', () => reject());
  }
  for (const [o, n] of [[W.USB?.prototype, 'requestDevice'], [W.HID?.prototype, 'requestDevice'], [W.Serial?.prototype, 'requestPort'], [W.Bluetooth?.prototype, 'requestDevice']]) promptGate(o, n, 'device access', () => reject());
  if (W.Keyboard?.prototype?.lock) {
    Keyboard.prototype.lock = proxy(Keyboard.prototype.lock, { apply: () => { sig.kbLock++; alert('kbLock'); return reject(); } });
  }
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
    const orig = Element.prototype[name];
    if (typeof orig !== 'function') continue;
    Element.prototype[name] = proxy(orig, {
      apply(t, self, args) {
        const gesture = !!navigator.userActivation?.isActive;
        if (locked || !gesture) { sig.fullscreen++; if (!locked) alert('fullscreen'); return reject('Fullscreen needs a click'); }
        return N.Reflect_apply(t, self, args);
      },
    });
  }

  // Leave-page traps ("Are you sure you want to leave?") and history floods (dead back button).
  EventTarget.prototype.addEventListener = proxy(N.addEL, {
    apply(t, self, args) {
      if (self === W && /^beforeunload$/i.test(String(args[0])) && cfg.blockPrompts) { sig.unloadTraps++; return undefined; }
      return N.Reflect_apply(t, self, args);
    },
  });
  try {
    let obu = null;
    N.defineProperty(W, 'onbeforeunload', { configurable: true, get: () => obu, set: (v) => { if (cfg.blockPrompts) { sig.unloadTraps++; obu = null; } else obu = v; } });
  } catch { /* ignore */ }
  let pushes = [];
  for (const name of ['pushState', 'replaceState']) {
    const orig = History.prototype[name];
    History.prototype[name] = proxy(orig, {
      apply(t, self, args) {
        const now = N.now();
        pushes = pushes.filter((x) => now - x < 2000); pushes.push(now);
        if (pushes.length > 25) { if (!sig.historyFlood++) alert('historyFlood'); return undefined; }
        return N.Reflect_apply(t, self, args);
      },
    });
  }

  // ---------- 5. downloads that start themselves ----------
  const RISKY_FILE = /\.(exe|scr|msi|msix|appx|bat|cmd|com|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|jar|apk|dmg|pkg|iso|img|vhdx?|dll|reg|cpl|chm|scf|inf|xll|docm|xlsm|pptm)$/i;
  const dlCheck = (a) => {
    try {
      if (!(a instanceof HTMLAnchorElement)) return true;
      const name = (a.getAttribute('download') || '') || (a.hasAttribute('download') || /^(blob|data):/i.test(a.href) ? new N.URL(a.href, location.href).pathname.split('/').pop() : '');
      if (!a.hasAttribute('download') && !/^(blob|data):/i.test(a.href)) return true;
      const risky = RISKY_FILE.test(String(name).trim()) || /^data:application\/(x-msdownload|x-msdos-program|octet-stream|x-ms-installer|hta)/i.test(a.href);
      if (risky || locked) { sig.downloads.push(String(name || a.href).slice(0, 120)); if (risky) alert('download', { name: String(name).slice(0, 120) }); return false; }
    } catch { /* ignore */ }
    return true;
  };
  HTMLAnchorElement.prototype.click = proxy(HTMLAnchorElement.prototype.click, { apply: (t, self, args) => (dlCheck(self) ? N.Reflect_apply(t, self, args) : undefined) });
  EventTarget.prototype.dispatchEvent = proxy(N.dispatch, {
    apply(t, self, args) {
      const ev = args[0];
      if (self instanceof HTMLAnchorElement && ev?.type === 'click' && !dlCheck(self)) return false;
      return N.Reflect_apply(t, self, args);
    },
  });

  // ---------- 6. network behaviour: IP lookups, webhook exfiltration, WebRTC ----------
  const IPLOOKUP = /(^|\.)(ipify\.org|ipinfo\.io|ip-api\.com|ipapi\.co|ipwho\.is|ipwhois\.app|ifconfig\.me|icanhazip\.com|checkip\.amazonaws\.com|myip\.com|geolocation-db\.com|freegeoip\.app|extreme-ip-lookup\.com|ipdata\.co|ip\.sb|ipgeolocation\.io|ipregistry\.co|wtfismyip\.com|myexternalip\.com|ident\.me|ipecho\.net|seeip\.org|bigdatacloud\.net|iplogger\.(org|com|ru|co)|grabify\.link)$/i;
  const EXFIL = /^https?:\/\/((canary\.|ptb\.)?discord(app)?\.com\/api(\/v\d+)?\/webhooks\/|api\.telegram\.org\/bot)/i;
  const netCheck = (url, via) => {
    let u; try { u = new N.URL(String(url), location.href); } catch { return; }
    if (EXFIL.test(u.href)) { sig.exfil.push(via); alert('exfil', { via }); return; }
    if (IPLOOKUP.test(u.hostname)) { if (sig.iplookup.length < 10) sig.iplookup.push(u.hostname); emit('note', { note: 'iplookup' }); }
  };
  W.fetch = proxy(W.fetch, { apply: (t, self, args) => { try { netCheck(args[0]?.url || args[0], 'fetch'); } catch { /* ignore */ } return N.Reflect_apply(t, self, args); } });
  XMLHttpRequest.prototype.open = proxy(XMLHttpRequest.prototype.open, { apply: (t, self, args) => { netCheck(args[1], 'xhr'); return N.Reflect_apply(t, self, args); } });
  if (navigator.sendBeacon) Navigator.prototype.sendBeacon = proxy(Navigator.prototype.sendBeacon, { apply: (t, self, args) => { netCheck(args[0], 'beacon'); return N.Reflect_apply(t, self, args); } });
  for (const C of ['WebSocket', 'EventSource']) {
    if (W[C]) W[C] = proxy(W[C], { construct: (t, args, nt) => { netCheck(args[0], C); return Reflect.construct(t, args, nt === W[C] ? t : nt); } });
  }
  for (const C of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const Orig = W[C];
    if (!Orig) continue;
    W[C] = proxy(Orig, {
      construct(t, args, nt) {
        const conf = args[0] && typeof args[0] === 'object' ? args[0] : null;
        const servers = (conf?.iceServers || []).flatMap((s) => [].concat(s?.urls || s?.url || []));
        if (servers.some((x) => /^(stun|turns?):/i.test(String(x)))) {
          sig.webrtc++;
          emit('note', { note: 'webrtc' });
          if (cfg.blockIpLookups) args = [{ ...conf, iceServers: [] }, ...args.slice(1)];
        }
        return Reflect.construct(t, args, nt === W[C] ? t : nt);
      },
    });
  }

  // ---------- 7. heavy background code (miners) ----------
  if (W.WebAssembly) {
    for (const name of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) {
      const orig = WebAssembly[name];
      if (typeof orig !== 'function') continue;
      WebAssembly[name] = proxy(orig, { apply: (t, self, args) => { sig.wasm++; try { sig.wasmBytes += args[0]?.byteLength || 0; } catch { /* ignore */ } return N.Reflect_apply(t, self, args); } });
    }
  }
  for (const C of ['Worker', 'SharedWorker']) {
    if (W[C]) W[C] = proxy(W[C], { construct: (t, args, nt) => { sig.workers++; return Reflect.construct(t, args, nt === W[C] ? t : nt); } });
  }

  // ---------- 8. crypto wallets ----------
  const RISKY_WALLET = /^(eth_sendTransaction|eth_sign|personal_sign|eth_signTypedData(_v[34])?|wallet_addEthereumChain|wallet_switchEthereumChain|solana_signTransaction|signTransaction|signAllTransactions)$/;
  const wrapped = new WeakSet();
  function wrapWallet() {
    for (const p of [W.ethereum, ...(W.ethereum?.providers || [])]) {
      if (!p || typeof p.request !== 'function' || wrapped.has(p)) continue;
      try {
        const orig = p.request;
        p.request = function (args) {
          const method = String(args?.method || '');
          sig.wallet.push(method);
          if (RISKY_WALLET.test(method)) { emit('note', { note: 'walletSign' }); if (locked) return Promise.reject({ code: 4001, message: 'Blocked by ClickSafe while the page is checked' }); }
          if (/requestAccounts|requestPermissions/.test(method)) { emit('note', { note: 'walletConnect' }); if (locked) return Promise.reject({ code: 4001, message: 'Blocked by ClickSafe while the page is checked' }); }
          return orig.apply(this, arguments);
        };
        wrapped.add(p);
      } catch { /* provider is frozen */ }
    }
  }
  N.setTimeout.call(W, wrapWallet, 0);

  // ---------- 9. code generated at runtime (unpacks obfuscated scripts for the analyser) ----------
  function code(text, how) {
    if (sig.code.length >= 40 || sig.codeBytes > 120_000 || !text) return;
    const t = String(text).slice(0, 8000);
    sig.codeBytes += t.length;
    sig.code.push({ how, text: t });
  }
  const origEval = W.eval;
  const evalProxy = proxy(origEval, { apply: (t, self, args) => { if (typeof args[0] === 'string') code(args[0], 'eval'); return N.Reflect_apply(t, W, args); } });
  W.eval = evalProxy; // only while hidden: indirect eval semantics could break rare pages afterwards
  function restoreEval() { if (W.eval === evalProxy) W.eval = origEval; }
  const FnProxy = proxy(Function, {
    apply: (t, self, args) => { code(args.map(String).join(', '), 'new Function'); return N.Reflect_apply(t, self, args); },
    construct: (t, args) => { code(args.map(String).join(', '), 'new Function'); return Reflect.construct(t, args); },
  });
  try { W.Function = FnProxy; N.defineProperty(Function.prototype, 'constructor', { value: FnProxy, writable: true, configurable: true }); } catch { /* ignore */ }
  for (const name of ['write', 'writeln']) {
    const orig = Document.prototype[name];
    Document.prototype[name] = proxy(orig, { apply: (t, self, args) => { sig.writes++; const h = args.join(''); if (/<script/i.test(h)) code(h, 'document.write'); return N.Reflect_apply(t, self, args); } });
  }

  try { performance.setResourceTimingBufferSize(4000); } catch { /* ignore */ }
})();
