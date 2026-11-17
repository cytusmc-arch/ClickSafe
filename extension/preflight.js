// preflight.html: shown in place of a page while ClickSafe checks it in a sealed remote browser,
// and in the small "Check a link" window (?mode=check). Everything after the first '#' is the URL.
// The page is web-accessible (navigations are redirected here), so all input is treated as hostile:
// text goes in with textContent only, and only http(s) URLs are ever navigated to.

if (window.top !== window) { document.documentElement.replaceChildren(); throw new Error('framed'); }

const $ = (id) => document.getElementById(id);
const href = location.href;
const hashAt = href.indexOf('#');
const rawUrl = hashAt >= 0 ? href.slice(hashAt + 1) : '';
const mode = new URLSearchParams(location.search).get('mode') === 'check' ? 'check' : 'nav';

const safeHttp = (u) => {
  try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
};
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
const host = hostOf(url);
const BLOCKED_PAGE = chrome.runtime.getURL('blocked.html');

let CAT_LABEL = {};
import('./lib/heuristics.js').then((m) => { CAT_LABEL = m.CAT_LABEL || {}; }).catch(() => {});
const catLabel = (c) => {
  const l = (c && Object.hasOwn(CAT_LABEL, c)) ? CAT_LABEL[c] : '';
  return l ? l.charAt(0).toUpperCase() + l.slice(1) : '';
};

const card = $('card');
const STEP_LABEL = { intel: 'Link & threat feeds', sealed: 'Sealed remote browser', shot: 'Screenshot check', ai: 'AI verdict' };

// ---------- static setup ----------
$('host').textContent = host;
$('host').title = host;
if (mode === 'check') {
  document.body.classList.add('check');
  if (url) { $('url').textContent = url.length > 300 ? url.slice(0, 300) + '…' : url; $('url').title = url.slice(0, 2000); $('url').hidden = false; }
  $('copy').hidden = !url;
  $('close').hidden = false;
} else {
  $('back').hidden = false; // cancel while checking: closing the port aborts the check
}

// ---------- elapsed timer ----------
const t0 = Date.now();
let tick = setInterval(showElapsed, 1000);
function showElapsed() { $('elapsed').textContent = `${Math.floor((Date.now() - t0) / 1000)} s`; }
function stopTimer() {
  if (tick) { clearInterval(tick); tick = null; }
  showElapsed();
  $('elapsed').textContent = `Checked in ${Math.max(0, Math.round((Date.now() - t0) / 1000))} s`;
}

// ---------- UI helpers ----------
function setState(state, title, sub) {
  card.dataset.state = state;
  $('title').textContent = title;
  if (sub != null) $('sub').textContent = sub;
}
function setReason(cat, text) {
  $('reasonCat').textContent = cat || '';
  $('reasonText').textContent = String(text || '').slice(0, 300);
  $('reason').hidden = !cat && !text;
}
function step(id, state, text) {
  const li = $('s-' + id);
  if (!li || !Object.hasOwn(STEP_LABEL, id)) return;
  if (state === 'active' || state === 'done' || state === 'skip') li.className = state;
  if (typeof text === 'string' && text) li.querySelector('.t').textContent = text.slice(0, 90);
  if (state === 'active' && card.dataset.state === 'checking') $('sub').textContent = `Checking: ${li.querySelector('.t').textContent}`;
}
function resetSteps() {
  for (const [id, label] of Object.entries(STEP_LABEL)) { const li = $('s-' + id); li.className = ''; li.querySelector('.t').textContent = label; }
}
function show(...ids) { for (const id of ids) $(id).hidden = false; }
function hide(...ids) { for (const id of ids) $(id).hidden = true; }
function focusFirstAction() {
  const b = [...$('actions').querySelectorAll('button')].find((x) => !x.hidden);
  (b || $('title')).focus();
}
function finalNote(finalUrl) {
  const f = safeHttp(finalUrl);
  const fh = hostOf(f);
  const el = $('final');
  el.replaceChildren();
  if (fh && fh !== host) {
    el.append('Ends up at ');
    const b = document.createElement('b'); b.textContent = fh; el.append(b);
    el.hidden = false;
  } else el.hidden = true;
}
function replaceTo(u) {
  try { location.replace(u); } catch { showError(); }
}

