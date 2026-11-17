import { CAT_LABEL } from './lib/heuristics.js';
import { getSettings } from './lib/settings.js';

// This page is web-accessible (pages get redirected here), so treat every parameter as hostile.
if (window.top !== window) { document.documentElement.replaceChildren(); throw new Error('framed'); }

const p = new URLSearchParams(location.search);
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !x.username && !x.password ? x.href : ''; } catch { return ''; } };
const cleanHost = (h) => (/^[a-z0-9.-]{1,253}$/i.test(h || '') ? h.toLowerCase() : '');
const h0 = cleanHost(p.get('h'));
const url = safeUrl(p.get('u')) || (h0 ? `https://${h0}/` : '');
const cat = Object.hasOwn(CAT_LABEL, p.get('cat') || '') ? p.get('cat') : 'other';
const src = p.get('src') || 'local';
let host = h0;
try { host = host || new URL(url).hostname; } catch { /* no url */ }

const $ = (id) => document.getElementById(id);
$('cat').textContent = CAT_LABEL[cat];
$('host').textContent = host || 'unknown';
$('reason').textContent = (p.get('r') || (src === 'list' ? 'Domain is on the ClickSafe blocklist' : 'Matched a safety rule')).slice(0, 160);
$('src').textContent = { ai: 'AI vision scan', local: 'Local safety checks', list: 'Built-in blocklist', error: 'Safety check' }[src] || 'Safety check';

$('back').addEventListener('click', async () => {
  if (history.length > 1) { history.back(); return; }
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id); else window.close();
});

const open = $('open');
const s = await getSettings();
if (!url || s.lockdown) {
  open.hidden = true;
  $('lockNote').hidden = !s.lockdown;
}
open.addEventListener('click', async (e) => {
  if (!e.isTrusted || !url) return;
  if (!confirm(`Open ${host} anyway? It will be visible on your screen and stream.`)) return;
  const r = await chrome.runtime.sendMessage({ t: 'openAnyway', url });
  if (r?.ok) location.href = url;
});
