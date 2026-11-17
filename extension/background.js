import { getSettings, saveSettings, hostOf, inList, matchIn, isPrivateHost, normDomain, NEVER_TRUST } from './lib/settings.js';
import { checkUrl, analyzeContent, decide, CAT_TOGGLE, SIGNAL_RULES } from './lib/heuristics.js';
import { aiScan, aiMediaScan, testConnection, guardText, analystScan, transcribe, fetchable } from './lib/ai.js';
import { scanScripts, summarize, mediaInCode } from './lib/scripts.js';
import { sealedEligible, sealedFetch, shotTiles } from './lib/sealed.js';
import * as intel from './lib/intel.js';

const CATS = ['adult', 'gore', 'gambling', 'iplogger'];
const CACHE_TTL = 30 * 60e3;
const scans = new Map(); // tabId -> AbortController
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEV = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const RISKY_FILE = /\.(exe|scr|msi|msix|appx|appxbundle|bat|cmd|com|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|jar|apk|dmg|pkg|iso|img|vhdx?|dll|sys|reg|cpl|chm|scf|inf|xll|xlam|docm|xlsm|pptm|application|appref-ms|gadget)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|cab)$/i;
const RISKY_WALLET = /^(eth_sendTransaction|eth_sign|personal_sign|eth_signTypedData(_v[34])?|wallet_addEthereumChain|wallet_switchEthereumChain|solana_signTransaction|signTransaction|signAllTransactions)$/;

// ---------- small storage helpers ----------
const sget = async (k, d) => (await chrome.storage.session.get(k))[k] ?? d;
const sset = (k, v) => chrome.storage.session.set({ [k]: v });
const cacheKey = (url) => String(url || '').split('#')[0];

function eligible(url, s) {
  if (!s.enabled) return false;
  let u; try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  return !isPrivateHost(h) && (!inList(h, s.trusted) || inList(h, NEVER_TRUST));
}

async function intelSafe(url, s) {
  if (!s.threatFeeds && !s.domainAge) return null;
  try {
    const r = await intel.intelLookup(url);
    if (!s.threatFeeds) r.feed = null;
    if (!s.domainAge) r.ageDays = null;
    return r;
  } catch { return null; }
}

// ---------- registration: content scripts, rulesets and dynamic rules follow the settings ----------
const NON_NAV = ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
const IP_HOSTS = ['ipify.org', 'ipinfo.io', 'ip-api.com', 'ipapi.co', 'ipwho.is', 'ipwhois.app', 'ifconfig.me', 'icanhazip.com', 'checkip.amazonaws.com', 'api.myip.com', 'geolocation-db.com', 'freegeoip.app', 'extreme-ip-lookup.com', 'ipdata.co', 'api.ip.sb', 'ipgeolocation.io', 'ipregistry.co', 'wtfismyip.com', 'myexternalip.com', 'ident.me', 'ipecho.net', 'seeip.org', 'api.bigdatacloud.net', 'iplogger.org', 'iplogger.com', 'grabify.link'];
const CHAT_HOSTS = ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*', '*://*.tiktok.com/*', '*://*.x.com/*', '*://*.twitter.com/*', '*://*.discord.com/*'];
const addParam = (key, value) => ({ type: 'redirect', redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key, value }] } } } });

function dynamicRules(s) {
  const rules = [];
  if (!s.enabled) return rules;
  const trusted = [...new Set(s.trusted.map(normDomain).filter(Boolean))];
  if (s.sealed) {
    // Every top-level GET to a site that isn't allowed goes to the sealed preflight first (link clicks,
    // typed URLs, pop-ups and every redirect hop). Session allow rules let a cleared tab through.
    const sub = { regexSubstitution: chrome.runtime.getURL('preflight.html') + '#\\0' };
    rules.push({ id: 1, priority: 1, action: { type: 'redirect', redirect: sub },
      condition: { regexFilter: '^https?://.+', resourceTypes: ['main_frame'], requestMethods: ['get'], excludedRequestDomains: [...trusted, 'localhost', '127.0.0.1'] } });
    const ut = NEVER_TRUST.filter((h) => inList(h, trusted));
    if (ut.length) rules.push({ id: 2, priority: 1, action: { type: 'redirect', redirect: sub }, condition: { regexFilter: '^https?://.+', requestDomains: ut, resourceTypes: ['main_frame'], requestMethods: ['get'] } });
  }
  if (s.blockIpLookups) {
    const c = { excludedInitiatorDomains: trusted.length ? trusted : undefined, resourceTypes: NON_NAV };
    rules.push({ id: 10, priority: 30, action: { type: 'block' }, condition: { requestDomains: IP_HOSTS, ...c } });
    rules.push({ id: 11, priority: 30, action: { type: 'block' }, condition: { regexFilter: '^https?://([a-z]+\\.)?discord(app)?\\.com/api(/v[0-9]+)?/webhooks/', ...c } });
    rules.push({ id: 12, priority: 30, action: { type: 'block' }, condition: { regexFilter: '^https?://api\\.telegram\\.org/bot', ...c } });
  }
  if (s.safeSearch) {
    const nav = ['main_frame', 'sub_frame'];
    rules.push({ id: 30, priority: 5, action: addParam('safe', 'active'), condition: { regexFilter: '^https?://(www\\.)?google\\.[a-z.]{2,7}(:[0-9]+)?/(search|images|webhp)', resourceTypes: nav } });
    rules.push({ id: 31, priority: 5, action: addParam('adlt', 'strict'), condition: { regexFilter: '^https?://(www\\.|cn\\.)?bing\\.com(:[0-9]+)?/(search|images|videos|news)', resourceTypes: nav } });
    rules.push({ id: 32, priority: 5, action: addParam('kp', '1'), condition: { regexFilter: '^https?://(html\\.|lite\\.)?duckduckgo\\.com/', resourceTypes: nav } });
    rules.push({ id: 33, priority: 5, action: addParam('vm', 'r'), condition: { regexFilter: '^https?://([a-z]+\\.)?search\\.yahoo\\.com/', resourceTypes: nav } });
    rules.push({ id: 34, priority: 5, action: addParam('safesearch', 'strict'), condition: { regexFilter: '^https?://search\\.brave\\.com/(search|images|videos|news)', resourceTypes: nav } });
  }
  if (s.ytRestrict === 'moderate' || s.ytRestrict === 'strict') {
    rules.push({ id: 40, priority: 5, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'YouTube-Restrict', operation: 'set', value: s.ytRestrict === 'strict' ? 'Strict' : 'Moderate' }] },
      condition: { requestDomains: ['youtube.com', 'youtubei.googleapis.com', 'youtube.googleapis.com', 'youtube-nocookie.com'], resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'] } });
  }
  return rules;
}

let syncing = Promise.resolve();
function syncRegistration() { syncing = syncing.then(doSync, doSync); return syncing; }
async function doSync() {
  const s = await getSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((x) => x.id) });
  const on = s.enabled;
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: CATS.filter((c) => on && s.cats[c]),
    disableRulesetIds: CATS.filter((c) => !(on && s.cats[c])),
  });
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules: dynamicRules(s) });
  chrome.action.setBadgeText({ text: on ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#5d6778' });
  if (!on) return;
  const excludeMatches = ['*://localhost/*', '*://127.0.0.1/*',
    ...s.trusted.map(normDomain).filter(Boolean).map((d) => `*://*.${d}/*`)];
  const base = { matches: ['http://*/*', 'https://*/*'], excludeMatches, runAt: 'document_start', allFrames: false };
  // User-content hosts under a trusted domain still get the shield (separate entry, no excludes).
  const ut = NEVER_TRUST.filter((h) => inList(h, s.trusted)).map((h) => `*://${h}/*`);
  const extra = ut.length ? { matches: ut, runAt: 'document_start', allFrames: false } : null;
  const scripts = [
    // guard (page world) is registered first so it is listening when the shield says hello.
    { ...base, id: 'cs-guard', js: ['guard.js'], world: 'MAIN' },
    { ...base, id: 'cs-shield', js: ['collect.js', 'shield.js'] },
    { ...base, id: 'cs-frame', js: ['collect.js', 'frame.js'], allFrames: true, runAt: 'document_idle' },
  ];
  if (extra) scripts.push({ ...extra, id: 'cs-guard-ut', js: ['guard.js'], world: 'MAIN' }, { ...extra, id: 'cs-shield-ut', js: ['collect.js', 'shield.js'] });
  if (s.chatGuard) scripts.push({ id: 'cs-chat', js: ['chatguard.js'], matches: CHAT_HOSTS, runAt: 'document_start', allFrames: true });
  await chrome.scripting.registerContentScripts(scripts);
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cs-check', title: 'Check this link with ClickSafe (without opening it)', contexts: ['link'] });
  });
}