// ---------- results ----------
let gotResult = false;
function onResult(m) {
  gotResult = true;
  stopTimer();
  const action = m.action;
  if (action === 'go') {
    if (mode === 'nav') {
      setState('go', 'Looks safe, opening…', `Loading ${host}`);
      closePort();
      replaceTo(url);
      return;
    }
    document.title = 'Looks safe · ClickSafe';
    setState('go', 'Looks safe', 'Nothing against stream guidelines was found.');
    finalNote(m.finalUrl);
    if (m.skipped) setReason('', `Sealed preview skipped: ${String(m.skipped).slice(0, 160)}, it will be fully checked when you open it.`);
    else setReason('', m.reason ? String(m.reason) : '');
    show('open'); hide('continue', 'retry', 'lockNote');
    focusFirstAction();
    return;
  }
  if (action === 'block') {
    if (mode === 'nav') {
      const b = String(m.blockUrl || '');
      if (b.startsWith(BLOCKED_PAGE)) { closePort(); replaceTo(b); return; }
      setState('block', 'Not stream-safe', 'ClickSafe stopped this page before it loaded.');
      show('back');
      focusFirstAction();
      return;
    }
    document.title = 'Not stream-safe · ClickSafe';
    setState('block', 'Not stream-safe', 'Don’t open this one on stream.');
    setReason(catLabel(m.category) || 'Not stream-safe', m.reason);
    finalNote(m.finalUrl);
    hide('open', 'continue', 'retry', 'lockNote');
    focusFirstAction();
    return;
  }
  if (action === 'hold') {
    document.title = 'Needs a closer look · ClickSafe';
    setState('hold', 'Needs a closer look', mode === 'nav'
      ? 'ClickSafe couldn’t clear this link yet. Nothing from it has loaded.'
      : 'ClickSafe couldn’t clear this link yet.');
    setReason(catLabel(m.category), m.reason || 'The sealed check wasn’t conclusive.');
    finalNote(m.finalUrl);
    hide('retry');
    if (mode === 'nav') {
      $('continue').disabled = false;
      if (m.lock) { hide('continue'); show('lockNote'); $('lockNote').textContent = 'Lockdown is on, so this can’t be opened.'; }
      else { show('continue'); hide('lockNote'); }
      show('back');
    } else show('open');
    focusFirstAction();
    return;
  }
  // 'invalid' or anything unknown
  document.title = 'Not a web link · ClickSafe';
  setState('invalid', 'That isn’t a web link', 'ClickSafe can only check http and https links.');
  setReason('', '');
  hide('open', 'continue', 'retry', 'lockNote', 'copy');
  if (mode === 'nav') show('back');
  focusFirstAction();
}

function showError() {
  stopTimer();
  document.title = 'Check interrupted · ClickSafe';
  setState('error', 'The check was interrupted', mode === 'nav'
    ? 'ClickSafe restarted before it finished. Nothing from this site has loaded.'
    : 'ClickSafe restarted before it finished.');
  setReason('', '');
  hide('open', 'continue', 'lockNote');
  show('retry');
  if (mode === 'nav') show('back');
  focusFirstAction();
}

// ---------- port ----------
let port = null;
let retried = false;
let closing = false;

function closePort() { closing = true; try { port?.disconnect(); } catch { /* gone */ } port = null; }

function connect() {
  try { port = chrome.runtime.connect({ name: 'preflight' }); } catch { port = null; onDrop(); return; }
  port.onMessage.addListener((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'step' && !gotResult) step(String(m.id || ''), m.state, m.text);
    else if (m.type === 'result') onResult(m);
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; if (!closing) onDrop(); });
  port.postMessage({ type: 'start', url, mode });
}

function onDrop() {
  if (gotResult) {
    // Result already shown; a later "continue" will need a fresh check, so disable it.
    if (!$('continue').hidden) { $('continue').disabled = true; }
    return;
  }
  if (!retried) { retried = true; resetSteps(); setTimeout(connect, 300); return; }
  showError();
}

// ---------- actions ----------
$('continue').addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  if (!port) { gotResult = false; showError(); return; }
  $('continue').disabled = true;
  setState('checking', 'Opening it hidden for a full check…', `Loading ${host}`);
  try { port.postMessage({ type: 'continue' }); } catch { showError(); }
});
$('open').addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  const u = safeHttp(url);
  if (u) window.open(u, '_blank', 'noopener');
});
$('copy').addEventListener('click', async (e) => {
  if (!e.isTrusted || !url) return;
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
    } catch { /* ignore */ }
  }
  $('copy').textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { $('copy').textContent = 'Copy link'; }, 1600);
});
$('back').addEventListener('click', async (e) => {
  if (!e.isTrusted) return;
  closePort();
  if (history.length > 1) { history.back(); return; }
  try { const tab = await chrome.tabs.getCurrent(); if (tab?.id != null) { await chrome.tabs.remove(tab.id); return; } } catch { /* ignore */ }
  window.close();
});
$('close').addEventListener('click', (e) => { if (e.isTrusted) { closePort(); window.close(); } });
$('retry').addEventListener('click', (e) => { if (e.isTrusted) location.reload(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mode === 'check' && e.isTrusted) { closePort(); window.close(); }
});

// ---------- go ----------
if (!url) onResult({ action: 'invalid' });
else connect();
