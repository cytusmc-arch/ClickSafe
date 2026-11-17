import { getSettings, saveSettings, normDomain, DEFAULT_TRUSTED, SUGGESTED_SITES, NEVER_TRUST, AI_PRESETS, OVH_MODELS, inList } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
if (location.hash === '#welcome') $('welcome').classList.add('show');

let toastT = 0;
function toast(text = 'Saved') { const t = $('saved'); t.textContent = text; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 1100); }
async function save(patch, text) { await saveSettings(patch); toast(text); }
function msg(id, text, cls = '') { const m = $(id); m.textContent = text; m.className = 'msg ' + cls; }

// ---------- simple fields ----------
for (const el of document.querySelectorAll('[data-k]')) {
  el.addEventListener('change', async () => { await save({ [el.dataset.k]: el.checked }); render(); });
}
for (const el of document.querySelectorAll('[data-cat]')) {
  el.addEventListener('change', async () => { const s = await getSettings(); save({ cats: { ...s.cats, [el.dataset.cat]: el.checked } }); });
}
const secs = (id, key, min, max) => $(id).addEventListener('change', () => {
  const v = Math.min(max, Math.max(min, Number($(id).value) || min));
  $(id).value = v; save({ [key]: v * 1000 });
});
secs('holdAfterMs', 'holdAfterMs', 2, 60);
secs('aiTimeoutMs', 'aiTimeoutMs', 5, 90);
$('timeWarpMin').addEventListener('change', () => {
  const v = Math.min(30, Math.max(0, Math.round(Number($('timeWarpMin').value) || 0)));
  $('timeWarpMin').value = v; save({ timeWarpMin: v });
});
$('ytRestrict').addEventListener('change', () => {
  const v = $('ytRestrict').value;
  if (['off', 'moderate', 'strict'].includes(v)) save({ ytRestrict: v });
});
// chrome:// links can't be followed from a page, so open the shortcuts screen as a tab.
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---------- threat feeds ----------
const toTime = (x) => { const t = typeof x === 'number' ? x : Date.parse(x); return Number.isFinite(t) && t > 0 ? t : 0; };
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
function renderFeeds(r) {
  const el = $('feedStatus');
  el.className = ''; el.title = '';
  if (!r || typeof r !== 'object') { el.textContent = 'Feed status unavailable.'; return; }
  const src = Array.isArray(r.sources) ? r.sources.filter((x) => x && typeof x === 'object') : [];
  const num = (x) => Math.max(0, Number(x) || 0);
  const count = num(r.count ?? r.entries) || src.reduce((a, x) => a + num(x.count ?? x.entries), 0);
  const last = Math.max(0, ...[r.updated, r.ts, ...src.map((x) => x.fetched || x.updated || x.ts)].map(toTime));
  const failed = src.filter((x) => x.error).map((x) => String(x.name || 'feed'));
  const parts = [];
  if (src.length) parts.push(`${src.length} feed${src.length === 1 ? '' : 's'}`);
  parts.push(count ? `${count.toLocaleString()} entries` : 'no entries yet');
  if (last) parts.push(`updated ${ago(last)}`);
  if (r.refreshing) parts.push('updating…');
  if (failed.length) parts.push(`${failed.length} failed (${failed.join(', ')})`);
  else if (r.error) parts.push(String(r.error));
  el.textContent = parts.join(' · ');
  el.classList.toggle('bad', !count && !!(failed.length || r.error));
  el.title = src.map((x) => `${x.name || 'feed'}: ${num(x.count ?? x.entries).toLocaleString()} entries${toTime(x.fetched || x.updated) ? ', updated ' + ago(toTime(x.fetched || x.updated)) : ''}${x.error ? ' (' + x.error + ')' : ''}`).join('\n');
}
async function loadFeeds() {
  try { renderFeeds(await send({ t: 'feeds' })); } catch { renderFeeds(null); }
}
$('feedRefresh').addEventListener('click', async () => {
  const b = $('feedRefresh');
  b.disabled = true; $('feedStatus').className = ''; $('feedStatus').textContent = 'Updating feeds…';
  try { renderFeeds(await send({ t: 'feeds', refresh: true })); } catch (e) { renderFeeds({ error: 'Update failed: ' + e.message }); }
  finally { b.disabled = false; }
});