chrome.runtime.onInstalled.addListener((d) => {
  syncRegistration();
  setupMenus();
  chrome.alarms.create('feeds', { periodInMinutes: 360, delayInMinutes: 1 });
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options.html#welcome') });
});
chrome.runtime.onStartup.addListener(() => { syncRegistration(); setupMenus(); });
chrome.alarms.onAlarm.addListener(async (a) => { if (a.name === 'feeds' && (await getSettings()).threatFeeds) intel.refreshFeeds().catch(() => {}); });
let syncTimer = 0;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.settings) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      await syncRegistration();
      for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, { t: 'chatguard:refresh' }).catch(() => {});
    }, 150);
  }
});

// ---------- the media lab (offscreen document: on-device model, frames, contact sheets) ----------
let labCreating = null;
async function ensureLab() {
  if (!chrome.offscreen) return false;
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length) return true;
    labCreating ||= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_SCRAPING'], justification: 'Runs the on-device image safety model and samples video frames.' }).finally(() => { labCreating = null; });
    await labCreating;
    return true;
  } catch (e) { return /single offscreen|already/i.test(String(e?.message || e)); }
}
async function lab(msg, ms = 15000) {
  if (!(await ensureLab())) return { ok: false, error: 'lab unavailable' };
  try {
    return await Promise.race([chrome.runtime.sendMessage({ to: 'lab', ...msg }), sleep(ms).then(() => ({ ok: false, error: 'lab timed out' }))]) || { ok: false, error: 'no answer' };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

// ---------- audio: mute while a page is hidden ----------
async function mute(tabId) {
  if (tabId == null || tabId < 0) return;
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.mutedInfo?.muted) return;
    await chrome.tabs.update(tabId, { muted: true });
    const m = await sget('muted', []);
    if (!m.includes(tabId)) await sset('muted', [...m, tabId]);
  } catch { /* tab gone */ }
}
async function unmute(tabId) {
  if (tabId == null || tabId < 0) return;
  try {
    const m = await sget('muted', []);
    if (!m.includes(tabId)) return;
    await sset('muted', m.filter((x) => x !== tabId));
    const t = await chrome.tabs.get(tabId);
    const mi = t.mutedInfo || {};
    if (mi.muted && mi.reason === 'extension' && mi.extensionId === chrome.runtime.id) await chrome.tabs.update(tabId, { muted: false });
  } catch { /* tab gone */ }
}

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0 || d.documentLifecycle === 'prerender') return;
  if (eligible(d.url, await getSettings())) mute(d.tabId);
});
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0 || d.documentLifecycle === 'prerender') return;
  if (!eligible(d.url, await getSettings())) return unmute(d.tabId);
  const t0 = Date.now();
  // Watchdog: if no shield reported in (download, PDF, bfcache restore...), give the audio back.
  setTimeout(async () => {
    const st = await sget('tab:' + d.tabId, null);
    const hidden = st && st.ts >= t0 - 100 && (st.action === 'scanning' || st.action === 'hold');
    if (!hidden) unmute(d.tabId);
  }, 3500);
});
chrome.webNavigation.onErrorOccurred.addListener((d) => { if (d.frameId === 0) unmute(d.tabId); });
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const s = await getSettings();
  if (!eligible(d.url, s)) return;
  const st = await sget('tab:' + d.tabId, null);
  const strip = (u) => { try { const x = new URL(u); return x.origin + x.pathname + x.search; } catch { return u; } };
  if (st && strip(st.url) === strip(d.url)) return;
  await mute(d.tabId);
  chrome.tabs.sendMessage(d.tabId, { t: 'rescan' }, { frameId: 0 }).catch(() => unmute(d.tabId));
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  scans.get(tabId)?.abort(); scans.delete(tabId);
  chrome.storage.session.remove(['tab:' + tabId, 'pf:' + tabId]);
  const m = await sget('muted', []);
  if (m.includes(tabId)) sset('muted', m.filter((x) => x !== tabId));
  dropTabRules(tabId);
});

// ---------- per-tab "cleared by the sealed preview" allow rules ----------
async function allowTab(tabId, hosts) {
  hosts = [...new Set(hosts.filter(Boolean))];
  if (tabId == null || tabId < 0 || !hosts.length) return;
  const reg = await sget('pfRules', {});
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(rules.map((r) => r.id));
  const stale = Object.entries(reg).filter(([, v]) => Date.now() - v.ts > 45 * 60e3).map(([k]) => Number(k));
  let id = 5000; while (used.has(id)) id++;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: stale,
    addRules: [{ id, priority: 10, action: { type: 'allow' }, condition: { tabIds: [tabId], requestDomains: hosts, resourceTypes: ['main_frame'] } }],
  });
  for (const k of stale) delete reg[k];
  reg[id] = { tabId, ts: Date.now() };
  await sset('pfRules', reg);
}
async function dropTabRules(tabId) {
  const reg = await sget('pfRules', {});
  const ids = Object.entries(reg).filter(([, v]) => v.tabId === tabId).map(([k]) => Number(k));
  if (!ids.length) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});
  for (const k of ids) delete reg[k];
  await sset('pfRules', reg);
}

// ---------- verdict bookkeeping ----------
function blockUrl(url, v) {
  const q = new URLSearchParams({ u: url || '', cat: v.category || 'other', r: v.reason || '', src: v.source || 'local' });
  return chrome.runtime.getURL('blocked.html') + '?' + q;
}
async function setTab(tabId, url, v) {
  if (tabId == null || tabId < 0) return;
  await sset('tab:' + tabId, { url, host: hostOf(url), ...v, ts: Date.now() });
}
async function logActivity(url, v, report) {
  const s = await getSettings();
  if (!s.activityLog) return;
  const { log = [] } = await chrome.storage.local.get('log');
  log.push({ ts: Date.now(), host: hostOf(url), action: v.action, category: v.category, reason: String(v.reason || '').slice(0, 140), source: v.source, report: report || null });
  await chrome.storage.local.set({ log: log.slice(-300) });
}
async function record(tabId, url, v, count = true, report = null) {
  if (v.action === 'reveal' || v.action === 'block') {
    const c = await sget('cache', {});
    c[cacheKey(url)] = { action: v.action, category: v.category, reason: v.reason, source: v.source, ts: Date.now() };
    const ks = Object.keys(c);
    for (const k of ks.slice(0, Math.max(0, ks.length - 400))) delete c[k];
    await sset('cache', c);
  }
  await setTab(tabId, url, report ? { ...v, report } : v);
  if (!count) return;
  const { stats = { scanned: 0, blocked: 0, held: 0 } } = await chrome.storage.local.get('stats');
  stats.scanned++;
  if (v.action === 'block') stats.blocked++;
  if (v.action === 'hold') stats.held++;
  await chrome.storage.local.set({ stats });
  await logActivity(url, v, report);
}
// In lockdown, a page may only be revealed by hand when the check itself failed (no verdict).
async function errorHold(tabId, url) {
  const st = await sget('tab:' + tabId, null);
  return !!st && cacheKey(st.url) === cacheKey(url) && st.action === 'hold' && st.category === 'error';
}
async function isBypassed(url) {
  const b = await sget('bypass', []);
  return b.includes(cacheKey(url)) || b.includes('host:' + hostOf(url));
}
async function addBypass(entry) {
  const b = await sget('bypass', []);
  if (!b.includes(entry)) await sset('bypass', [...b, entry].slice(-300));
}

