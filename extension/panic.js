// panic.js: injected into the active tab (isolated world) when the streamer hits the panic hotkey.
// Pauses + mutes all media, covers the viewport with an opaque screen in a closed shadow root,
// and keeps it there until the streamer restores the page. Re-injecting while panicked does nothing.
(() => {
  const MARK = '__clicksafePanic';
  if (Object.prototype.hasOwnProperty.call(window, MARK)) return;
  Object.defineProperty(window, MARK, { value: true, enumerable: false, configurable: true, writable: false });

  // ---------- media ----------
  const touched = new Map(); // element -> { wasPlaying, wasMuted }
  function hush(el) {
    try {
      if (!touched.has(el)) touched.set(el, { wasPlaying: !el.paused && !el.ended, wasMuted: el.muted });
      el.pause();
      el.muted = true;
    } catch { /* ignore */ }
  }
  function hushAll(root) {
    try { for (const el of root.querySelectorAll('video,audio')) hush(el); } catch { /* ignore */ }
  }
  hushAll(document);
  // Anything the page tries to start while the panic screen is up is stopped again.
  const onPlay = (e) => { const t = e.target; if (t instanceof HTMLMediaElement) hush(t); };
  document.addEventListener('play', onPlay, true);
  document.addEventListener('playing', onPlay, true);
  document.addEventListener('volumechange', onPlay, true);

  // ---------- fullscreen ----------
  try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch { /* ignore */ }
  try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); } catch { /* ignore */ }
  const onFs = () => { try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch { /* ignore */ } };
  document.addEventListener('fullscreenchange', onFs, true);

  // ---------- overlay ----------
  const HOST_PROPS = {
    position: 'fixed', inset: '0', top: '0', left: '0', right: '0', bottom: '0', width: '100vw', height: '100vh',
    margin: '0', padding: '0', border: '0', 'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
    'z-index': '2147483647', display: 'block', background: '#0b0d12', opacity: '1', visibility: 'visible',
    'pointer-events': 'auto', transform: 'none', filter: 'none', 'clip-path': 'none', mask: 'none', contain: 'none',
    overflow: 'hidden', 'box-shadow': 'none', outline: 'none', zoom: '1', 'color-scheme': 'dark',
  };
  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{position:fixed;inset:0;display:grid;place-items:center;padding:24px 16px;overflow:auto;
  background:#0b0d12;color:#e8ecf3;
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:min(420px,100%);text-align:center}
.brand{display:inline-flex;gap:7px;align-items:center;font-weight:650;font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;color:#8b95a5}
.brand svg{width:16px;height:16px;color:#3ddc97}
.badge{width:84px;height:84px;margin:24px auto 20px;border-radius:24px;display:grid;place-items:center;background:#12151c;border:1px solid #232937;color:#3ddc97}
.badge svg{width:42px;height:42px}
h1{font-size:22px;line-height:1.25;margin:0 0 10px;font-weight:680;color:#f4f7fb;letter-spacing:-.01em}
p{margin:0 auto 22px;max-width:340px;color:#8b95a5}
button{font:inherit;font-weight:620;border-radius:10px;padding:10px 16px;cursor:pointer;border:1px solid transparent;
  background:#3ddc97;color:#06140d;transition:filter .15s}
button:hover{filter:brightness(1.08)}
button:focus-visible{outline:2px solid #3ddc97;outline-offset:2px}
.hint{margin:16px 0 0;font-size:12px;color:#5d6778}
kbd{font:11.5px ui-monospace,SFMono-Regular,Consolas,monospace;padding:1px 6px;border-radius:5px;border:1px solid #2b3240;background:#12151c;color:#c9d2de}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`;
  const SHIELD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7.5 2.7v5.6c0 4.7-3.2 8.4-7.5 10.2-4.3-1.8-7.5-5.5-7.5-10.2V5.2z" fill="currentColor"/><path d="M8.6 12.2l2.3 2.3 4.6-4.8" fill="none" stroke="#0b0d12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const HTML = `
<div class="wrap" role="dialog" aria-modal="true" aria-labelledby="h">
  <div class="card">
    <div class="brand">${SHIELD}ClickSafe</div>
    <div class="badge">${SHIELD}</div>
    <h1 id="h">ClickSafe panic screen — page hidden</h1>
    <p id="sub">Media on this page is paused and muted. It won't start again on its own.</p>
    <button type="button" id="show">Show the page again</button>
    <div class="hint"><kbd>Esc</kbd> twice to restore</div>
  </div>
</div>`;

  const host = document.createElement('clicksafe-panic');
  for (const [k, v] of Object.entries(HOST_PROPS)) host.style.setProperty(k, v, 'important');
  host.setAttribute('popover', 'manual');
  const hostStyle = host.getAttribute('style');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS}</style>${HTML}`; // static markup only, no page data
  const n = [...touched.values()].filter((x) => x.wasPlaying).length;
  if (n) shadow.getElementById('sub').textContent = `Paused ${n} playing video${n > 1 ? 's or sounds' : ' or sound'} and muted the page. Nothing resumes on its own.`;

  let active = true;
  let burst = 0, burstT = 0;
  function attach() {
    if (!active) return;
    const r = document.documentElement;
    if (!r) return;
    const now = Date.now();
    if (now - burstT > 1000) { burstT = now; burst = 0; }
    if (++burst > 60) return; // don't get into an endless tug-of-war with the page
    if (host.getAttribute('style') !== hostStyle) host.setAttribute('style', hostStyle);
    if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
    if (host.hasAttribute('hidden')) host.removeAttribute('hidden');
    if (host.hasAttribute('inert')) host.removeAttribute('inert');
    if (host.parentNode !== r || r.lastElementChild !== host) r.appendChild(host);
    try { if (!host.matches(':popover-open')) host.showPopover(); } catch { /* top layer unavailable; z-index still applies */ }
  }
  attach();
  host.addEventListener('toggle', (e) => { if (active && e.newState === 'closed') queueMicrotask(attach); });

  const mo = new MutationObserver(() => { if (active) { attach(); hushAll(document); } });
  mo.observe(document, { childList: true });
  if (document.documentElement) mo.observe(document.documentElement, { childList: true });
  mo.observe(host, { attributes: true });
  // The page may swap out <html> itself; follow the new one.
  const docMo = new MutationObserver(() => { if (active && document.documentElement) mo.observe(document.documentElement, { childList: true }); });
  docMo.observe(document, { childList: true });
  const keep = setInterval(attach, 500); // catches anything the observers miss (or a throttled burst)

  const btn = shadow.getElementById('show');
  try { btn.focus({ preventScroll: true }); } catch { /* ignore */ }

  // ---------- restore ----------
  function restore() {
    if (!active) return;
    active = false;
    mo.disconnect(); docMo.disconnect(); clearInterval(keep);
    document.removeEventListener('play', onPlay, true);
    document.removeEventListener('playing', onPlay, true);
    document.removeEventListener('volumechange', onPlay, true);
    document.removeEventListener('fullscreenchange', onFs, true);
    window.removeEventListener('keydown', onKey, true);
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch { /* ignore */ }
    host.remove();
    // Put each element's own mute state back; playback stays paused on purpose.
    for (const [el, st] of touched) { try { el.muted = st.wasMuted; } catch { /* ignore */ } }
    touched.clear();
    try { delete window[MARK]; } catch { /* ignore */ }
    try { chrome.runtime.sendMessage({ t: 'unpanic' }).catch(() => {}); } catch { /* extension reloaded */ }
  }
  btn.addEventListener('click', (e) => { if (e.isTrusted) restore(); });

  let lastEsc = 0;
  function onKey(e) {
    if (!e.isTrusted || !active) return;
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const now = Date.now();
    if (now - lastEsc < 900) restore(); else lastEsc = now;
  }
  window.addEventListener('keydown', onKey, true);
})();
