// ClickSafe shield: runs at document_start, covers the page before anything paints,
// masks the tab title + favicon, collects what rendered underneath, and reveals only when cleared.
// After a reveal, newly appearing images/videos stay blurred (and muted) until they are checked.
(() => {
  'use strict';
  if (window.top !== window || window.__clickSafeShield) return;
  Object.defineProperty(window, '__clickSafeShield', { value: true });

  const MASK_TITLE = 'Checking… · ClickSafe';
  const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0d12"/><path d="M16 5l9 3.2v6.6c0 5.6-3.8 10-9 12.2-5.2-2.2-9-6.6-9-12.2V8.2z" fill="#3ddc97"/></svg>');
  const HIDE_CSS = 'html{background:#0b0d12!important;overflow:hidden!important}' +
    'html>body{opacity:0!important;pointer-events:none!important;user-select:none!important}' +
    'dialog,:modal,[popover]:not(clicksafe-shield){display:none!important}';
  const HOST_PROPS = {
    position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0',
    'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0', 'z-index': '2147483647',
    display: 'block', background: '#0b0d12', opacity: '1', visibility: 'visible', 'pointer-events': 'auto',
    overflow: 'hidden', 'color-scheme': 'dark', transform: 'none', filter: 'none', 'clip-path': 'none',
    'mix-blend-mode': 'normal', contain: 'none', translate: 'none', scale: 'none', rotate: 'none',
  };

  let active = false, host = null, ui = null, styleEl = null, iconEl = null, obs = null, hostStyle = '';
  let pageTitle = null, stashedIcons = [], holdTimer = 0, runId = 0, lockdown = true;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => ui.getElementById(id);
  const root = () => document.documentElement;
  const C = globalThis.ClickSafeCollect;

  // ---------- private channel with guard.js (runs in the page's own world) ----------
  // A random event name only these two scripts know. The page can't learn it: both scripts run before
  // any page script, and the handshake listener is gone by the time the page starts.
  const NONCE = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36);
  const guardWaiters = new Map();
  const guardNotes = new Set();
  let guardSeen = false;
  const guardCmd = (op, extra = {}) => document.dispatchEvent(new CustomEvent('clicksafe:s:' + NONCE, { detail: JSON.stringify({ op, ...extra }) }));
  const sayHello = () => document.dispatchEvent(new CustomEvent('clicksafe:hello', { detail: NONCE }));
  document.addEventListener('clicksafe:ready', sayHello);
  queueMicrotask(() => document.removeEventListener('clicksafe:ready', sayHello));
  document.addEventListener('clicksafe:g:' + NONCE, (e) => {
    let m; try { m = JSON.parse(e.detail); } catch { return; }
    guardSeen = true;
    if (m.type === 'alert') onAlert(m);
    else if (m.type === 'note' && guardNotes.size < 30) guardNotes.add(String(m.note));
    const w = guardWaiters.get(m.type);
    if (w) { guardWaiters.delete(m.type); w(m); }
  });
  sayHello();
  const askGuard = (op, replyType, ms, extra) => new Promise((r) => {
    const t = setTimeout(() => { guardWaiters.delete(replyType); r(null); }, ms);
    guardWaiters.set(replyType, (m) => { clearTimeout(t); r(m); });
    guardCmd(op, extra);
  });
  // Something the page did is bad enough to block it right now (also after it was shown).
  async function onAlert(m) {
    let v;
    try { v = await send({ t: 'alert', alert: String(m.alert || ''), sample: String(m.sample || m.name || '').slice(0, 200) }); } catch { return; }
    if (v?.action === 'block' && v.blockUrl) goBlocked(v.blockUrl);
  }

  // ---------- UI ----------
  const SHIELD_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7.5 2.7v5.6c0 4.7-3.2 8.4-7.5 10.2-4.3-1.8-7.5-5.5-7.5-10.2V5.2z" fill="currentColor"/><path d="M8.6 12.2l2.3 2.3 4.6-4.8" fill="none" stroke="#0b0d12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{position:fixed;inset:0;display:grid;place-items:center;overflow:auto;padding:24px 16px;
  background:radial-gradient(900px 520px at 50% -8%,#10241b 0%,rgba(11,13,18,0) 60%),#0b0d12;
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8ecf3;-webkit-font-smoothing:antialiased;
  --accent:#3ddc97;--accent-ink:#06140d}
.wrap.hold{--accent:#ffb547;--accent-ink:#1d1200;background:radial-gradient(900px 520px at 50% -8%,#2a1f0b 0%,rgba(11,13,18,0) 60%),#0b0d12}
.card{width:min(440px,100%);text-align:center}
.brand{display:inline-flex;gap:7px;align-items:center;font-weight:650;font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;color:#8b95a5}
.brand svg{width:16px;height:16px;color:#3ddc97}
.radar{width:96px;height:96px;margin:26px auto 22px;position:relative;color:var(--accent)}
.radar::before{content:"";position:absolute;inset:0;border-radius:50%;
  background:conic-gradient(from 0deg,transparent 0 68%,color-mix(in srgb,var(--accent) 60%,transparent) 100%);
  -webkit-mask:radial-gradient(circle,transparent 54%,#000 55%);mask:radial-gradient(circle,transparent 54%,#000 55%);animation:spin 1.3s linear infinite}
.radar::after{content:"";position:absolute;inset:0;border-radius:50%;border:1px solid color-mix(in srgb,var(--accent) 22%,#1b2029)}
.radar svg{position:absolute;inset:26px;width:44px;height:44px}
.hold .radar::before{animation:none;background:none}
h1{font-size:22px;line-height:1.25;margin:0 0 10px;font-weight:680;color:#f4f7fb;letter-spacing:-.01em}
.host{display:inline-block;max-width:100%;font:12.5px/1 ui-monospace,SFMono-Regular,Consolas,monospace;padding:7px 11px;border-radius:999px;
  background:#141821;border:1px solid #232937;color:#c9d2de;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{color:#8b95a5;margin:14px auto 20px;max-width:360px}
.reason{display:none;margin:0 auto 18px;max-width:380px;padding:10px 12px;border-radius:10px;background:#1d170b;border:1px solid #3a2c10;color:#ffd79a;text-align:left}
.hold .reason{display:block}
.steps{list-style:none;padding:0;margin:0 auto 22px;display:grid;gap:9px;max-width:270px;text-align:left}
.steps li{display:flex;gap:10px;align-items:center;color:#5d6778}
.steps li.active{color:#e8ecf3}.steps li.done{color:#9aa4b2}.steps li[hidden]{display:none}
.dot{width:16px;height:16px;border-radius:50%;border:1.5px solid #2b3240;flex:none;display:grid;place-items:center}
li.active .dot{border-color:var(--accent);border-top-color:transparent;animation:spin .8s linear infinite}
li.done .dot{background:#3ddc97;border-color:#3ddc97}
li.done .dot::after{content:"";width:7px;height:4px;border-left:2px solid #06140d;border-bottom:2px solid #06140d;transform:translateY(-1px) rotate(-45deg)}
.hold .steps{display:none}
.actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
button{font:inherit;font-weight:620;border-radius:10px;padding:10px 16px;cursor:pointer;border:1px solid transparent;transition:filter .15s,background .15s}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.primary{background:var(--accent);color:var(--accent-ink)}.primary:hover{filter:brightness(1.08)}
.ghost{background:transparent;border-color:#2b3240;color:#c9d2de}.ghost:hover{background:#151922}
.link{background:none;border:none;color:#8b95a5;text-decoration:underline;text-underline-offset:3px;padding:10px 6px}
[hidden]{display:none!important}
.note{margin-top:18px;font-size:12px;color:#5d6778}
@keyframes spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;
  const HTML = `
<div class="wrap" id="wrap" role="dialog" aria-modal="true" aria-labelledby="h">
  <div class="card">
    <div class="brand">${SHIELD_SVG}ClickSafe</div>
    <div class="radar">${SHIELD_SVG}</div>
    <h1 id="h">Checking this page before it goes live</h1>
    <div class="host" id="host"></div>
    <p class="sub" id="sub">Hidden from your stream and muted until it's cleared.</p>
    <div class="reason" id="reason"></div>
    <ol class="steps" id="steps"></ol>
    <div class="actions">
      <button class="primary" id="back">Go back</button>
      <button class="ghost" id="show" hidden>Show anyway</button>
      <button class="link" id="trust" hidden>Always allow this site</button>
    </div>
    <div class="note" id="note"></div>
  </div>
</div>`;

  function important(el, props) { for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important'); }

  function buildHost() {
    host = document.createElement('clicksafe-shield');
    important(host, HOST_PROPS);
    hostStyle = host.getAttribute('style');
    host.setAttribute('popover', 'manual');
    ui = host.attachShadow({ mode: 'closed' });
    ui.innerHTML = `<style>${CSS}</style>${HTML}`;
    $('host').textContent = location.hostname;
    $('back').addEventListener('click', (e) => e.isTrusted && goBack());
    $('show').addEventListener('click', (e) => e.isTrusted && userReveal());
    $('trust').addEventListener('click', (e) => e.isTrusted && userTrust());
    // If the page closes our popover, put it straight back.
    host.addEventListener('toggle', (e) => { if (active && e.newState === 'closed') queueMicrotask(() => { try { host.showPopover(); } catch { /* ignore */ } }); });
  }

  // Keep the shield attached, last in <html>, in the top layer, with our styles intact.
  function attach() {
    const r = root();
    if (!r) return;
    if (!styleEl.isConnected) (document.head || r).appendChild(styleEl);
    if (host.getAttribute('style') !== hostStyle) host.setAttribute('style', hostStyle);
    if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
    if (host.hasAttribute('hidden')) host.removeAttribute('hidden');
    if (!host.isConnected || r.lastElementChild !== host) r.appendChild(host);
    try { if (!host.matches(':popover-open')) host.showPopover(); } catch { /* ignore */ }
    const b = document.body;
    if (b && b.style.getPropertyValue('opacity') && b.style.getPropertyValue('opacity') !== '0') b.style.setProperty('opacity', '0', 'important');
  }

  // ---------- title + favicon masking ----------
  function guard() {
    if (!active) return;
    attach();
    const t = document.title;
    if (document.head && t !== MASK_TITLE) { if (t) pageTitle = t; document.title = MASK_TITLE; }
    if (document.head) {
      for (const l of document.querySelectorAll('link[rel~="icon" i]:not([data-clicksafe])')) { stashedIcons.push([l, l.parentNode, l.nextSibling]); l.remove(); }
      if (!iconEl.isConnected) document.head.appendChild(iconEl);
    }
  }

  function cover() {
    if (active) return;
    active = true;
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.dataset.clicksafe = '1'; styleEl.textContent = HIDE_CSS; }
    if (!iconEl) { iconEl = document.createElement('link'); iconEl.rel = 'icon'; iconEl.href = ICON; iconEl.dataset.clicksafe = '1'; }
    if (!host) buildHost();
    setPhase('scan');
    guard();
    obs = new MutationObserver(guard);
    obs.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'popover', 'hidden', 'class'] });
    guardCmd('lock');
  }

  function uncover() {
    if (!active) return;
    active = false;
    clearTimeout(holdTimer);
    obs?.disconnect(); obs = null;
    try { host.hidePopover(); } catch { /* ignore */ }
    host.remove(); styleEl.remove(); iconEl.remove();
    for (const [l, parent, next] of stashedIcons) { try { (parent || document.head).insertBefore(l, next && next.parentNode === parent ? next : null); } catch { document.head?.appendChild(l); } }
    stashedIcons = [];
    if (document.title === MASK_TITLE) document.title = pageTitle || '';
    const b = document.body;
    if (b && b.style.getPropertyValue('opacity') === '0' && b.style.getPropertyPriority('opacity') === 'important') b.style.removeProperty('opacity');
    guardCmd('release');
  }

  // ---------- states ----------
  function buildSteps(list) {
    $('steps').replaceChildren(...list.map(([id, label]) => {
      const li = document.createElement('li'); li.id = 's-' + id;
      const d = document.createElement('span'); d.className = 'dot';
      const t = document.createElement('span'); t.className = 't'; t.textContent = label;
      li.append(d, t);
      return li;
    }));
  }
  function step(id, cls) { const li = $('s-' + id); if (li) li.className = cls; }
  function stepText(id, text) { const t = $('s-' + id)?.querySelector('.t'); if (t) t.textContent = text; }
  function setPhase(p, v = {}) {
    $('wrap').classList.toggle('hold', p === 'hold');
    if (p === 'scan') {
      $('h').textContent = 'Checking this page before it goes live';
      $('sub').textContent = "Hidden from your stream and muted until it's cleared.";
      $('show').hidden = true; $('trust').hidden = true; $('note').textContent = '';
      buildSteps([['link', 'Link & threat check'], ['content', 'Page content'], ['ai', 'AI verdict']]);
      step('link', 'active');
    } else if (p === 'hold') {
      const err = v.category === 'error';
      const locked = v.lock ?? (lockdown && !err);
      $('h').textContent = err ? "ClickSafe couldn't finish checking this page" : "This page isn't stream-safe";
      $('sub').textContent = locked ? 'It stays hidden. Lockdown mode is on.' : 'It stays hidden and muted until you decide.';
      $('reason').textContent = v.reason || 'Something on this page may break platform guidelines.';
      $('show').hidden = locked; $('trust').hidden = locked || !err;
      $('note').textContent = locked ? 'To allow it anyway, add the site in ClickSafe settings.' : '';
      $('back').focus();
    }
  }
  function armHoldButtons(ms) {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!active) return;
      $('note').textContent = 'Taking longer than usual. The page stays hidden until the check finishes.';
    }, ms || 6000);
  }

  // ---------- actions ----------
  function goBack() {
    if (history.length > 1) { history.back(); setTimeout(() => send({ t: 'closeTab' }).catch(() => {}), 1500); } else send({ t: 'closeTab' }).catch(() => window.close());
  }
  async function userReveal() {
    let r = null;
    try { r = await send({ t: 'reveal', url: location.href }); } catch { /* extension reloaded */ }
    if (r && r.ok === false) { setPhase('hold', { category: 'locked', reason: 'Lockdown mode keeps this page hidden.', lock: true }); return; }
    runId++;
    uncover();
    startMediaWatch();
  }
  async function userTrust() {
    let r = null;
    try { r = await send({ t: 'trust', host: location.hostname }); } catch { /* ignore */ }
    if (r && r.ok === false) return;
    runId++;
    uncover();
  }
  function goBlocked(url) {
    runId++;
    stopMediaWatch();
    if (!active) cover();
    try { location.replace(url); } catch { setPhase('hold', { category: 'other', reason: 'Blocked by ClickSafe.', lock: true }); }
  }

  // ---------- collecting what rendered underneath ----------
  const hostOf = (u) => { try { return new URL(u, location.href).hostname; } catch { return ''; } };
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const domReady = () => document.readyState !== 'loading' ? Promise.resolve() : new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  const loaded = () => document.readyState === 'complete' ? Promise.resolve() : new Promise((r) => window.addEventListener('load', r, { once: true }));
  const textLen = () => (document.body?.innerText || '').trim().length;

  function extract() {
    const q = (s) => document.querySelector(s);
    const meta = (n) => ((q(`meta[name="${n}" i]`) || q(`meta[property="${n}" i]`))?.getAttribute('content') || '').trim().slice(0, 300);
    let text = '';
    try { text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim(); } catch { /* ignore */ }
    const vh = innerHeight || 800;
    const imgs = [...document.images].map((i) => {
      const r = i.getBoundingClientRect();
      return { src: mediaSrc(i), alt: (i.alt || '').slice(0, 80), w: r.width, h: r.height, top: r.top };
    }).filter((i) => i.src && i.w >= 90 && i.h >= 90 && i.top < vh * 2.5 && !/\.svg(\?|#|$)/i.test(i.src))
      .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 6)
      .map(({ src, alt, w, h }) => ({ src, alt, w: Math.round(w), h: Math.round(h) }));
    const allMeta = [...document.querySelectorAll('meta[content]')].map((m) => m.content).join(' ').slice(0, 4000);
    const vids = [...document.querySelectorAll('video')];
    return {
      url: location.href, host: location.hostname,
      title: (pageTitle || (document.title !== MASK_TITLE ? document.title : '') || '').slice(0, 200),
      description: meta('description'), ogTitle: meta('og:title'), ogDesc: meta('og:description'), ogType: meta('og:type'),
      rating: meta('rating'), rta: /RTA-5042-1996-1400-1577-RTA/i.test(allMeta), lang: root()?.lang || '',
      headings: [...document.querySelectorAll('h1,h2')].map((h) => h.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8).map((s) => s.slice(0, 120)),
      text: text.slice(0, 4000), textLen: text.length,
      images: imgs, imageCount: document.images.length,
      videos: vids.length,
      posters: uniq(vids.map((v) => mediaSrc(v))).slice(0, 2),
      iframeHosts: uniq([...document.querySelectorAll('iframe[src]')].map((f) => hostOf(f.src))).slice(0, 8),
      passwordFields: document.querySelectorAll('input[type=password]').length,
      formHosts: uniq([...document.forms].map((f) => hostOf(f.action))).filter((h) => h !== location.hostname).slice(0, 5),
      linkCount: document.links.length,
    };
  }

  async function collect(isRescan) {
    await domReady();
    await Promise.race([loaded(), sleep(isRescan ? 900 : 1500)]);
    await sleep(250);
    for (let i = 0; i < 6 && textLen() < 150 && document.images.length < 2; i++) await sleep(250);
    return extract();
  }

  const mediaSrc = (el) => C.mediaSrc(el);

  // ---------- after reveal: new images/videos stay blurred until checked ----------
  const MEDIA_CSS = '[data-cs-hold]{filter:blur(32px) saturate(.3)!important;transition:none!important}video[data-cs-hold]{pointer-events:none!important}';
  let mediaOn = false, mediaStyle = null, mediaObs = null, mediaTimer = 0, mediaBusy = false, backoff = 1200;
  const pending = new Set(), seen = new WeakSet(), stuck = new WeakSet(), prevFilter = new WeakMap();
  const BLUR = 'blur(32px) saturate(0.3)';

  // Inline !important beats any stylesheet the page could add; re-applied if the page edits it.
  function applyBlur(el) {
    if (el.style.getPropertyValue('filter') !== BLUR || el.style.getPropertyPriority('filter') !== 'important') el.style.setProperty('filter', BLUR, 'important');
    const want = stuck.has(el) ? 'x' : '1';
    if (el.getAttribute('data-cs-hold') !== want) el.setAttribute('data-cs-hold', want);
  }
  function holdEl(el) {
    if (!prevFilter.has(el)) prevFilter.set(el, [el.style.getPropertyValue('filter'), el.style.getPropertyPriority('filter')]);
    pending.add(el);
    applyBlur(el);
    if (el.tagName === 'VIDEO' && !el.muted) { el.muted = true; el.dataset.csMuted = '1'; }
  }
  function releaseEl(el) {
    pending.delete(el);
    el.removeAttribute('data-cs-hold');
    const [v, p] = prevFilter.get(el) || ['', ''];
    prevFilter.delete(el);
    if (v) el.style.setProperty('filter', v, p); else el.style.removeProperty('filter');
    if (el.dataset.csMuted) { delete el.dataset.csMuted; try { el.muted = false; } catch { /* ignore */ } }
  }
  function stick(el) { pending.delete(el); stuck.add(el); applyBlur(el); }
  function consider(el, changed) {
    if (!mediaOn || (seen.has(el) && !changed)) return;
    seen.add(el);
    holdEl(el);
    schedule(400);
  }
  function schedule(ms) { if (!mediaTimer) mediaTimer = setTimeout(flush, ms); }

  function startMediaWatch() {
    if (mediaOn || !watchEnabled) return;
    mediaOn = true;
    if (!mediaStyle) { mediaStyle = document.createElement('style'); mediaStyle.dataset.clicksafe = '1'; mediaStyle.textContent = MEDIA_CSS; }
    (document.head || root()).appendChild(mediaStyle);
    for (const el of document.querySelectorAll('img,video')) seen.add(el); // covered by the page check
    mediaObs = new MutationObserver((muts) => {
      if (!mediaStyle.isConnected) (document.head || root()).appendChild(mediaStyle);
      for (const m of muts) {
        if (m.type === 'attributes') {
          const t = m.target;
          if (pending.has(t) || stuck.has(t)) { if (m.attributeName === 'style' || m.attributeName === 'data-cs-hold') applyBlur(t); else if (pending.has(t)) holdEl(t); }
          else if (m.attributeName !== 'style' && m.attributeName !== 'data-cs-hold' && t.matches?.('img,video')) consider(t, true);
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches('img,video')) consider(n, false);
          for (const e of n.querySelectorAll?.('img,video') || []) consider(e, false);
        }
      }
    });
    mediaObs.observe(root(), { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'data-cs-hold', 'style'] });
  }
  function stopMediaWatch() { mediaOn = false; mediaObs?.disconnect(); clearTimeout(mediaTimer); mediaTimer = 0; }

  async function flush() {
    mediaTimer = 0;
    if (!mediaOn) return;
    if (mediaBusy) return schedule(800);
    const ready = [];
    let waiting = false;
    for (const el of pending) {
      if (!el.isConnected) { pending.delete(el); continue; }
      const r = el.getBoundingClientRect();
      if (el.tagName === 'IMG') {
        if (!el.complete) { waiting = true; continue; }
        if (!el.naturalWidth) { releaseEl(el); continue; } // broken image
        const small = (r.width < 120 || r.height < 120) && (el.naturalWidth < 200 || el.naturalHeight < 200);
        if (small) { releaseEl(el); continue; }           // icons, avatars, emoji
      } else if (r.width < 120 || r.height < 90) { releaseEl(el); continue; }
      ready.push(el);
    }
    if (!ready.length) { if (waiting || pending.size) schedule(600); return; }
    ready.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const batch = ready.slice(0, 3);
    const items = batch.map((el) => ({ src: mediaSrc(el) }));
    mediaBusy = true;
    let v;
    try { v = await send({ t: 'media', items }); } catch { v = { action: 'error', lock: lockdown }; }
    mediaBusy = false;
    if (!mediaOn) return;
    if (v.action === 'reveal') { batch.forEach(releaseEl); backoff = 1200; }
    else if (v.action === 'block') { goBlocked(v.blockUrl); return; }
    else if (v.action === 'hold' || (v.action === 'unscannable' && v.lock)) {
      batch.forEach(stick); // stays blurred
    } else if (v.action === 'unscannable') batch.forEach(releaseEl);
    else if (!v.lock) batch.forEach(releaseEl);           // error, lockdown off: don't keep blurring
    else backoff = Math.min(15000, backoff * 2);            // error, lockdown on: retry later
    if (pending.size) schedule(v.action === 'error' ? backoff : 300);
  }

  // ---------- main flow ----------
  let watchEnabled = true;
  async function run(isRescan) {
    const id = ++runId;
    stopMediaWatch();
    cover();
    let r;
    try { r = await send({ t: 'hello', url: location.href, rescan: !!isRescan }); }
    catch { if (id === runId) setPhase('hold', { category: 'error', reason: 'ClickSafe was updated or restarted. Reload this tab to check it again.', lock: false }); return; }
    if (id !== runId) return;
    if (!r || r.error) { setPhase('hold', { category: 'error', reason: r?.error || 'No answer from ClickSafe.', lock: false }); return; }
    if (r.action === 'allow') { uncover(); watchEnabled = !!r.watch; startMediaWatch(); return; }
    if (r.action === 'block') return goBlocked(r.blockUrl);
    lockdown = r.lockdown !== false;
    if (r.guard) guardCmd('config', { cfg: r.guard });

    const steps = [['link', 'Link & threat check']];
    if (r.sealed) steps.push(['sealed', r.sealed === 'done' ? 'Sealed remote preview: passed' : 'Sealed remote preview: skipped']);
    if (r.warp) steps.push(['warp', `Fast-forwarding timers ${r.warp} min`]);
    if (r.play) steps.push(['video', 'Pressing play on videos']);
    steps.push(['content', r.deep ? 'Reading every image & script' : 'Page content']);
    if (r.ai) steps.push(['ai', 'AI verdict']);
    buildSteps(steps);
    step('link', 'done'); if (r.sealed) step('sealed', 'done');
    armHoldButtons(r.holdAfterMs);

    await domReady();
    await Promise.race([loaded(), sleep(isRescan ? 900 : 1500)]);
    if (id !== runId) return;
    if (r.warp) {
      step('warp', 'active');
      const w = await askGuard('warp', 'warped', 7000, { ms: r.warp * 60e3 });
      if (id !== runId) return;
      if (w?.fired) await sleep(900); // let delayed content load and render
      stepText('warp', w ? `Timers fast-forwarded ${r.warp} min (${w.fired} fired)` : 'Timers: page guard unavailable');
      step('warp', 'done');
    }
    let videos = [];
    if (r.play) {
      step('video', 'active');
      videos = await C.sampleVideos({ max: 2, budgetMs: 9000 }).catch(() => []);
      if (id !== runId) return;
      const fr = videos.reduce((a, x) => a + x.frames, 0);
      stepText('video', videos.length ? `Played ${videos.length} video${videos.length > 1 ? 's' : ''} · ${fr} frames` : 'No videos on the page');
      step('video', 'done');
    }
    step('content', 'active');
    const data = await collect(isRescan);
    if (id !== runId) return;
    const deep = { videos, deep: !!r.deep };
    if (r.deep) {
      deep.images = C.gatherImages({ max: 80, snaps: 10 });
      deep.scripts = C.gatherScripts();
      deep.embeds = C.embeds();
    }
    const g = await askGuard('signals', 'signals', 900);
    deep.signals = g?.sig || null;
    deep.notes = [...guardNotes];
    deep.guard = guardSeen;
    if (id !== runId) return;
    if (r.deep) stepText('content', `Read ${deep.images.length} images · ${deep.scripts.urls.length + deep.scripts.inline.length} scripts`);
    step('content', 'done');
    if (r.ai) step('ai', 'active');

    let v;
    try { v = await send({ t: 'scan', data, deep }); } catch { v = { action: 'hold', category: 'error', reason: 'ClickSafe was updated or restarted. Reload this tab to check it again.', lock: false }; }
    if (id !== runId || !v || v.action === 'stale') return;
    if (v.error) v = { action: 'hold', category: 'error', reason: v.error, lock: false };
    if (v.action === 'reveal') { step('ai', 'done'); uncover(); watchEnabled = !!v.watch; startMediaWatch(); }
    else if (v.action === 'block') goBlocked(v.blockUrl);
    else setPhase('hold', v);
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.t === 'rescan' && !active) run(true);
    else if (m?.t === 'wait' && active && ui) stepText('ai', `AI verdict (free slot in ${Number(m.sec) || 0}s)`);
    else if (m?.t === 'progress' && active && ui && typeof m.text === 'string') stepText('ai', m.text.slice(0, 80));
  });

  run(false);
})();