// ---------- activity log ----------
const ACTIONS = { reveal: ['Safe', 'ok'], go: ['Safe', 'ok'], hold: ['Held', 'warn'], block: ['Blocked', 'bad'] };
const SEV = { critical: 3, high: 2, medium: 1, low: 0 };
const sevCls = (s) => (SEV[s] >= 2 ? 'bad' : SEV[s] === 1 ? 'warn' : '');
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
function fmtTime(ts) {
  const d = new Date(ts);
  if (!toTime(ts)) return '—';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function line(label, text) {
  const div = document.createElement('div');
  const b = document.createElement('b'); b.textContent = label + ': ';
  div.append(b, text);
  return div;
}
function reportDetails(r) {
  const frag = document.createDocumentFragment();
  const sum = document.createElement('div'); sum.className = 'sum';
  sum.textContent = reportParts(r).join(' · ') || 'No deep-scan details recorded.';
  frag.append(sum);
  const models = Array.isArray(r.models) ? r.models.filter(Boolean).map(String) : [];
  if (models.length) frag.append(line('Models', models.join(', ')));
  const signals = Array.isArray(r.signals) ? r.signals.filter(Boolean).map(String) : [];
  if (signals.length) frag.append(line('Behaviour', signals.join(', ')));
  if (r.finalUrl) frag.append(line('Ended up at', String(r.finalUrl)));
  if (Number(r.ms) > 0) frag.append(line('Took', `${(Number(r.ms) / 1000).toFixed(1)} s`));
  const findings = Array.isArray(r.findings) ? r.findings.filter((f) => f && typeof f === 'object') : [];
  if (findings.length) {
    const ul = document.createElement('ul');
    for (const f of [...findings].sort((a, b) => (SEV[b.sev] ?? -1) - (SEV[a.sev] ?? -1))) {
      const li = document.createElement('li');
      const chip = document.createElement('span'); chip.className = 'chip ' + sevCls(f.sev); chip.textContent = String(f.sev || 'note');
      li.append(chip, String(f.desc || 'Script finding'));
      if (f.src) { const s = document.createElement('span'); s.className = 'src'; s.textContent = ' · ' + String(f.src).slice(0, 120); li.append(s); }
      ul.append(li);
    }
    frag.append(ul);
  }
  return frag;
}
const openRows = new Set();
let logSeq = 0;
async function renderLog() {
  const seq = ++logSeq;
  const body = $('logBody');
  let log = [];
  try { const r = await send({ t: 'getLog' }); log = Array.isArray(r?.log) ? r.log : []; } catch { /* worker asleep or gone */ }
  const on = (await getSettings()).activityLog;
  if (seq !== logSeq) return; // a newer render is on its way
  body.replaceChildren();
  $('logCount').textContent = log.length ? `${log.length} recent ${log.length === 1 ? 'entry' : 'entries'}` : '';
  $('clearLog').disabled = !log.length;
  if (!log.length) {
    const tr = document.createElement('tr'); tr.className = 'empty';
    const td = document.createElement('td'); td.colSpan = 6;
    td.textContent = on ? 'Nothing logged yet.' : 'The activity log is off.';
    tr.append(td); body.append(tr); return;
  }
  for (const e of log) {
    if (!e || typeof e !== 'object') continue;
    const key = `${e.ts}|${e.host}`;
    const tr = document.createElement('tr');
    const cell = (cls, text, title) => { const td = document.createElement('td'); td.className = cls; td.textContent = text; if (title) td.title = title; tr.append(td); return td; };
    cell('t', fmtTime(e.ts), toTime(e.ts) ? new Date(e.ts).toLocaleString() : '');
    cell('h', String(e.host || '—'), String(e.host || ''));
    const [label, cls] = e.action === 'reveal' && e.source === 'you' ? ['Shown by you', 'warn'] : ACTIONS[e.action] || [String(e.action || '—'), ''];
    const pill = document.createElement('span'); pill.className = 'chip ' + cls; pill.textContent = label;
    cell('p', '').append(pill);
    cell('c', e.category ? String(e.category).replace(/_/g, ' ') : '—');
    const why = cell('r', String(e.reason || ''));
    if (e.source) { const s = document.createElement('span'); s.className = 'src'; s.textContent = (e.reason ? ' · ' : '') + 'via ' + String(e.source); why.append(s); }
    const last = cell('x', '');
    body.append(tr);
    const rep = e.report && typeof e.report === 'object' ? e.report : null;
    if (!rep) continue;
    const det = document.createElement('tr'); det.className = 'det';
    const dtd = document.createElement('td'); dtd.colSpan = 6; dtd.append(reportDetails(rep));
    det.append(dtd); det.hidden = !openRows.has(key);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'more'; b.textContent = det.hidden ? '▸' : '▾';
    b.title = 'What was checked'; b.setAttribute('aria-label', `What was checked on ${e.host || 'this page'}`);
    b.setAttribute('aria-expanded', String(!det.hidden));
    b.addEventListener('click', () => {
      det.hidden = !det.hidden;
      if (det.hidden) openRows.delete(key); else openRows.add(key);
      b.textContent = det.hidden ? '▸' : '▾'; b.setAttribute('aria-expanded', String(!det.hidden));
    });
    last.append(b);
    body.append(det);
  }
}
$('clearLog').addEventListener('click', async () => { await send({ t: 'clearLog' }); openRows.clear(); toast('Cleared'); renderLog(); });
let logT = 0;
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.log) { clearTimeout(logT); logT = setTimeout(renderLog, 400); } });