// ---------- deep scan helpers ----------
async function readCapped(res, cap) {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length;
    if (n >= cap) { reader.cancel().catch(() => {}); break; }
  }
  const out = new Uint8Array(Math.min(n, cap)); let o = 0;
  for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break; }
  return out;
}
async function fetchText(url, signal, cap = 600_000) {
  if (!fetchable(url)) return '';
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (/image|video|audio|font|octet-stream|wasm/i.test(ct)) return '';
    return new TextDecoder().decode(await readCapped(res, cap));
  } catch { return ''; }
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } }));
  return out;
}
const uniq = (a) => [...new Set(a.filter(Boolean))];

// Ask each embedded frame what it shows (images, video frames, scripts, text).
async function collectFrames(tabId, s) {
  let frames = [];
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { return []; }
  frames = (frames || []).filter((f) => f.frameId !== 0 && /^https?:/i.test(f.url)).slice(0, 10);
  const res = await Promise.all(frames.map((f) => Promise.race([
    chrome.tabs.sendMessage(tabId, { t: 'frame:collect', play: s.playMedia, scripts: s.deepScripts }, { frameId: f.frameId }).catch(() => null),
    sleep(7500).then(() => null),
  ])));
  return res.filter((r) => r && typeof r === 'object');
}

function signalsFrom(sig, notes) {
  const out = [];
  const add = (type) => { if (!out.some((o) => o.type === type)) out.push({ type }); };
  if (sig && typeof sig === 'object') {
    if (sig.clipboard?.length) add('clipboardCmd');
    if (sig.kbLock) add('kbLock');
    if (sig.exfil?.length) add('exfil');
    if ((sig.downloads || []).some((n) => RISKY_FILE.test(String(n).trim()))) add('download');
    if (sig.historyFlood) add('historyFlood');
    if (sig.fullscreen) add('fullscreen');
    if ((sig.wallet || []).some((m) => RISKY_WALLET.test(String(m)))) add('walletSign');
    else if ((sig.wallet || []).some((m) => /requestAccounts|requestPermissions/.test(String(m)))) add('walletConnect');
    if (sig.iplookup?.length) add('iplookup');
    if (sig.webrtc) add('webrtc');
    if (sig.wasm && sig.workers >= 2) add('miner');
  }
  for (const n of notes || []) if (SIGNAL_RULES[n]) add(n);
  return out;
}

async function analyseScripts(deep, frames, d, signal) {
  const list = [];
  for (const x of deep.scripts?.inline || []) list.push({ src: String(x.src), text: String(x.text || '') });
  for (const f of frames) for (const x of f.scripts?.inline || []) list.push({ src: `frame ${hostOf(f.url)} · ${x.src}`, text: String(x.text || '') });
  for (const c of deep.signals?.code || []) list.push({ src: `generated at runtime (${String(c.how)})`, text: String(c.text || '') });
  const urls = uniq([...(deep.scripts?.urls || []), ...frames.flatMap((f) => f.scripts?.urls || [])]).filter(fetchable).slice(0, 50);
  let external = 0;
  await pool(urls, 8, async (u) => { const t = await fetchText(u, signal); if (t) { external++; list.push({ src: u, text: t }); } });
  const findings = scanScripts(list, `${d.title || ''} ${(d.headings || []).join(' ')} ${d.text || ''}`);
  const hiddenImages = new Set(), hiddenVideos = new Set(), dataImages = [];
  for (const sc of list) {
    if (hiddenImages.size >= 40 && hiddenVideos.size >= 6) break;
    const m = mediaInCode(sc.text, d.url);
    m.images.forEach((u) => hiddenImages.size < 40 && hiddenImages.add(u));
    m.videos.forEach((u) => hiddenVideos.size < 6 && hiddenVideos.add(u));
    for (const x of m.dataImages) if (dataImages.length < 6) dataImages.push(x);
  }
  return { findings, summary: summarize(findings), count: list.length, external, hiddenImages: [...hiddenImages], hiddenVideos: [...hiddenVideos], dataImages };
}

