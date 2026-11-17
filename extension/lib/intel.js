// Keyless threat intelligence for URLs (MV3 service worker safe: no DOM, no window).
//  - Live threat feeds (no key, no signup), stored in chrome.storage.local under "intel:" keys and
//    held in memory as Sets that are rebuilt lazily when the worker wakes.
//  - Domain age from RDAP (IANA bootstrap -> registry, rdap.org as fallback), cached per registrable domain.
//  - Link-shortener detection and unwrapping of obvious redirect wrappers.
import { registrable, isPublicSuffix, HOSTING, isIp, normHost } from './psl.js';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const REFRESH_EVERY = 6 * HOUR;       // feeds older than this are refreshed (unless forced)
const RETRY_FAILED_AFTER = 30 * MIN;  // back-off after a failed download
const FIRST_WAIT_MS = 8000;           // a lookup with no feeds at all waits this long for the first download
const FEED_TIMEOUT_MS = 30000;
const STALE_MIRROR = 3 * DAY;         // a mirror whose list is older than this is only used if nothing fresher works
const RDAP_TTL = 7 * DAY, RDAP_NEG_TTL = HOUR, RDAP_TIMEOUT_MS = 5000, RDAP_MAX_ENTRIES = 2000;
const BOOT_TTL = 7 * DAY;
const APP_ID = 'ClickSafe browser extension (+https://clicksafe.pages.dev)';

const K = { meta: 'intel:meta', feed: (n) => `intel:feed:${n}`, rdap: 'intel:rdap', boot: 'intel:rdapboot' };

// malware-filter (curbengh) mirrors, freshest first. The *.pages.dev mirrors lag by weeks, so they go last.
const MF = (repo, file) => [
  `https://malware-filter.gitlab.io/malware-filter/${file}`,
  `https://curbengh.github.io/malware-filter/${file}`,
  `https://cdn.jsdelivr.net/gh/curbengh/${repo}@gh-pages/${file}`,
  `https://curbengh.github.io/${repo}/${file}`,
  `https://${repo}.pages.dev/${file}`,
];

const SOURCES = [
  {
    name: 'phishing-filter', title: 'malware-filter phishing-filter', list: 'phishing', licence: 'CC BY-SA 4.0',
    home: 'https://gitlab.com/malware-filter/phishing-filter',
    // uBlock-format: plain lines = whole hosts, "||host/path^$all" = single pages on shared platforms.
    urls: MF('phishing-filter', 'phishing-filter.txt'), maxBytes: 12 << 20, minCount: 2000,
  },
  {
    name: 'sinking-yachts', title: 'SinkingYachts phishing API', list: 'scam', licence: 'public API, no key (asks for X-Identity)',
    home: 'https://phish.sinking.yachts/docs',
    // Discord / Steam / crypto scam domains. Full list once, then 7-day deltas (/recent) as the API asks.
    urls: ['https://phish.sinking.yachts/v2/text', 'https://phish.sinking.yachts/v2/all'],
    delta: 'https://phish.sinking.yachts/v2/recent/', deltaMax: 6 * DAY,
    headers: { 'X-Identity': APP_ID }, maxBytes: 12 << 20, minCount: 2000,
  },
  {
    name: 'urlhaus-filter', title: 'malware-filter urlhaus-filter (abuse.ch URLhaus)', list: 'malware', licence: 'CC BY-SA 4.0 / CC0 (URLhaus)',
    home: 'https://gitlab.com/malware-filter/urlhaus-filter',
    urls: MF('urlhaus-filter', 'urlhaus-filter-domains.txt'), maxBytes: 6 << 20, minCount: 500,
  },
];