// ---------- site lists ----------
function listItem(domain, onRemove) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = domain; span.title = domain;
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = '×'; b.title = `Remove ${domain}`; b.setAttribute('aria-label', `Remove ${domain}`);
  b.addEventListener('click', onRemove);
  li.append(span, b);
  return li;
}
function renderList(ul, items, key) {
  ul.replaceChildren();
  if (!items.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Nothing here yet.'; ul.append(li); return; }
  for (const d of [...items].sort()) {
    ul.append(listItem(d, async () => {
      const s = await getSettings();
      await save({ [key]: s[key].filter((x) => x !== d) }, 'Removed');
      render();
    }));
  }
}
async function addTo(key, raw, msgId) {
  const d = normDomain(raw);
  if (!d) return msg(msgId, "That doesn't look like a website address.", 'bad');
  const s = await getSettings();
  if (s[key].includes(d)) return msg(msgId, `${d} is already on the list.`);
  const other = key === 'trusted' ? 'blocked' : 'trusted';
  const patch = { [key]: [...s[key], d] };
  if (s[other].includes(d)) patch[other] = s[other].filter((x) => x !== d);
  await save(patch, key === 'trusted' ? 'Allowed' : 'Blocked');
  const note = key === 'trusted' && inList(d, NEVER_TRUST) ? ' (user-content pages there are still checked)' : '';
  msg(msgId, `${key === 'trusted' ? 'Allowed' : 'Blocked'} ${d}${note}.`, 'ok');
  render();
}
$('addTrustedForm').addEventListener('submit', (e) => { e.preventDefault(); addTo('trusted', $('addTrusted').value, 'trustedMsg'); $('addTrusted').value = ''; });
$('addBlockedForm').addEventListener('submit', (e) => { e.preventDefault(); addTo('blocked', $('addBlocked').value, 'blockedMsg'); $('addBlocked').value = ''; });
$('resetTrusted').addEventListener('click', async () => {
  if (!confirm('Replace your allowed sites with the default list?')) return;
  await save({ trusted: DEFAULT_TRUSTED }, 'Reset'); render();
});

// ---------- AI provider ----------
for (const p of AI_PRESETS) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; $('customPreset').append(o); }
$('customPreset').addEventListener('change', async () => {
  const p = AI_PRESETS.find((x) => x.id === $('customPreset').value);
  const patch = { customPreset: p.id };
  if (p.base) { patch.customBase = p.base; $('customBase').value = p.base; }
  if (p.id === 'ovh-key' && !$('customModels').value.trim()) { patch.customModels = OVH_MODELS; $('customModels').value = OVH_MODELS.join('\n'); }
  await save(patch); render();
});
$('customBase').addEventListener('change', async () => {
  const v = $('customBase').value.trim();
  if (v && !/^https:\/\/[^/\s]+/i.test(v)) { msg('customMsg', 'The API base URL must start with https://', 'bad'); return; }
  msg('customMsg', '');
  await save({ customBase: v.replace(/\/+$/, '') }); render();
});
$('customKey').addEventListener('change', async () => { await save({ customKey: $('customKey').value.trim() }); render(); });
$('customModels').addEventListener('change', async () => {
  const models = [...new Set($('customModels').value.split(/[\n,]+/).map((x) => x.trim()).filter((x) => /^[\w.:/@+-]{1,120}$/.test(x)))];
  $('customModels').value = models.join('\n');
  await save({ customModels: models }); render();
});