async function embedMedia(embeds, signal) {
  const images = [], videos = [];
  const json = async (u) => { if (!fetchable(u)) return null; try { const r = await fetch(u, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), credentials: 'omit', referrerPolicy: 'no-referrer' }); return r.ok ? await r.json() : null; } catch { return null; } };
  for (const e of embeds.slice(0, 4)) {
    if (e.kind === 'youtube' && /^[\w-]{11}$/.test(e.id)) for (const k of ['hqdefault', '1', '2', '3']) images.push({ src: `https://i.ytimg.com/vi/${e.id}/${k}.jpg`, how: 'YouTube embed frame' });
    else if (e.kind === 'vimeo' && /^\d+$/.test(e.id)) { const j = await json(`https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F${e.id}`); if (j?.thumbnail_url) images.push({ src: j.thumbnail_url, how: 'Vimeo embed' }); }
    else if (e.kind === 'tiktok' && /^\d+$/.test(e.id)) { const j = await json(`https://www.tiktok.com/oembed?url=https%3A%2F%2Fwww.tiktok.com%2Fvideo%2F${e.id}`); if (j?.thumbnail_url) images.push({ src: j.thumbnail_url, how: 'TikTok embed' }); }
    else if (e.kind === 'streamable' && /^\w+$/.test(e.id)) { const j = await json(`https://api.streamable.com/videos/${e.id}`); if (j?.thumbnail_url) images.push({ src: /^\/\//.test(j.thumbnail_url) ? 'https:' + j.thumbnail_url : j.thumbnail_url, how: 'Streamable embed' }); const mp4 = j?.files?.mp4?.url; if (mp4) videos.push(/^\/\//.test(mp4) ? 'https:' + mp4 : mp4); }
  }
  return { images, videos };
}

// On-device model over every image + frames from every video, then contact sheets for the AI.
async function analyseMedia(d, deep, frames, scripts, s, signal) {
  const out = { max: 0, gore: 0, lab: false, count: 0, hidden: 0, frames: 0, videos: 0, attachments: [], flagged: 0 };
  const items = [];
  const push = (src, how, vis) => {
    src = String(src || '');
    if (!src || items.length >= 90 || items.some((x) => x.src === src)) return;
    if (!/^data:image\//i.test(src) && !fetchable(src)) return;
    if (/^data:/i.test(src) && src.length > 4e6) return;
    items.push({ id: 'i' + items.length, src, how, vis: !!vis });
  };
  for (const x of deep.images || []) push(x.src, x.how, x.vis);
  for (const x of d.images || []) push(x.src, 'img', true);
  for (const f of frames) for (const x of f.images || []) push(x.src, 'inside an embedded frame', x.vis);
  for (const u of scripts?.hiddenImages || []) push(u, 'only referenced in code', false);
  for (const u of scripts?.dataImages || []) push(u, 'only referenced in code', false);
  const emb = await embedMedia([...(deep.embeds || []), ...frames.flatMap((f) => f.embeds || [])], signal);
  for (const x of emb.images) push(x.src, x.how, true);

  const pageVideos = [...(deep.videos || []), ...frames.flatMap((f) => f.videos || [])];
  const sheets = [];
  const vidUrls = [];
  for (const v of pageVideos) {
    out.videos++;
    if (v.sheet) { sheets.push({ url: v.sheet, label: `${v.frames} frames sampled across a video on the page${v.hidden ? ' (hidden video)' : ''}, in time order` }); out.frames += v.frames; }
    else if (v.src) vidUrls.push(v.src);
  }
  vidUrls.push(...(scripts?.hiddenVideos || []), ...emb.videos);

  if (s.localModel && items.length) {
    const r = await lab({ op: 'classify', items: items.map(({ id, src }) => ({ id, src })), frames: 6 }, 25000);
    if (r?.ok && Array.isArray(r.results)) {
      out.lab = true;
      for (const res of r.results) {
        const it = items.find((i) => i.id === res.id);
        if (!it) continue;
        it.err = !res.ok;
        it.nsfw = res.ok ? Number(res.nsfw) || 0 : 0;
        it.gore = res.ok ? Number(res.gore) || 0 : 0;
        if (res.worstFrame) it.worst = res.worstFrame;
        if (res.label === 'tiny') it.tiny = true;
      }
    }
  }
  if (s.playMedia) {
    for (const vu of uniq(vidUrls).filter(fetchable).slice(0, 2)) {
      const r = await lab({ op: 'video', src: vu, points: [0.02, 0.2, 0.4, 0.6, 0.8, 0.97], timeoutMs: 10000 }, 15000);
      if (r?.ok && r.sheet) {
        out.videos++; out.frames += (r.frames || []).length;
        sheets.push({ url: r.sheet, label: `${(r.frames || []).length} frames sampled across a video found on the page, in time order` });
        out.max = Math.max(out.max, Number(r.nsfw) || 0, ...(r.frames || []).map((f) => Number(f.nsfw) || 0));
        out.gore = Math.max(out.gore, Number(r.gore) || 0, ...(r.frames || []).map((f) => Number(f.gore) || 0));
      }
    }
  }
  // Frames the page itself sampled: score them locally too.
  if (s.localModel && sheets.length && out.lab) {
    const r = await lab({ op: 'classify', items: sheets.map((x, i) => ({ id: 'v' + i, src: x.url })) }, 12000);
    if (r?.ok) { out.max = Math.max(out.max, ...r.results.map((x) => Number(x.nsfw) || 0)); out.gore = Math.max(out.gore, ...r.results.map((x) => Number(x.gore) || 0)); }
  }
  const usable = items.filter((i) => !i.err && !i.tiny);
  out.count = usable.length;
  out.hidden = usable.filter((i) => !i.vis).length;
  out.max = Math.max(out.max, ...usable.map((i) => i.nsfw || 0));
  out.gore = Math.max(out.gore, ...usable.map((i) => i.gore || 0));
  out.flagged = usable.filter((i) => (i.nsfw || 0) >= 0.35).length;

  // Contact sheets: riskiest first, then visible, then hidden.
  const ranked = [...usable].sort((a, b) => (Math.max(b.nsfw || 0, b.gore || 0) - Math.max(a.nsfw || 0, a.gore || 0)) || (b.vis - a.vis));
  const att = [];
  for (let k = 0; k < 2 && k * 16 < ranked.length; k++) {
    const part = ranked.slice(k * 16, k * 16 + 16);
    const r = await lab({ op: 'sheet', items: part.map((i) => ({ id: i.id, src: i.worst || i.src })), cell: 256, cols: 4, quality: 0.82 }, 15000);
    if (r?.ok && r.dataUrl) {
      const hid = part.filter((i) => !i.vis).length;
      att.push({ url: r.dataUrl, label: `contact sheet of ${r.placed?.length || part.length} images found on the page${hid ? ` (${hid} hidden or only in code)` : ''}, numbered` });
    }
  }
  out.attachments = [...att, ...sheets].slice(0, 5);
  return out;
}

// Whisper on the opening of the first direct video file, then the safety model on the transcript.
async function audioCheck(deep, frames, s, signal) {
  const src = [...(deep.videos || []), ...frames.flatMap((f) => f.videos || [])].map((v) => v.src).find((u) => u && fetchable(u) && !/\.(m3u8|mpd)(\?|$)/i.test(u));
  if (!src) return null;
  let blob;
  try {
    const res = await fetch(src, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Range: 'bytes=0-3999999' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct && !/video|audio|octet-stream/i.test(ct)) return null;
    blob = new Blob([await readCapped(res, 4_000_000)], { type: ct || 'video/mp4' });
  } catch { return null; }
  const ext = /webm/i.test(blob.type) ? 'webm' : /audio\/mpeg|mp3/i.test(blob.type) ? 'mp3' : 'mp4';
  const t = await transcribe(blob, 'clip.' + ext, signal);
  if (!t.text) return { text: '', error: t.error };
  const g = await guardText(t.text, signal).catch(() => null);
  const flag = g?.safety === 'unsafe' && g.categories?.some((c) => /sexual|violent|suicide|self-harm|jailbreak/i.test(c))
    ? { category: /sexual/i.test(g.categories.join()) ? 'sexual' : 'other', reason: `Video audio flagged by the safety model (${g.categories.join(', ')})` } : null;
  return { text: t.text.slice(0, 300), guard: g, flag };
}

// ---------- the sealed remote check (preflight, "check a link", chat pre-checks) ----------
const inflight = new Map(); // url -> promise
async function pfCacheGet(url) {
  const c = (await sget('pfcache', {}))[cacheKey(url)];
  return c && Date.now() - c.ts < CACHE_TTL ? c : null;
}
async function pfCachePut(url, v) {
  const c = await sget('pfcache', {});
  c[cacheKey(url)] = { ...v, ts: Date.now() };
  const ks = Object.keys(c);
  for (const k of ks.slice(0, Math.max(0, ks.length - 300))) delete c[k];
  await sset('pfcache', c);
}

async function sealedAnalyse(url, s, signal, step = () => {}) {
  const t0 = Date.now();
  const report = { sealed: false };
  const u = checkUrl(url, s);
  if (u.action === 'block') return { action: 'block', category: u.category, reason: u.reason, source: 'local', report };
  step('intel', 'active');
  const it = await intelSafe(url, s);
  if (it?.feed) return { action: 'block', category: 'phishing', reason: `Listed in the ${it.feed.source} threat feed`, source: 'threat feed', report };
  const notes = [...u.notes];
  if (it?.ageDays != null) notes.push(`domain registered ${it.ageDays} days ago`);
  if (it?.shortener) notes.push('link shortener');
  step('intel', 'done', it?.ageDays != null ? `Domain age: ${it.ageDays} days` : 'Link & threat feeds');
  const risky = u.action === 'flag' || (it?.ageDays != null && it.ageDays < 21) || it?.shortener;
  const el = sealedEligible(url);
  if (!el.ok) { step('sealed', 'skip', `Sealed preview skipped: ${el.why}`); return { action: 'go', skipped: el.why, risky, report }; }
  step('sealed', 'active');
  const r = await sealedFetch(url, signal);
  if (!r.ok) { step('sealed', 'skip', `Sealed preview unavailable (${r.error})`); return { action: 'go', skipped: r.error, error: true, risky, report }; }
  report.sealed = true; report.finalUrl = r.finalUrl; report.remoteMs = r.ms;
  step('sealed', 'done', `Opened in a sealed remote browser (${(r.ms / 1000).toFixed(1)} s)`);

  const fu = checkUrl(r.finalUrl, s);
  const fhost = hostOf(r.finalUrl);
  if (fu.action === 'block') return { action: 'block', category: fu.category, reason: `Redirects to ${fhost}: ${fu.reason}`, source: 'local', finalUrl: r.finalUrl, report };
  const fit = fhost && fhost !== hostOf(url) ? await intelSafe(r.finalUrl, s) : null;
  if (fit?.feed) return { action: 'block', category: 'phishing', reason: `Redirects to ${fhost}, listed in the ${fit.feed.source} threat feed`, source: 'threat feed', finalUrl: r.finalUrl, report };
  if (fhost && fhost !== hostOf(url)) notes.push(`redirects to ${fhost}`);
  if (r.challenge) { step('shot', 'skip', 'The site showed a bot check'); return { action: 'go', skipped: 'site showed a bot check to the sealed browser', finalUrl: r.finalUrl, risky, report }; }

  const d = { url: r.finalUrl, host: fhost, title: r.title, description: r.description, headings: r.headings, text: r.text, textLen: r.text.length,
    images: [], imageCount: r.images.length, videos: 0, iframeHosts: [], passwordFields: /\bpassword\b/i.test(r.text) ? 1 : 0, formHosts: [], linkCount: r.links };
  const local = analyzeContent(d, s);
  if (local.action === 'block') return { action: 'block', category: local.category, reason: local.reason, source: 'local', finalUrl: r.finalUrl, report };
  const scripts = r.inlineScripts?.length ? { summary: summarize(scanScripts(r.inlineScripts, `${d.title} ${d.text}`)) } : null;
  if (scripts) report.scripts = r.inlineScripts.length;

  step('shot', 'active');
  const tiles = await shotTiles(r.shotUrl, signal, 3).catch(() => []);
  let media = null;
  if (tiles.length && s.localModel) {
    const c = await lab({ op: 'classify', items: tiles.map((src, i) => ({ id: 't' + i, src })) }, 15000);
    if (c?.ok) media = { max: Math.max(0, ...c.results.map((x) => Number(x.nsfw) || 0)), gore: Math.max(0, ...c.results.map((x) => Number(x.gore) || 0)) };
  }
  report.tiles = tiles.length;
  step('shot', 'done', tiles.length ? `Screenshot checked (${tiles.length} part${tiles.length > 1 ? 's' : ''})` : 'No screenshot');

  let ai = null, ai2 = null, guard = null;
  if (s.aiEnabled) {
    step('ai', 'active');
    const att = tiles.map((t, i) => ({ url: t, label: `screenshot of the page in a sealed remote browser, part ${i + 1} of ${tiles.length}, top to bottom` }));
    [ai, guard] = await Promise.all([
      aiScan(s, d, [...notes, ...local.notes], signal, null, { attachments: att, noPageImages: true }).catch((e) => ({ error: String(e?.message || e) })),
      s.textGuard ? guardText(`${d.title}\n${d.headings.join('\n')}\n${d.text}`, signal).catch(() => null) : null,
    ]);
    const mixed = risky || local.action === 'hold' || (media?.max ?? 0) >= 0.35 || (media?.gore ?? 0) >= 0.35 || guard?.safety === 'unsafe';
    if (s.secondOpinion && ai && !ai.error && ai.verdict === 'safe' && mixed) {
      ai2 = await aiScan(s, d, [...notes, ...local.notes], signal, null, { attachments: att, noPageImages: true, exclude: [ai.model] }).catch(() => null);
    }
    report.models = [ai?.model, ai2?.model, guard?.model].filter(Boolean);
  }
  const v = decide({ u: u.action === 'flag' ? u : fu, local, ai, ai2, intel: it, scripts, media, guard }, s);
  step('ai', 'done', v.action === 'reveal' ? 'Looks safe' : v.action === 'block' ? 'Not stream-safe' : 'Needs a closer look');
  report.ms = Date.now() - t0;
  if (v.category === 'error') return { action: 'go', skipped: v.reason, error: true, risky, finalUrl: r.finalUrl, report };
  return { ...v, action: v.action === 'reveal' ? 'go' : v.action, finalUrl: r.finalUrl, conf: ai?.confidence ?? null, sealed: true, report };
}

async function runSealed(url, s, signal, step) {
  const key = cacheKey(url);
  const cached = await pfCacheGet(url);
  if (cached) return { ...cached, cached: true };
  if (inflight.has(key)) return inflight.get(key);
  const p = sealedAnalyse(url, s, signal, step).then(async (v) => { if (!v.error && !v.skipped) await pfCachePut(url, v); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Port protocol for preflight.html (in the tab being navigated) and the "check a link" window.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'preflight' || port.sender?.id !== chrome.runtime.id || !String(port.sender?.url || '').startsWith(chrome.runtime.getURL('preflight.html'))) { port.disconnect(); return; }
  const tabId = port.sender.tab?.id;
  const ctl = new AbortController();
  let target = '', mode = 'nav', lastHold = null;
  port.onDisconnect.addListener(() => ctl.abort('closed'));
  const post = (m) => { try { port.postMessage(m); } catch { /* closed */ } };
  port.onMessage.addListener(async (m) => {
    if (m?.type === 'start' && !target) {
      mode = m.mode === 'check' ? 'check' : 'nav';
      let url = String(m.url || '');
      if (!/^https?:\/\//i.test(url)) return post({ type: 'result', action: 'invalid' });
      try { url = new URL(url).href; } catch { return post({ type: 'result', action: 'invalid' }); }
      target = url;
      const s = await getSettings();
      const host = hostOf(url);
      if (mode === 'nav' && (!eligible(url, s) || !s.sealed)) { await allowTab(tabId, [host]); return post({ type: 'result', action: 'go' }); }
      if (mode === 'nav' && await isBypassed(url)) { await allowTab(tabId, [host]); return post({ type: 'result', action: 'go' }); }
      const timer = setTimeout(() => ctl.abort('timeout'), 45000);
      const v = await runSealed(url, s, ctl.signal, (id, state, text) => post({ type: 'step', id, state, text })).catch((e) => ({ action: 'go', skipped: String(e?.message || e), error: true }));
      clearTimeout(timer);
      if (ctl.signal.aborted && ctl.signal.reason === 'closed') return;
      const lock = s.lockdown && v.category !== 'error';
      if (v.action === 'block') {
        if (mode === 'nav') { await record(tabId, url, v, true, v.report); post({ type: 'result', action: 'block', blockUrl: blockUrl(url, v) }); }
        else post({ type: 'result', action: 'block', category: v.category, reason: v.reason, finalUrl: v.finalUrl || null });
        return;
      }
      if (v.action === 'hold' || (v.action === 'go' && v.error && v.risky)) {
        lastHold = v.action === 'hold' ? v : { category: 'error', reason: `Sealed preview unavailable (${v.skipped}) and the link looks risky` };
        if (mode === 'nav') await logActivity(url, { action: 'hold', ...lastHold, source: lastHold.source || 'sealed' }, v.report);
        return post({ type: 'result', action: 'hold', category: lastHold.category, reason: lastHold.reason, lock: s.lockdown && lastHold.category !== 'error', finalUrl: v.finalUrl || null });
      }
      if (mode === 'nav') {
        await allowTab(tabId, [host, hostOf(v.finalUrl || '')]);
        await sset('pf:' + tabId, { host, finalHost: hostOf(v.finalUrl || ''), result: v.sealed ? 'done' : 'skipped', action: 'go', conf: v.conf ?? null, report: v.report || null, ts: Date.now() });
      }
      return post({ type: 'result', action: 'go', finalUrl: v.finalUrl || null, skipped: v.skipped || null, reason: v.reason || '' });
    }
    if (m?.type === 'continue' && target && mode === 'nav' && lastHold) {
      // "Load it hidden for a full check": allowed unless lockdown keeps a guideline break out entirely.
      const s = await getSettings();
      if (s.lockdown && lastHold.category !== 'error') return post({ type: 'result', action: 'hold', ...lastHold, lock: true });
      await allowTab(tabId, [hostOf(target)]);
      await sset('pf:' + tabId, { host: hostOf(target), result: 'skipped', action: 'continue', ts: Date.now() });
      post({ type: 'result', action: 'go' });
    }
  });
});

async function pfFor(tabId, url) {
  const pf = await sget('pf:' + tabId, null);
  const h = hostOf(url);
  return pf && Date.now() - pf.ts < 5 * 60e3 && (pf.host === h || pf.finalHost === h) ? pf : null;
}

// ---------- downloads: unchecked sites can't drop programs on your PC ----------
async function guardDownload(item, nameHint) {
  const s = await getSettings();
  if (!s.enabled || !s.blockDownloads) return;
  const src = String(item.finalUrl || item.url || '');
  const srcHost = hostOf(src.replace(/^blob:/i, ''));
  const refHost = hostOf(item.referrer || '');
  const site = refHost || srcHost;
  if (!site || inList(site, s.trusted) || isPrivateHost(site) || /^(chrome-extension|chrome):/.test(src)) return;
  const name = String(nameHint || item.filename || src.split(/[?#]/)[0].split('/').pop() || '').split(/[\\/]/).pop().toLowerCase();
  const it = ARCHIVE.test(name) ? await intelSafe(src, s) : null;
  const risky = RISKY_FILE.test(name) || /x-msdownload|x-msdos-program|x-ms-installer|x-sh\b|x-bat/i.test(item.mime || '')
    || (ARCHIVE.test(name) && (it?.feed || (it?.ageDays != null && it.ageDays < 30)));
  if (!risky) return;
  try { await chrome.downloads.cancel(item.id); } catch { /* finished already */ }
  try { await chrome.downloads.erase({ id: item.id }); } catch { /* ignore */ }
  chrome.notifications.create('dl-' + item.id, { type: 'basic', iconUrl: 'icons/128.png', title: 'ClickSafe stopped a download',
    message: `${name || 'A file'} from ${site} was cancelled. Unchecked sites can't download programs or scripts. Add the site to your allowed list to download from it.`, priority: 1 });
  await logActivity(src, { action: 'block', category: 'malware', reason: `Download cancelled: ${name}`, source: 'downloads' });
}
chrome.downloads.onCreated.addListener((item) => { guardDownload(item); });
chrome.downloads.onChanged.addListener((d) => { if (d.filename?.current) chrome.downloads.search({ id: d.id }).then(([it]) => it && it.state === 'in_progress' && guardDownload(it, d.filename.current)).catch(() => {}); });

// ---------- panic button ----------
async function panic(tabId) {
  const tabs = tabId != null ? [await chrome.tabs.get(tabId).catch(() => null)].filter(Boolean) : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const t of tabs) {
    await mute(t.id);
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['panic.js'] }); } catch { /* browser pages can't be covered */ }
  }
  for (const t of await chrome.tabs.query({ audible: true })) await mute(t.id);
  return { ok: true };
}
chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'panic') panic(); });