// Hosts that are shared by many unrelated users/sites. A feed may list single pages on them (URL match),
// but never the whole host. Free-hosting suffixes (psl.js HOSTING) and bare public suffixes are dropped too.
const SHARED = new Set(`
google.com docs.google.com sites.google.com drive.google.com script.google.com forms.gle translate.google.com books.google.com groups.google.com
googleusercontent.com script.googleusercontent.com lh3.googleusercontent.com storage.googleapis.com firebasestorage.googleapis.com googleapis.com
youtube.com youtu.be facebook.com fb.com fb.me instagram.com whatsapp.com wa.me x.com twitter.com tiktok.com twitch.tv kick.com
discord.com discord.gg discordapp.com cdn.discordapp.com media.discordapp.net github.com raw.githubusercontent.com objects.githubusercontent.com
gist.github.com gitlab.com bitbucket.org microsoft.com live.com onedrive.live.com sharepoint.com office.com forms.office.com outlook.com
microsoftonline.com apple.com icloud.com amazon.com amazonaws.com dropbox.com dl.dropboxusercontent.com dropboxusercontent.com box.com
wetransfer.com we.tl mediafire.com mega.nz adobe.com express.adobe.com new.express.adobe.com acrobat.adobe.com canva.com figma.com notion.so
jotform.com form.jotform.com eu.jotform.com app.jotform.com typeform.com hsforms.com share.hsforms.com wix.com linkedin.com pinterest.com
reddit.com yahoo.com bing.com duckduckgo.com wikipedia.org cloudflare.com ipfs.io cloudflare-ipfs.com gateway.pinata.cloud archive.org
web.archive.org linktr.ee beacons.ai zoom.us docs.zoom.us steamcommunity.com steampowered.com paypal.com roblox.com epicgames.com
spotify.com netflix.com telegram.org t.me snapchat.com
`.trim().split(/\s+/));

// Opaque link shorteners / QR redirectors: the destination is hidden until you click.
const SHORTENERS = new Set(`
bit.ly bitly.com j.mp tinyurl.com tiny.cc tiny.one t.co goo.gl is.gd v.gd cutt.ly cutt.us rebrand.ly shorturl.at shorturl.gg shorturl.asia
rb.gy ow.ly buff.ly lnkd.in s.id t.ly x.gd bit.do bl.ink short.io short.gy shorte.st adf.ly ouo.io ouo.press linkvertise.com shrinkme.io
shrinke.me exe.io fc.lc gplinks.co cuty.io qrco.de q-r.to l.ead.me qr-codes.io me-qr.com scanned.page did.li zpr.io 00m.in surl.li u.to
clck.ru vk.cc dub.sh soo.gd shrtco.de trib.al dlvr.it ift.tt mcaf.ee urlz.fr gg.gg kutt.it shorturl.com rotf.lol snip.ly smarturl.it
tinyurl.mobi encurtador.com.br shor.by short.cm cli.re t2m.io han.gl me2.kr vo.la zws.im v.ht 1url.com tr.im po.st su.pr cort.as
rebrandly.com bitly.ws shrtm.nu tny.im n9.cl 2u.pw s.coop chilp.it tiny.pl shorturl.me ulvis.net hyperurl.co lstu.fr
`.trim().split(/\s+/));

// ---------------------------------------------------------------------------------------------
// state
const mem = new Map();          // source name -> { hosts:Set, urls:Set, urlHosts:Set }
let meta = null;                // { v:1, sources:{ [name]: {...} } }
let loading = null, refreshing = null, loadMs = null, loadReadMs = null;