$('resetStats').addEventListener('click', async () => { await send({ t: 'resetStats' }); render(); });

$('test').addEventListener('click', async () => {
  const out = $('testOut');
  $('test').disabled = true;
  out.textContent = 'Asking each model to read a test image…';
  try {
    const r = await send({ t: 'test' });
    if (r.error) throw new Error(r.error);
    out.replaceChildren();
    const head = document.createElement('div');
    const chip = document.createElement('span');
    chip.className = 'chip ' + (r.ok ? 'ok' : 'bad'); chip.textContent = r.ok ? 'Working' : 'Not working';
    head.append(chip, ' ', r.ok ? 'The AI scanner can see images.' : 'No model answered correctly. The endpoint may be blocked on your network, or every model is rate-limited right now.');
    const ul = document.createElement('ul');
    for (const x of r.results) {
      const li = document.createElement('li');
      li.textContent = `${x.ok ? '✓' : '✕'} ${x.model} — ${x.note}`;
      li.style.color = x.ok ? 'var(--mint)' : 'var(--muted)';
      ul.append(li);
    }
    out.append(head, ul);
  } catch (e) {
    out.textContent = 'Test failed: ' + e.message;
  } finally { $('test').disabled = false; }
});

// ---------- render ----------
async function render() {
  const s = await getSettings();
  for (const el of document.querySelectorAll('[data-k]')) el.checked = !!s[el.dataset.k];
  for (const el of document.querySelectorAll('[data-cat]')) el.checked = !!s.cats[el.dataset.cat];
  $('holdAfterMs').value = Math.round(s.holdAfterMs / 1000);
  $('aiTimeoutMs').value = Math.round(s.aiTimeoutMs / 1000);
  if (document.activeElement !== $('timeWarpMin')) $('timeWarpMin').value = Math.max(0, Math.min(30, Number(s.timeWarpMin) || 0));
  $('ytRestrict').value = ['off', 'moderate', 'strict'].includes(s.ytRestrict) ? s.ytRestrict : 'moderate';
  renderList($('trustedList'), s.trusted, 'trusted');
  renderList($('blockedList'), s.blocked, 'blocked');

  const sug = $('suggest');
  sug.replaceChildren();
  const left = SUGGESTED_SITES.filter((d) => !s.trusted.includes(d));
  if (left.length) {
    const lab = document.createElement('span'); lab.className = 'label'; lab.textContent = 'Quick add:'; sug.append(lab);
    for (const d of left) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = '+ ' + d;
      b.addEventListener('click', () => addTo('trusted', d, 'trustedMsg'));
      sug.append(b);
    }
  }

  $('customBox').hidden = !s.customAi;
  $('customPreset').value = s.customPreset;
  if (document.activeElement !== $('customBase')) $('customBase').value = s.customBase || '';
  if (document.activeElement !== $('customKey')) $('customKey').value = s.customKey || '';
  if (document.activeElement !== $('customModels')) $('customModels').value = (s.customModels || []).join('\n');
  const chip = $('providerChip');
  if (!s.aiEnabled) { chip.className = 'chip'; chip.textContent = 'AI off: local checks only'; }
  else if (s.aiProvider === 'custom') { chip.className = 'chip warn'; chip.textContent = `Using your endpoint · ${s.models[0]}`; }
  else { chip.className = 'chip ok'; chip.textContent = s.customAi ? 'Free anonymous (your endpoint is incomplete)' : 'Free anonymous scanner'; }

  const { stats = { scanned: 0, blocked: 0, held: 0 } } = await chrome.storage.local.get('stats');
  $('stats').textContent = `${stats.scanned} pages checked · ${stats.held} held · ${stats.blocked} blocked`;
  renderLog();
}
render();
loadFeeds();