function openCheck(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  chrome.windows.create({ url: chrome.runtime.getURL('preflight.html?mode=check#' + url), type: 'popup', width: 500, height: 680 });
}
chrome.contextMenus.onClicked.addListener((info) => { if (info.menuItemId === 'cs-check') openCheck(info.linkUrl); });

// Chat pre-checks: cheap checks for every link, a sealed check for visible chat links (rate-limited).
let deepBudget = { n: 0, t: 0 };
async function precheck(m) {
  const s = await getSettings();
  if (!s.enabled || !s.chatGuard) return { state: 'off' };
  let url = String(m.url || '');
  if (!/^https?:\/\//i.test(url)) return { state: 'unknown' };
  try { const inner = intel.unwrap(url); if (inner) url = inner; } catch { /* ignore */ }
  const host = hostOf(url);
  if (!eligible(url, s)) return { state: 'safe', label: inList(host, s.trusted) ? 'On your allowed list' : 'Not checked', finalUrl: null };
  const c = (await sget('cache', {}))[cacheKey(url)] || await pfCacheGet(url);
  if (c && Date.now() - c.ts < CACHE_TTL) {
    const st = c.action === 'block' ? 'unsafe' : c.action === 'hold' ? 'caution' : 'safe';
    return { state: st, label: st === 'safe' ? 'Checked: looks safe' : c.reason, category: c.category, finalUrl: c.finalUrl || null };
  }
  const u = checkUrl(url, s);
  if (u.action === 'block') return { state: 'unsafe', label: u.reason, category: u.category, finalUrl: null };
  const it = await intelSafe(url, s);
  if (it?.feed) return { state: 'unsafe', label: `Listed in the ${it.feed.source} threat feed`, category: 'phishing', finalUrl: null };
  const key = cacheKey(url);
  if (inflight.has(key)) return { state: 'pending', retryMs: 2500 };
  const now = Date.now();
  if (now - deepBudget.t > 60e3) deepBudget = { n: 0, t: now };
  if (m.deep && s.sealed && sealedEligible(url).ok && deepBudget.n < 6) {
    deepBudget.n++;
    const ctl = new AbortController();
    setTimeout(() => ctl.abort('timeout'), 45000);
    runSealed(url, s, ctl.signal).catch(() => {});
    return { state: 'pending', retryMs: 3000 };
  }
  const young = it?.ageDays != null && it.ageDays < 21;
  if (u.action === 'flag' || young) return { state: 'caution', label: young ? `Domain registered ${it.ageDays} days ago` : u.reason, category: u.category || 'phishing', finalUrl: null };
  return { state: 'unknown', label: 'Will be checked when opened', finalUrl: null };
}

// ---------- message handlers ----------
const H = {
  async hello(m, snd) {
    const tabId = snd.tab?.id;
    m = { ...m, url: pageUrl(m.url, snd) };
    const s = await getSettings();
    if (!eligible(m.url, s)) { await unmute(tabId); return { action: 'allow' }; }
    if (await isBypassed(m.url)) { await unmute(tabId); return { action: 'allow', watch: s.watchMedia && s.aiEnabled }; }
    const c = (await sget('cache', {}))[cacheKey(m.url)];
    if (c && Date.now() - c.ts < CACHE_TTL) {
      await setTab(tabId, m.url, { ...c, cached: true });
      if (c.action === 'reveal') { await unmute(tabId); return { action: 'allow', watch: s.watchMedia && s.aiEnabled }; }
      if (c.action === 'block') return { action: 'block', blockUrl: blockUrl(m.url, c) };
    }
    const u = checkUrl(m.url, s);
    if (u.action === 'block') {
      const v = { action: 'block', category: u.category, reason: u.reason, source: 'local' };
      await record(tabId, m.url, v);
      return { action: 'block', blockUrl: blockUrl(m.url, v) };
    }
    if (snd.documentLifecycle !== 'prerender') await mute(tabId);
    await setTab(tabId, m.url, { action: 'scanning' });
    const pf = await pfFor(tabId, m.url);
    return {
      action: 'scan', ai: s.aiEnabled, holdAfterMs: s.holdAfterMs, lockdown: s.lockdown,
      sealed: s.sealed ? (pf?.result === 'done' ? 'done' : 'skipped') : null,
      warp: Math.max(0, Math.min(30, Number(s.timeWarpMin) || 0)), play: !!s.playMedia, deep: !!(s.deepScripts || s.localModel),
      guard: { clipboardGuard: !!s.clipboardGuard, blockPrompts: !!s.blockPrompts, blockIpLookups: !!s.blockIpLookups },
    };
  },

  async scan(m, snd) {
    const tabId = snd.tab?.id;
    const s = await getSettings();
    const d = { ...(m.data || {}) };
    d.url = pageUrl(d.url, snd);
    d.host = hostOf(d.url);
    const deep = m.deep && typeof m.deep === 'object' ? m.deep : {};
    scans.get(tabId)?.abort();
    const ctl = new AbortController();
    scans.set(tabId, ctl);
    const signal = ctl.signal;
    const timer = setTimeout(() => ctl.abort('timeout'), s.aiTimeoutMs + 15000);
    const progress = (text) => chrome.tabs.sendMessage(tabId, { t: 'progress', text }, { frameId: 0 }).catch(() => {});
    const report = { warped: deep.signals?.warped || 0, videos: 0, frames: 0, images: 0, hiddenImages: 0, scripts: 0, findings: [], signals: [], models: [], frames_: 0 };
    let v;
    try {
      const u = checkUrl(d.url, s);
      const frames = deep.deep ? await collectFrames(tabId, s) : [];
      report.frames_ = frames.length;
      const frameText = frames.map((f) => f.text).filter(Boolean).join(' ').slice(0, 3000);
      const local = analyzeContent({ ...d, text: `${d.text || ''} ${frameText}`.trim() }, s);
      const signals = signalsFrom(deep.signals, deep.notes);
      report.signals = signals.map((x) => x.type);
      const [it, scripts] = await Promise.all([
        intelSafe(d.url, s),
        s.deepScripts && (deep.scripts || deep.signals?.code?.length) ? analyseScripts(deep, frames, d, signal) : null,
      ]);
      if (scripts) { report.scripts = scripts.count; report.findings = scripts.findings.slice(0, 8).map((f) => ({ sev: f.sev, desc: f.desc, src: f.src })); }
      let pre = decide({ u, local, intel: it, scripts, signals }, { ...s, aiEnabled: false, strict: false });
      if (pre.action === 'block') { v = pre; }
      else {
        progress('Checking every image and video frame…');
        const media = deep.deep ? await analyseMedia(d, deep, frames, scripts, s, signal) : { max: 0, attachments: [], lab: false, videos: 0, frames: 0, count: 0 };
        Object.assign(report, { videos: media.videos, frames: media.frames, images: media.count, hiddenImages: media.hidden, localModel: media.lab, nsfwMax: Math.round((media.max || 0) * 100) / 100, goreMax: Math.round((media.gore || 0) * 100) / 100 });
        pre = decide({ u, local, intel: it, scripts, signals, media }, { ...s, aiEnabled: false, strict: false });
        if (pre.action === 'block') v = pre;
        else {
          const pf = await pfFor(tabId, d.url);
          const sealedSafe = pf?.result === 'done' && pf.action === 'go' && (pf.conf ?? 0) >= 0.85;
          const quiet = sealedSafe && u.action === 'ok' && local.action === 'ok' && !signals.length && SEV[scripts?.summary.level || 'none'] <= SEV.low && media.lab && media.max < 0.35 && (media.gore || 0) < 0.35 && !media.frames;
          const guardP = s.aiEnabled && s.textGuard ? guardText(`${d.title || ''}\n${(d.headings || []).join('\n')}\n${d.text || ''}\n${frameText}`, signal).catch(() => null) : null;
          const audioP = s.aiEnabled && s.listenAudio ? audioCheck(deep, frames, s, signal).catch(() => null) : null;
          const analystP = s.aiEnabled && scripts && SEV[scripts.summary.level] >= SEV.medium
            ? analystScan(scripts.findings, { url: d.url, title: d.title, signals: [...report.signals, ...(deep.notes || [])] }, signal).catch(() => null) : null;
          let ai = null, ai2 = null;
          const notes = [...u.notes, ...local.notes];
          if (it?.ageDays != null) notes.push(`domain registered ${it.ageDays} days ago`);
          if (signals.length) notes.push(`behaviour: ${report.signals.join(', ')}`);
          if (scripts?.summary.level && scripts.summary.level !== 'none') notes.push(`script scan: ${scripts.summary.reason}`);
          if (media.lab) notes.push(`on-device model max explicit score ${Math.round(media.max * 100)}% over ${media.count} images`);
          if (s.aiEnabled && !quiet) {
            progress('AI verdict…');
            const onWait = (sec) => chrome.tabs.sendMessage(tabId, { t: 'wait', sec }, { frameId: 0 }).catch(() => {});
            ai = await aiScan(s, d, notes, signal, onWait, { attachments: media.attachments, noPageImages: media.attachments.length > 0 }).catch((e) => ({ error: signal.aborted ? 'timed out' : String(e?.message || e) }));
          }
          const [guard, audio, analyst] = await Promise.all([guardP, audioP, analystP]);
          if (scripts) scripts.analyst = analyst;
          const mixed = u.action === 'flag' || local.action === 'hold' || signals.length || (media.max ?? 0) >= 0.35 || (media.gore ?? 0) >= 0.35 || media.frames > 0 || guard?.safety === 'unsafe' || audio?.flag || (it?.ageDays != null && it.ageDays < 21);
          if (s.secondOpinion && ai && !ai.error && ai.verdict === 'safe' && mixed) {
            progress('Second opinion from another model…');
            ai2 = await aiScan(s, d, notes, signal, null, { attachments: media.attachments, noPageImages: media.attachments.length > 0, exclude: [ai.model] }).catch(() => null);
          }
          report.models = [ai?.model, ai2?.model, guard?.model, analyst?.model].filter(Boolean);
          if (audio?.text) report.audio = true;
          v = decide({ u, local, ai, ai2, intel: it, scripts, signals, media, guard, audio, sealedSafe: quiet }, s);
          if (ai?.images != null) v.images = ai.images;
        }
      }
    } catch (e) {
      v = { action: 'hold', category: 'error', reason: signal.aborted ? 'The check took too long' : `Check failed (${String(e?.message || e).slice(0, 80)})`, source: 'error' };
    } finally { clearTimeout(timer); }
    if (scans.get(tabId) === ctl) scans.delete(tabId);
    if (signal.aborted && signal.reason !== 'timeout') return { action: 'stale' };
    await record(tabId, d.url, v, true, report);
    if (v.action === 'reveal') await unmute(tabId);
    v.lock = s.lockdown && v.category !== 'error';
    v.watch = s.watchMedia && s.aiEnabled;
    return v.action === 'block' ? { ...v, blockUrl: blockUrl(d.url, v) } : v;
  },

  // Behaviour bad enough to block on the spot (also after the page was shown).
  async alert(m, snd) {
    const s = await getSettings();
    const rule = SIGNAL_RULES[String(m.alert || '')];
    if (!rule) return { action: 'none' };
    const t = CAT_TOGGLE[rule.cat];
    if (t && !s.cats[t]) return { action: 'none' };
    const url = String(snd.url || '');
    if (!eligible(url, s)) return { action: 'none' };
    const v = { action: 'block', category: rule.cat, reason: rule.reason, source: 'behaviour' };
    await record(snd.tab?.id, url, v);
    return { ...v, blockUrl: blockUrl(url, v) };
  },

  // Images/videos that appeared after the page was shown (they stay blurred until this answers).
  async media(m, snd) {
    const tabId = snd.tab?.id;
    const s = await getSettings();
    const url = String(snd.url || '');
    if (!s.watchMedia || !s.aiEnabled) return { action: 'reveal' };
    const srcs = (Array.isArray(m.items) ? m.items : []).slice(0, 3).map((x) => String(x?.src || '')).filter((x) => x.length < 4e6);
    if (s.localModel && srcs.length) {
      const r = await lab({ op: 'classify', items: srcs.map((src, i) => ({ id: 'm' + i, src })), frames: 6 }, 10000);
      const max = r?.ok ? Math.max(0, ...r.results.map((x) => Number(x.nsfw) || 0)) : 0;
      const gore = r?.ok ? Math.max(0, ...r.results.map((x) => Number(x.gore) || 0)) : 0;
      if ((s.cats.adult && max >= 0.92) || (s.cats.gore && gore >= 0.92)) {
        const v = max >= 0.92 && s.cats.adult ? { action: 'block', category: 'sexual', reason: 'On-device model found explicit imagery', source: 'local model' } : { action: 'block', category: 'gore', reason: 'On-device model found graphic violence', source: 'local model' };
        await record(tabId, url, v);
        return { ...v, blockUrl: blockUrl(url, v) };
      }
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort('timeout'), s.aiTimeoutMs);
    const r = await aiMediaScan(s, srcs, url, ctl.signal).catch((e) => ({ error: String(e?.message || e) }));
    clearTimeout(timer);
    if (r.unscannable) return { action: 'unscannable', lock: s.lockdown };
    if (r.error) return { action: 'error', error: r.error, lock: s.lockdown };
    const allowed = (cat) => { const t = CAT_TOGGLE[cat]; return !t || s.cats[t]; };
    if (r.verdict === 'unsafe' && allowed(r.category)) {
      const v = { action: 'block', category: r.category, reason: r.reason, source: 'ai', model: r.model };
      await record(tabId, url, v);
      return { ...v, blockUrl: blockUrl(url, v) };
    }
    if (r.verdict === 'caution' && allowed(r.category)) return { action: 'hold', category: r.category, reason: r.reason, lock: s.lockdown };
    return { action: 'reveal' };
  },

  async reveal(m, snd) { // "Show anyway" on the shield
    m = { ...m, url: pageUrl(m.url, snd) };
    const s = await getSettings();
    if (s.lockdown && !(await errorHold(snd.tab?.id, m.url))) return { ok: false, error: 'locked' };
    await addBypass(cacheKey(m.url));
    await setTab(snd.tab?.id, m.url, { action: 'reveal', category: 'none', reason: 'You chose to show it', source: 'you' });
    await unmute(snd.tab?.id);
    return { ok: true };
  },

  async trust(m, snd) {
    // A page can only ever trust itself; extension pages (popup/options) can name a host.
    const d = normDomain(isExtPage(snd) ? m.host : hostOf(snd.url));
    if (!d) return { ok: false };
    const s = await getSettings();
    if (isPageScript(snd) && s.lockdown && !(await errorHold(snd.tab?.id, snd.url))) return { ok: false, error: 'locked' };
    if (!s.trusted.includes(d)) await saveSettings({ trusted: [...s.trusted, d] });
    await syncRegistration();
    if (isPageScript(snd)) await unmute(snd.tab.id);
    return { ok: true, domain: d };
  },

  async untrust(m) {
    const s = await getSettings();
    const d = matchIn(normDomain(m.host) || m.host, s.trusted);
    if (d) await saveSettings({ trusted: s.trusted.filter((x) => x !== d) });
    await syncRegistration();
    return { ok: true, domain: d };
  },

  async closeTab(m, snd) { if (snd.tab?.id != null) chrome.tabs.remove(snd.tab.id); return { ok: true }; },

  // From the blocked page: open the site anyway (also lifts a blocklist rule for this browser session).
  async openAnyway(m) {
    if ((await getSettings()).lockdown) return { ok: false, error: 'locked' };
    if (!/^https?:\/\//i.test(m.url || '')) return { ok: false };
    const h = hostOf(m.url);
    if (!h) return { ok: false };
    await addBypass('host:' + h);
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const id = rules.reduce((a, r) => Math.max(a, r.id), 0) + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{ id, priority: 100, action: { type: 'allow' }, condition: { requestDomains: [h], resourceTypes: ['main_frame', 'sub_frame'] } }],
    });
    return { ok: true };
  },

  async popup(m) {
    const s = await getSettings();
    const tab = await chrome.tabs.get(m.tabId).catch(() => null);
    const url = tab?.url || '';
    const host = hostOf(url);
    const st = await sget('tab:' + m.tabId, null);
    const { stats = { scanned: 0, blocked: 0, held: 0 } } = await chrome.storage.local.get('stats');
    return {
      enabled: s.enabled, ai: s.aiEnabled, models: s.models, provider: s.aiProvider, lockdown: s.lockdown, url, host,
      web: /^https?:/.test(url), trustedBy: matchIn(host, s.trusted), private: isPrivateHost(host),
      state: st && cacheKey(st.url) === cacheKey(url) ? st : null, stats,
      deep: { sealed: s.sealed, warp: s.timeWarpMin, play: s.playMedia, scripts: s.deepScripts, local: s.localModel, safeSearch: s.safeSearch },
    };
  },

  async setEnabled(m) { await saveSettings({ enabled: !!m.on }); await syncRegistration(); return { ok: true }; },

  async rescan(m) {
    const tab = await chrome.tabs.get(m.tabId).catch(() => null);
    if (!tab) return { ok: false };
    const c = await sget('cache', {});
    delete c[cacheKey(tab.url)];
    await sset('cache', c);
    const pc = await sget('pfcache', {});
    delete pc[cacheKey(tab.url)];
    await sset('pfcache', pc);
    const b = await sget('bypass', []);
    await sset('bypass', b.filter((x) => x !== cacheKey(tab.url)));
    await chrome.tabs.reload(m.tabId);
    return { ok: true };
  },

  async test() { return testConnection(await getSettings()); },
  async resetStats() { await chrome.storage.local.set({ stats: { scanned: 0, blocked: 0, held: 0 } }); return { ok: true }; },
  async panic(m) { return panic(Number.isInteger(m.tabId) ? m.tabId : undefined); },
  async unpanic(m, snd) { await unmute(snd.tab?.id); return { ok: true }; },
  async checkLink(m) { openCheck(String(m.url || '')); return { ok: true }; },
  async precheck(m) { return precheck(m); },
  async getLog() { const { log = [] } = await chrome.storage.local.get('log'); return { log: log.slice(-200).reverse() }; },
  async clearLog() { await chrome.storage.local.set({ log: [] }); return { ok: true }; },
  async feeds(m) { try { return m.refresh ? await intel.refreshFeeds(true) : await intel.feedStatus(); } catch (e) { return { ok: false, error: String(e?.message || e) }; } },
};