const errMsg = (e) => (e && (e.message || String(e))) || 'error';
const hostname = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// fetch with timeout + byte cap (streamed, so a huge body is cut off early).
async function fetchText(url, { headers = {}, maxBytes = 1 << 20, timeoutMs = FEED_TIMEOUT_MS, etag, lastModified, deadline } = {}) {
  const ctl = new AbortController();
  const ms = deadline ? Math.max(1, deadline - Date.now()) : timeoutMs;
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const h = { ...headers };
    if (etag) h['If-None-Match'] = etag;
    if (lastModified) h['If-Modified-Since'] = lastModified;
    const res = await fetch(url, { signal: ctl.signal, headers: h, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' });
    if (res.status === 304) return { status: 304, ok: true, notModified: true };
    let text = '', n = 0;
    const dec = new TextDecoder();
    const reader = res.body && res.body.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > maxBytes) { ctl.abort(); throw new Error(`response larger than ${(maxBytes / 1048576).toFixed(0)} MB`); }
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
    }
    return { status: res.status, ok: res.ok, text, bytes: n, etag: res.headers.get('etag') || '', lastModified: res.headers.get('last-modified') || '' };
  } catch (e) {
    if (ctl.signal.aborted && !/larger than/.test(errMsg(e))) throw new Error(`timed out after ${(ms / 1000).toFixed(0)} s`);
    throw e;
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------------------------
// feed parsing
function canonHost(h) {
  h = h.toLowerCase().replace(/\.+$/, '');
  if (!h) return '';
  if (/[^\x00-\x7f]/.test(h)) { try { h = new URL('http://' + h).hostname; } catch { return ''; } } // IDN -> punycode
  const port = /^([^:[\]]+):\d{1,5}$/.exec(h); // host:port -> host (URL.hostname never has a port)
  if (port) h = port[1];
  if (h.includes(':') && h[0] !== '[') h = `[${h}]`;
  if (h[0] === '[') return /^\[[0-9a-f:.]+\]$/.test(h) ? h : '';
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(h) ? h : '';
}

const wholeHostAllowed = (h) => !isPublicSuffix(h) && !HOSTING.has(h) && !SHARED.has(h) && !SHARED.has(h.replace(/^(www|m)\./, ''));

// Adds one entry; returns 'host' | 'url' | '' (dropped).
function addEntry(raw, hosts, urls) {
  let s = raw.trim();
  if (!s || s.includes('*') || s.startsWith('@@') || s.includes('##')) return '';
  s = s.replace(/^\|\|/, '').replace(/\$[a-z0-9,=~_-]*$/i, '').replace(/\^+$/, '').replace(/&amp;/g, '&');
  if (/^(0\.0\.0\.0|127\.0\.0\.1)\s+/.test(s)) s = s.split(/\s+/)[1] || '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/?#@]*@/, '');
  const cut = s.search(/[/?#]/);
  const host = canonHost(cut < 0 ? s : s.slice(0, cut));
  if (!host) return '';
  let path = cut < 0 ? '' : s.slice(cut).split('#')[0];
  if (path[0] === '?') path = '/' + path;
  path = path.toLowerCase().replace(/\/+$/, '');
  if (path) { urls.add(host + path); return 'url'; }
  if (!wholeHostAllowed(host)) return '';
  hosts.add(host);
  return 'host';
}

function parseFeed(text) {
  const hosts = new Set(), urls = new Set();
  let updated = null, dropped = 0, lines;
  const t = text.trimStart();
  if (/^\[\s*("|\])/.test(t)) lines = JSON.parse(t).map(String); // JSON array of domains
  else if (/^<(!doctype|html)/i.test(t)) throw new Error('got an HTML page instead of a list');
  else lines = text.split('\n');
  for (const line of lines) {
    const c = line[0];
    if (c === '!' || c === '#' || (c === '[' && /^\[[a-z]/i.test(line))) { // comments, [Adblock Plus] header
      if (!updated) {
        const m = /^[!#]\s*(?:Updated|Last modified|Generated):\s*(\S+)/i.exec(line);
        if (m && !Number.isNaN(Date.parse(m[1]))) updated = new Date(m[1]).toISOString();
      }
      continue;
    }
    if (line.trim() && !addEntry(line, hosts, urls)) dropped++;
  }
  return { hosts, urls, updated, dropped };
}

function index(hosts, urls) {
  const urlHosts = new Set();
  for (const u of urls) urlHosts.add(u.slice(0, u.indexOf('/')));
  return { hosts, urls, urlHosts };
}

function build(f) {
  return index(new Set(f.h ? f.h.split('\n') : []), new Set(f.u ? f.u.split('\n') : []));
}

// ---------------------------------------------------------------------------------------------
// storage <-> memory
function load() {
  if (!loading) {
    loading = (async () => {
      const t0 = performance.now();
      const got = await chrome.storage.local.get([K.meta, ...SOURCES.map((s) => K.feed(s.name))]);
      loadReadMs = Math.round((performance.now() - t0) * 10) / 10;
      meta = got[K.meta] && got[K.meta].v === 1 ? got[K.meta] : { v: 1, sources: {} };
      for (const s of SOURCES) {
        const f = got[K.feed(s.name)];
        if (f && !mem.has(s.name)) mem.set(s.name, build(f));
      }
      loadMs = Math.round((performance.now() - t0) * 10) / 10;
    })().catch((e) => { loading = null; meta = meta || { v: 1, sources: {} }; throw e; });
  }
  return loading;
}

async function commit(src, set, st) {
  const h = [...set.hosts].join('\n'), u = [...set.urls].join('\n');
  mem.set(src.name, set);
  st.hosts = set.hosts.size; st.urls = set.urls.size; st.count = st.hosts + st.urls;
  try {
    await chrome.storage.local.set({ [K.feed(src.name)]: { h, u }, [K.meta]: meta });
  } catch (e) {
    // Usually the 10 MB chrome.storage.local quota. Keep the list in memory, and save meta alone so the
    // back-off survives a worker restart (otherwise every wake-up would download again).
    st.error = `saved in memory only: ${errMsg(e)}`; st.errorAt = Date.now();
    await chrome.storage.local.set({ [K.meta]: meta }).catch(() => {});
  }
}

const srcState = (name) => (meta.sources[name] ||= {});

function needsRefresh(src, now) {
  const st = meta.sources[src.name] || {};
  if (st.errorAt && now - st.errorAt < RETRY_FAILED_AFTER && (!st.fetched || st.errorAt > st.fetched)) return false;
  return !mem.has(src.name) || !st.fetched || now - st.fetched >= REFRESH_EVERY;
}

async function refreshSource(src, force) {
  const now = Date.now();
  const st = srcState(src.name);
  const have = mem.has(src.name);
  if (!force && !needsRefresh(src, now)) return;
  const t0 = Date.now();

  // Delta update (SinkingYachts): only the changes since the last fetch.
  if (src.delta && have && st.full && now - st.full < src.deltaMax && st.fetched && now - st.fetched < src.deltaMax) {
    try {
      const secs = Math.ceil((now - st.fetched) / 1000) + 900;
      const r = await fetchText(src.delta + secs, { headers: src.headers, maxBytes: 4 << 20 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const changes = JSON.parse(r.text);
      if (!Array.isArray(changes)) throw new Error('unexpected delta format');
      const cur = mem.get(src.name);
      const hosts = new Set(cur.hosts), urls = new Set(cur.urls);
      let added = 0, removed = 0;
      for (const ch of changes) {
        for (const d of ch && Array.isArray(ch.domains) ? ch.domains : []) {
          if (ch.type === 'add') { if (addEntry(String(d), hosts, urls)) added++; }
          else if (ch.type === 'delete') {
            const hh = canonHost(String(d).split(/[/?#]/)[0]);
            if (hh && hosts.delete(hh)) removed++;
          }
        }
      }
      Object.assign(st, { fetched: now, updated: new Date(now).toISOString(), error: '', errorAt: 0, ms: Date.now() - t0, via: 'delta', bytes: r.bytes, lastDelta: { added, removed } });
      if (added || removed) await commit(src, index(hosts, urls), st);
      else await chrome.storage.local.set({ [K.meta]: meta }).catch(() => {});
      return;
    } catch (e) {
      st.note = `delta failed (${errMsg(e)}), downloading full list`;
    }
  }

  const errs = [];
  let best = null;
  for (const url of src.urls) {
    try {
      const cond = have && st.url === url ? { etag: st.etag, lastModified: st.lastModified } : {};
      const r = await fetchText(url, { headers: src.headers, maxBytes: src.maxBytes, ...cond });
      if (r.notModified) {
        Object.assign(st, { fetched: now, error: '', errorAt: 0, ms: Date.now() - t0, via: 'not-modified' });
        await chrome.storage.local.set({ [K.meta]: meta }).catch(() => {});
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p = parseFeed(r.text);
      const n = p.hosts.size + p.urls.size;
      if (n < src.minCount) throw new Error(`only ${n} entries, not a valid list`);
      const upd = p.updated ? Date.parse(p.updated) : now;
      const cand = { url, r, p, upd };
      if (!best || upd > best.upd) best = cand;
      if (now - upd <= STALE_MIRROR) break;
      errs.push(`${hostname(url)}: list is ${Math.round((now - upd) / DAY)} days old`);
    } catch (e) {
      errs.push(`${hostname(url)}: ${errMsg(e)}`);
    }
  }
  if (!best) {
    Object.assign(st, { error: errs.join('; ') || 'all mirrors failed', errorAt: now, ms: Date.now() - t0 });
    await chrome.storage.local.set({ [K.meta]: meta }).catch(() => {});
    return;
  }
  if (have && st.updated && best.upd < Date.parse(st.updated)) {
    Object.assign(st, { error: '', note: `mirrors only had an older copy (${errs.join('; ')})`, fetched: now, ms: Date.now() - t0 });
    await chrome.storage.local.set({ [K.meta]: meta }).catch(() => {});
    return;
  }
  Object.assign(st, {
    fetched: now, full: now, updated: new Date(best.upd).toISOString(), url: best.url, etag: best.r.etag, lastModified: best.r.lastModified,
    bytes: best.r.bytes, dropped: best.p.dropped, error: '', errorAt: 0, note: errs.length ? errs.join('; ') : '', ms: Date.now() - t0, via: 'full',
  });
  await commit(src, index(best.p.hosts, best.p.urls), st);
}

async function doRefresh(force) {
  try {
    await load();
  } catch (e) {
    return { ok: false, error: `storage unavailable: ${errMsg(e)}`, sources: statusList() };
  }
  await Promise.all(SOURCES.map((s) => refreshSource(s, force).catch((e) => {
    Object.assign(srcState(s.name), { error: errMsg(e), errorAt: Date.now() });
  })));
  const sources = statusList();
  return { ok: sources.every((s) => !s.error && s.count > 0), sources };
}

function statusList() {
  return SOURCES.map((s) => {
    const st = (meta && meta.sources[s.name]) || {};
    const m = mem.get(s.name);
    return {
      name: s.name, list: s.list, count: m ? m.hosts.size + m.urls.size : 0, hosts: m ? m.hosts.size : 0, urls: m ? m.urls.size : 0,
      updated: st.updated || null, fetched: st.fetched ? new Date(st.fetched).toISOString() : null, error: st.error || null,
      dropped: st.dropped ?? null, note: st.note || null, via: st.via || null, from: st.url || null, ms: st.ms ?? null, licence: s.licence, home: s.home,
    };
  });
}

// Make sure feeds are in memory; start a background refresh when they are due. Concurrency-safe:
// refreshFeeds() is single-flight, so any number of parallel lookups cause at most one download per source.
async function ensureFeeds(notes) {
  try { await load(); } catch (e) { notes.push(`Threat feed storage unavailable (${errMsg(e)})`); return false; }
  const now = Date.now();
  if (!refreshing && SOURCES.some((s) => needsRefresh(s, now))) refreshFeeds(false);
  if (!mem.size && refreshing) {
    let t; // first run: wait a bounded time for the initial download
    await Promise.race([refreshing, new Promise((r) => { t = setTimeout(r, FIRST_WAIT_MS); })]);
    clearTimeout(t);
  }
  if (!mem.size) notes.push('Threat feeds not downloaded yet');
  return mem.size > 0;
}

// uBO "^" separator: anything but a letter, digit, "_", "-", ".", "%" (or the end).
const isSep = (c) => !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '-' || c === '.' || c === '%');

function matchFeeds(u) { // u: URL
  const host = normHost(u.hostname);
  if (!host) return null;
  const reg = registrable(host).domain || host;
  // host and its parents, but never above the registrable domain (so x.pages.dev never matches pages.dev).
  const chain = [host];
  if (!isIp(host)) {
    let h = host;
    while (h !== reg && h.length > reg.length) { h = h.slice(h.indexOf('.') + 1); chain.push(h); }
    if (host === reg) chain.push('www.' + host);
  }
  for (const s of SOURCES) {
    const m = mem.get(s.name);
    if (!m) continue;
    for (const h of chain) if (m.hosts.has(h)) return { source: s.name, match: 'host', list: s.list, entry: h, title: s.title };
  }
  let rest = null;
  for (const s of SOURCES) {
    const m = mem.get(s.name);
    if (!m || !m.urlHosts.size) continue;
    for (const h of chain) {
      if (!m.urlHosts.has(h)) continue;
      rest ??= (u.pathname + u.search).toLowerCase();
      for (let i = 1; i <= rest.length; i++) {
        if (i < rest.length && !isSep(rest[i])) continue;
        let j = i;
        while (j > 1 && rest[j - 1] === '/') j--;
        const key = h + rest.slice(0, j);
        if (j > 1 && m.urls.has(key)) return { source: s.name, match: 'url', list: s.list, entry: key, title: s.title };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// RDAP domain age
let rdapMem = null, rdapLoading = null, rdapDirty = false, rdapWriting = null;
const rdapInflight = new Map();
let boot = null, bootLoading = null, bootFailedAt = 0;

function loadRdap() {
  if (!rdapLoading) {
    rdapLoading = chrome.storage.local.get(K.rdap)
      .then((g) => { rdapMem = new Map(Object.entries(g[K.rdap] || {})); })
      .catch(() => { rdapMem = new Map(); });
  }
  return rdapLoading;
}

function pruneRdap() {
  const now = Date.now();
  for (const [k, e] of rdapMem) if (now - e.t > (e.ok ? RDAP_TTL : RDAP_NEG_TTL)) rdapMem.delete(k);
  if (rdapMem.size > RDAP_MAX_ENTRIES) {
    const old = [...rdapMem].sort((a, b) => a[1].t - b[1].t).slice(0, rdapMem.size - RDAP_MAX_ENTRIES);
    for (const [k] of old) rdapMem.delete(k);
  }
}

function saveRdap() { // coalesced, one write in flight at a time
  rdapDirty = true;
  if (rdapWriting) return;
  rdapWriting = (async () => {
    while (rdapDirty) {
      rdapDirty = false;
      pruneRdap();
      await chrome.storage.local.set({ [K.rdap]: Object.fromEntries(rdapMem) }).catch(() => {});
    }
  })().finally(() => { rdapWriting = null; });
}

// TLD -> RDAP base URL from the IANA bootstrap file ('' = TLD has no RDAP service).
async function rdapBase(tld, deadline) {
  if (!boot) {
    if (!bootLoading && Date.now() - bootFailedAt < 10 * MIN) throw new Error('bootstrap unavailable');
    bootLoading ||= (async () => {
      const g = await chrome.storage.local.get(K.boot).catch(() => ({}));
      const b = g[K.boot];
      if (b && Date.now() - b.t < BOOT_TTL && b.m) return b.m;
      const r = await fetchText('https://data.iana.org/rdap/dns.json', { maxBytes: 2 << 20, deadline });
      if (!r.ok) throw new Error(`bootstrap HTTP ${r.status}`);
      const m = {};
      for (const [tlds, urls] of JSON.parse(r.text).services || []) {
        const url = (urls || []).find((x) => /^https:/.test(x)) || (urls || [])[0];
        if (url) for (const t of tlds) m[t.toLowerCase()] = url.endsWith('/') ? url : url + '/';
      }
      if (Object.keys(m).length < 100) throw new Error('bootstrap looks incomplete');
      chrome.storage.local.set({ [K.boot]: { t: Date.now(), m } }).catch(() => {});
      return m;
    })().then((m) => { boot = m; return m; }, (e) => { bootFailedAt = Date.now(); throw e; }).finally(() => { bootLoading = null; });
    await bootLoading;
  }
  return boot[tld] || '';
}

async function rdapQuery(domain) {
  const deadline = Date.now() + RDAP_TIMEOUT_MS;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  let base = null;
  try { base = await rdapBase(tld, deadline); } catch { base = null; } // bootstrap unavailable -> rdap.org
  if (base === '') return { ok: true, created: null, note: `.${tld} has no public RDAP service` };
  const url = `${base || 'https://rdap.org/'}domain/${domain}`;
  try {
    const r = await fetchText(url, { headers: { Accept: 'application/rdap+json, application/json' }, maxBytes: 1 << 20, deadline });
    if (r.status === 404) return { ok: false, created: null, note: 'Registry has no record of this domain (unregistered, expired or taken down)' };
    if (r.status === 429) return { ok: false, created: null, note: 'RDAP rate-limited' };
    if (!r.ok) return { ok: false, created: null, note: `RDAP HTTP ${r.status}` };
    const j = JSON.parse(r.text);
    const ev = (j.events || []).find((e) => /^registration$/i.test(e.eventAction || ''));
    const d = ev && Date.parse(ev.eventDate);
    if (!d || Number.isNaN(d)) return { ok: true, created: null, note: 'Registry does not publish a creation date' };
    return { ok: true, created: new Date(d).toISOString() };
  } catch (e) {
    return { ok: false, created: null, note: `RDAP lookup failed (${errMsg(e)})` };
  }
}

async function domainAge(domain) {
  await loadRdap();
  const e = rdapMem.get(domain);
  if (e && Date.now() - e.t < (e.ok ? RDAP_TTL : RDAP_NEG_TTL)) return e;
  let p = rdapInflight.get(domain);
  if (!p) {
    p = rdapQuery(domain)
      .then((r) => {
        const ent = { c: r.created || null, t: Date.now(), ok: r.ok ? 1 : 0, n: r.note || '' };
        rdapMem.set(domain, ent);
        saveRdap();
        return ent;
      })
      .finally(() => rdapInflight.delete(domain));
    rdapInflight.set(domain, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// shorteners + redirect wrappers
export function isShortener(host) {
  let h = normHost(host).replace(/^www\./, '');
  while (h) {
    if (SHORTENERS.has(h)) return true;
    const i = h.indexOf('.');
    if (i < 0 || h.indexOf('.', i + 1) < 0) return false; // don't walk up to a bare TLD/eTLD
    h = h.slice(i + 1);
  }
  return false;
}

function asHttp(v) {
  if (!v) return null;
  v = String(v).trim();
  for (let i = 0; i < 2 && /^https?%3a/i.test(v); i++) { try { v = decodeURIComponent(v); } catch { return null; } }
  if (v.startsWith('//')) v = 'https:' + v;
  else if (!/^https?:\/\//i.test(v)) {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(v)) v = 'https://' + v; else return null;
  }
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) && u.hostname ? u.href : null;
  } catch { return null; }
}

const b64url = (s) => { try { s = s.replace(/-/g, '+').replace(/_/g, '/'); return atob(s + '='.repeat((4 - (s.length % 4)) % 4)); } catch { return ''; } };

// [host regexp, path regexp, query params holding the target]
const WRAPPERS = [
  [/^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/, /^\/url$/, ['q', 'url']],
  [/^(www\.|m\.|music\.)?youtube\.com$/, /^\/redirect$/, ['q']],
  [/^(l|lm|m|www|web)\.facebook\.com$/, /^\/l\.php$/, ['u']],
  [/^l\.messenger\.com$/, /^\/l\.php$/, ['u']],
  [/^l\.instagram\.com$/, /^\/?$/, ['u']],
  [/^l\.threads\.(net|com)$/, /^\/?$/, ['u']],
  [/^l\.wl\.co$/, /^\/l\/?$/, ['u']],
  [/^steamcommunity\.com$/, /^\/linkfilter\/?$/, ['u', 'url']],
  [/^out\.reddit\.com$/, /^\//, ['url']],
  [/^(m\.)?vk\.com$/, /^\/away(\.php)?$/, ['to']],
  [/^(www\.|m\.)?ok\.ru$/, /^\/dk$/, ['st.rfn']],
  [/^(www\.|m\.)?tiktok\.com$/, /^\/link\/v2\/?$/, ['target']],
  [/^(www\.)?linkedin\.com$/, /^\/(redir\/redirect|safety\/go)\/?$/, ['url']],
  [/^slack-redir\.net$/, /^\/link$/, ['url']],
  [/\.safelinks\.protection\.outlook\.com$/, /^\//, ['url']],
  [/^(www\.|html\.)?duckduckgo\.com$/, /^\/l\/?$/, ['uddg']],
  [/^translate\.google\.[a-z.]+$/, /^\/translate$/, ['u']],
  [/^exit\.sc$/, /^\//, ['url']],
];
const QUERY_IS_URL = /^(href\.li|anon\.to|nullrefer\.com|(www\.)?dereferer\.me|hiderefer\.com|refhide\.com|blankrefer\.com|(www\.)?anonym\.to)$/;
// Cheap pre-filter: only hosts that can possibly be a wrapper go through the rules below.
const MAYBE_WRAPPER = /(^|\.)(google\.[a-z.]+|youtube\.com|facebook\.com|messenger\.com|instagram\.com|threads\.(net|com)|wl\.co|steamcommunity\.com|reddit\.com|vk\.com|ok\.ru|tiktok\.com|linkedin\.com|slack-redir\.net|outlook\.com|duckduckgo\.com|exit\.sc|href\.li|anon\.to|nullrefer\.com|dereferer\.me|hiderefer\.com|refhide\.com|blankrefer\.com|anonym\.to|bing\.com|yahoo\.com|urldefense\.(com|us)|proofpoint\.com|translate\.goog)$/;

// Returns the inner target when url is an obvious redirect wrapper, else null (one level; call again to peel more).
export function unwrap(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); } catch { return null; }
  return unwrapUrl(u);
}

function unwrapUrl(u) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname, p = u.pathname;
  if (!MAYBE_WRAPPER.test(h)) return null;
  for (const [hr, pr, params] of WRAPPERS) {
    if (!hr.test(h) || !pr.test(p)) continue;
    for (const k of params) { const t = asHttp(u.searchParams.get(k)); if (t) return t; }
    return null;
  }
  if (QUERY_IS_URL.test(h)) return asHttp(decodeQuery(u.search.slice(1)));
  if (/^(www\.)?google\.[a-z.]+$/.test(h)) { const m = /^\/amp\/s\/(.+)$/.exec(p); if (m) return asHttp('https://' + m[1] + u.search); }
  if (/^(www\.|cn\.)?bing\.com$/.test(h) && p === '/ck/a') {
    const v = u.searchParams.get('u') || '';
    return asHttp(v.startsWith('a1') ? b64url(v.slice(2)) : v);
  }
  if (/^r\.search\.yahoo\.com$/.test(h)) { const m = /\/RU=([^/]+)\//.exec(p); if (m) return asHttp(decodeQuery(m[1])); }
  if (h === 'urldefense.com' || h === 'urldefense.us') { const m = /^\/v3\/__(.+?)__;/.exec(p + u.search); if (m) return asHttp(m[1]); }
  if (h === 'urldefense.proofpoint.com' && /^\/v2\/url$/.test(p)) {
    const v = u.searchParams.get('u');
    if (v) return asHttp(decodeQuery(v.replace(/-/g, '%').replace(/_/g, '/')));
  }
  // Google Translate proxy: example-com.translate.goog/path -> example.com/path
  const tg = /^(.+)\.translate\.goog$/.exec(h);
  if (tg && !tg[1].includes('.')) {
    const host = tg[1].replace(/--/g, '\0').replace(/-/g, '.').replace(/\0/g, '-');
    const q = new URLSearchParams(u.search);
    for (const k of [...q.keys()]) if (k.startsWith('_x_tr_')) q.delete(k);
    const qs = q.toString();
    return asHttp(`https://${host}${p}${qs ? '?' + qs : ''}`);
  }
  return null;
}

function decodeQuery(s) { try { return decodeURIComponent(s); } catch { return s; } }

export function registrableDomain(host) {
  try { return registrable(host).domain; } catch { return ''; }
}

// ---------------------------------------------------------------------------------------------
// public API

export async function refreshFeeds(force = false) {
  // Synchronous check-and-set: concurrent callers share one in-flight refresh.
  if (!refreshing) refreshing = doRefresh(!!force).finally(() => { refreshing = null; });
  return refreshing;
}

export async function feedStatus() {
  try { await load(); } catch (e) { return { ok: false, error: `storage unavailable: ${errMsg(e)}`, sources: statusList(), loadMs, loadReadMs, refreshing: !!refreshing }; }
  const sources = statusList();
  return { ok: sources.every((s) => !s.error && s.count > 0), sources, loadMs, loadReadMs, refreshing: !!refreshing };
}

export async function intelLookup(url) {
  const out = { feed: null, ageDays: null, created: null, registrable: '', freeHosting: false, shortener: false, unwrapped: null, notes: [] };
  const notes = out.notes;
  try {
    let u;
    try { u = new URL(String(url)); } catch { notes.push('Not a valid URL'); return out; }
    if (!/^https?:$/.test(u.protocol)) { notes.push(`Not a web address (${u.protocol})`); return out; }

    const chain = [u]; // URL objects: the link, then each unwrapped inner target
    for (let i = 0; i < 5; i++) {
      const next = unwrapUrl(chain[chain.length - 1]);
      if (!next || chain.some((x) => x.href === next)) break;
      chain.push(new URL(next));
    }
    const target = chain[chain.length - 1];
    const thost = normHost(target.hostname);
    if (chain.length > 1) { out.unwrapped = target.href; notes.push(`Redirect wrapper; real destination is ${thost}`); }
    out.shortener = chain.some((x) => isShortener(x.hostname));
    const targetIsShort = isShortener(thost);
    if (out.shortener) notes.push(targetIsShort ? 'Link shortener hides the real destination' : 'Passed through a link shortener');

    const r = registrable(thost);
    out.registrable = r.domain;
    out.freeHosting = !!r.hosting;
    if (r.hosting) notes.push(`Free hosting (${r.suffix}): anyone can publish a site here`);

    if (await ensureFeeds(notes)) {
      for (const x of chain) {
        const hit = matchFeeds(x);
        if (hit) { out.feed = hit; notes.push(`Listed by ${hit.title} as ${hit.list} (${hit.match} match: ${hit.entry})`); break; }
      }
    }

    if (r.ip) notes.push('Link goes to a raw IP address (no domain age)');
    else if (!r.domain) notes.push('No registrable domain');
    else if (r.hosting) { /* RDAP would only date the platform, not this site */ }
    else if (targetIsShort) { /* the shortener's age says nothing about the destination */ }
    else if (/(^|\.)(localhost|local|internal|lan|home\.arpa|test|example|invalid)$/.test(r.domain)) notes.push('Local / reserved name');
    else {
      const a = await domainAge(r.domain);
      if (a.c) {
        out.created = a.c;
        out.ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(a.c)) / DAY));
        notes.push(out.ageDays < 30 ? `Newly registered domain (${out.ageDays} days old)` : `Domain registered ${out.created.slice(0, 10)}`);
      } else if (a.n) notes.push(a.n);
    }
  } catch (e) {
    notes.push(`Lookup error: ${errMsg(e)}`);
  }
  return out;
}
