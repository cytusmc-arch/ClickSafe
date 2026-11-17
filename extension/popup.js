import { CAT_LABEL } from './lib/heuristics.js';

const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
let tabId = null;

const SEV = { critical: 3, high: 2, medium: 1, low: 0 };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// "Timers fast-forwarded · 2 videos played (12 frames) · 48 images (9 hidden) · 31 scripts · 3 models"
function reportParts(r) {
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  const out = [];
  if (r.sealed) out.push('Sealed preview');
  if (n(r.warped)) out.push('Timers fast-forwarded');
  if (n(r.videos)) out.push(`${plural(n(r.videos), 'video')} played` + (n(r.frames) ? ` (${plural(n(r.frames), 'frame')})` : ''));
  if (n(r.images)) out.push(plural(n(r.images), 'image') + (n(r.hiddenImages) ? ` (${n(r.hiddenImages)} hidden)` : ''));
  if (n(r.scripts)) out.push(plural(n(r.scripts), 'script'));
  if (n(r.frames_)) out.push(plural(n(r.frames_), 'embedded frame'));
  if (r.audio) out.push('Audio checked');
  if (r.localModel) out.push('On-device image check');
  const models = Array.isArray(r.models) ? r.models.filter(Boolean) : [];
  if (models.length) out.push(plural(models.length, 'model'));
  return out;
}
function renderReport(r) {
  const parts = reportParts(r);
  const findings = (Array.isArray(r.findings) ? r.findings : []).filter((f) => f && typeof f === 'object')
    .sort((a, b) => (SEV[b.sev] ?? -1) - (SEV[a.sev] ?? -1)).slice(0, 3);
  if (!parts.length && !findings.length) return;
  $('checked').hidden = false;
  $('checkedSum').textContent = parts.join(' · ') || 'Basic checks only';
  const tip = [];
  if (Array.isArray(r.models) && r.models.length) tip.push('Models: ' + r.models.filter(Boolean).join(', '));
  if (r.localModel && Number.isFinite(Number(r.nsfwMax))) tip.push(`Highest on-device image score: ${Math.round(Number(r.nsfwMax) * 100)}%`);
  $('checkedSum').title = tip.join('\n');
  for (const f of findings) {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chip ' + (SEV[f.sev] >= 2 ? 'bad' : SEV[f.sev] === 1 ? 'warn' : '');
    chip.textContent = String(f.sev || 'note');
    const text = document.createElement('span');
    text.textContent = String(f.desc || 'Script finding');
    if (f.src) text.title = String(f.src);
    li.append(chip, text);
    $('finds').append(li);
  }
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const st = await send({ t: 'popup', tabId });
  document.body.classList.toggle('off', !st.enabled);
  $('enabled').checked = st.enabled;
  $('mode').textContent = st.enabled ? 'Stream shield is on' : 'Stream shield is off';
  $('ai').textContent = !st.ai ? 'AI vision scan: off (local checks only)'
    : st.provider === 'custom' ? `AI vision scan: your endpoint (${st.models[0] || '?'})` : `AI vision scan: free anonymous (${st.models.length} models)`;
  if (st.lockdown) $('ai').textContent += ' · Lockdown on';
  const d = st.deep;
  $('deep').hidden = !d;
  if (d) {
    const warp = Math.max(0, Math.round(Number(d.warp) || 0));
    const on = [d.sealed && 'sealed preview', warp && `${warp}-min time warp`, d.play && 'plays videos', d.scripts && 'reads scripts', d.local && 'on-device model', d.safeSearch && 'SafeSearch'].filter(Boolean);
    $('deep').textContent = 'Deep scan: ' + (on.length ? on.join(' · ') : 'off');
  }
  $('scanned').textContent = st.stats.scanned; $('held').textContent = st.stats.held; $('blocked').textContent = st.stats.blocked;

  const chip = $('status');
  $('host').textContent = st.web ? st.host : 'This page';
  $('reason').hidden = true;
  $('checked').hidden = true; $('finds').replaceChildren();
  for (const b of ['trust', 'untrust', 'rescan']) $(b).hidden = true;
  const set = (text, cls) => { chip.textContent = text; chip.className = 'chip ' + (cls || ''); };

  if (!st.web) return set('Not a website', '');
  if (st.private) return set('Local, not checked', '');
  if (st.trustedBy) { set('Allowed', 'ok'); $('untrust').hidden = false; $('reason').hidden = false; $('reason').textContent = `Allowed via ${st.trustedBy}: never hidden or scanned.`; return; }
  const s = st.state;
  const lockedOut = st.lockdown && s && (s.action === 'block' || (s.action === 'hold' && s.category !== 'error'));
  $('trust').hidden = lockedOut; $('rescan').hidden = false;
  if (!s) return set(st.enabled ? 'Not checked yet' : 'Shield off', '');
  if (s.report && typeof s.report === 'object') renderReport(s.report);
  const why = (s.reason ? s.reason : '') + (s.source === 'ai' && s.model ? ` · ${s.model}` : '') + (s.cached ? ' · cached' : '');
  if (why) { $('reason').hidden = false; $('reason').textContent = why + (lockedOut ? ' · Lockdown: allow it from settings if you really need it.' : ''); }
  if (s.action === 'reveal') set(s.source === 'you' ? 'Shown by you' : 'Safe', s.source === 'you' ? 'warn' : 'ok');
  else if (s.action === 'hold') set('Held', 'warn');
  else if (s.action === 'block') set('Blocked: ' + (CAT_LABEL[s.category] || 'unsafe'), 'bad');
  else set('Checking…', 'warn');
}

$('enabled').addEventListener('change', async (e) => { await send({ t: 'setEnabled', on: e.target.checked }); render(); });
$('trust').addEventListener('click', async () => { await send({ t: 'trust', host: $('host').textContent }); render(); });
$('untrust').addEventListener('click', async () => { await send({ t: 'untrust', host: $('host').textContent }); render(); });
$('rescan').addEventListener('click', async () => { await send({ t: 'rescan', tabId }); window.close(); });
$('panic').addEventListener('click', async () => { await send({ t: 'panic', tabId }); window.close(); });
$('checkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let v = $('checkUrl').value.trim();
  if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v; // "example.com/x" -> https
  let u = null;
  try { u = new URL(v); } catch { /* not a URL */ }
  if (!u || !/^https?:$/.test(u.protocol) || (!u.hostname.includes('.') && u.hostname !== 'localhost')) {
    $('checkMsg').textContent = 'Enter a web link starting with http:// or https://';
    return;
  }
  $('checkMsg').textContent = '';
  await send({ t: 'checkLink', url: u.href });
  window.close();
});
$('checkUrl').addEventListener('input', () => { $('checkMsg').textContent = ''; });
render();