// Who may send what. Content scripts run inside untrusted pages, so they get the minimum.
const FROM_PAGE = new Set(['hello', 'scan', 'media', 'alert', 'reveal', 'trust', 'closeTab', 'unpanic']);
const FROM_ANY_FRAME = new Set(['precheck']); // chat link badges (also inside YouTube's live-chat iframe)
const FROM_EXT = new Set(['trust', 'untrust', 'closeTab', 'openAnyway', 'popup', 'setEnabled', 'rescan', 'test', 'resetStats', 'panic', 'checkLink', 'getLog', 'clearLog', 'feeds']);
const EXT_ORIGIN = chrome.runtime.getURL('');
function isExtPage(snd) { return snd.id === chrome.runtime.id && String(snd.url || '').startsWith(EXT_ORIGIN); }
function isPageScript(snd) { return snd.id === chrome.runtime.id && snd.frameId === 0 && !!snd.tab && /^https?:/i.test(snd.url || ''); }
function isContentScript(snd) { return snd.id === chrome.runtime.id && !!snd.tab && /^https?:/i.test(snd.url || ''); }
function sameOrigin(a, b) { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } }
function pageUrl(claimed, snd) { return claimed && sameOrigin(claimed, snd.url) ? String(claimed) : String(snd.url || ''); }

chrome.runtime.onMessage.addListener((msg, snd, reply) => {
  if (msg?.to === 'lab') return false; // for the offscreen document
  const h = H[msg?.t];
  if (!h) return false;
  const allowed = isExtPage(snd) ? FROM_EXT.has(msg.t)
    : isPageScript(snd) ? FROM_PAGE.has(msg.t) || FROM_ANY_FRAME.has(msg.t)
      : isContentScript(snd) ? FROM_ANY_FRAME.has(msg.t) : false;
  if (!allowed) { reply({ error: 'not allowed' }); return false; }
  Promise.resolve().then(() => h(msg, snd)).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});
