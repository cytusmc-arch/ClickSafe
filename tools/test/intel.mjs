// Runs extension/lib/intel.js inside a real Chromium extension service worker and checks it against the
// live feeds / RDAP. Usage: node tools/test/intel.mjs   (needs network; exits 1 on failure)
// The extension is copied to a temp dir; only the COPY's manifest/background are patched.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SRC = path.resolve(import.meta.dirname, '../../extension');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clicksafe-intel-'));
const EXT = path.join(TMP, 'ext');
fs.cpSync(SRC, EXT, { recursive: true, filter: (p) => !/[\\/]_metadata([\\/]|$)/.test(p) });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.background = { service_worker: 'intel-test-sw.js', type: 'module' };
manifest.permissions = ['storage'];
manifest.host_permissions = ['<all_urls>'];
delete manifest.declarative_net_request;
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
// Three independent module instances of intel.js (different URLs): "race" = first run on empty storage,
// "intel" = main, "cold" = a fresh in-memory state over filled storage (= worker wake-up).
fs.writeFileSync(path.join(EXT, 'intel-test-sw.js'), `
import * as intel from './lib/intel.js';
import * as cold from './lib/intel.js?instance=cold';
import * as race from './lib/intel.js?instance=race';
const realFetch = globalThis.fetch.bind(globalThis);
const fetchLog = [], blockHosts = [];
globalThis.fetch = (input, init) => {
  const u = String((input && input.url) || input);
  fetchLog.push(u);
  if (blockHosts.includes(new URL(u).hostname)) return Promise.reject(new TypeError('Failed to fetch (blocked by test)'));
  return realFetch(input, init);
};
Object.assign(globalThis, { intel, cold, race, fetchLog, realFetch, blockHosts });
`);

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${extra ? '  ' + extra : ''}`);
};
const j = (x) => JSON.stringify(x);

const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  let sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/intel-test-sw.js'));
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/intel-test-sw.js'), timeout: 20000 });
  for (let i = 0; i < 40 && !(await sw.evaluate(() => !!globalThis.intel && !!chrome?.storage?.local).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 150));
  console.log('Chromium', ctx.browser()?.version() ?? '', '| extension SW', sw.url());

  // 1. First run on empty storage: concurrent lookups share ONE download per source.
  console.log('\n[1] first run: 3 concurrent lookups + 2 refreshFeeds() on empty storage');
  const r1 = await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    fetchLog.length = 0;
    const t0 = performance.now();
    const looks = await Promise.all([
      race.intelLookup('https://example.com/'), race.intelLookup('http://192.0.2.10/x'),
      race.intelLookup('https://someproject.pages.dev/'), race.refreshFeeds(), race.refreshFeeds(),
    ]);
    const ms = performance.now() - t0;
    await race.refreshFeeds(); // sources are fresh now: must not download again
    const feeds = fetchLog.filter((u) => !/rdap|data\.iana\.org|verisign|nominet/.test(u));
    return { ms, feeds, status: await race.feedStatus(), example: looks[0] };
  });
  for (const s of r1.status.sources) console.log(`      ${s.name.padEnd(16)} ${String(s.count).padStart(6)} entries (${s.hosts} hosts, ${s.urls} urls) updated ${s.updated} in ${s.ms} ms via ${s.via} from ${s.from}${s.error ? ' ERROR ' + s.error : ''}`);
  console.log(`      wall time for the concurrent batch: ${r1.ms.toFixed(0)} ms`);
  check(r1.feeds.length === 3 && new Set(r1.feeds).size === 3, 'exactly one download per source despite 5 concurrent callers', j(r1.feeds));
  check(r1.status.ok && r1.status.sources.every((s) => s.count > 1000), 'all sources loaded');
  check(r1.example.feed === null && r1.example.ageDays > 10000, 'example.com: no feed hit, old domain', `ageDays=${r1.example.ageDays}`);

  // 2. Forced refresh while lookups run (conditional requests / delta -> cheap), still one request per source.
  console.log('\n[2] refreshFeeds(true) with concurrent lookups + a second refreshFeeds(true)');
  const r2 = await sw.evaluate(async () => {
    fetchLog.length = 0;
    const t0 = performance.now();
    const [res] = await Promise.all([intel.refreshFeeds(true), intel.intelLookup('https://github.com/'), intel.intelLookup('https://google.com/'), intel.refreshFeeds(true)]);
    return { ms: performance.now() - t0, res, feeds: fetchLog.filter((u) => !/rdap|data\.iana\.org|verisign/.test(u)) };
  });
  for (const s of r2.res.sources) console.log(`      ${s.name.padEnd(16)} ${String(s.count).padStart(6)} via ${s.via} in ${s.ms} ms${s.error ? ' ERROR ' + s.error : ''}`);
  console.log(`      total ${r2.ms.toFixed(0)} ms; requests: ${r2.feeds.map((u) => u.replace(/^https:\/\//, '')).join(', ')}`);
  check(r2.res.ok && r2.feeds.length === 3, 'forced refresh ok, one request per source', j(r2.feeds.length));

  // 3. Worker wake-up: a fresh module instance loads the Sets from chrome.storage.
  console.log('\n[3] cold load from storage (fresh module instance)');
  const r3 = await sw.evaluate(async () => {
    const t0 = performance.now();
    const x = await cold.intelLookup('http://192.0.2.10/');
    const ms = performance.now() - t0;
    const st = await cold.feedStatus();
    const keys = Object.keys(await chrome.storage.local.get(null));
    return { ms, loadMs: st.loadMs, readMs: st.loadReadMs, bytes: await chrome.storage.local.getBytesInUse(null), keys, x };
  });
  console.log(`      first lookup ${r3.ms.toFixed(1)} ms (chrome.storage read ${r3.readMs} ms + Set build ${(r3.loadMs - r3.readMs).toFixed(1)} ms); chrome.storage.local in use: ${(r3.bytes / 1048576).toFixed(2)} MB`);
  console.log(`      keys: ${r3.keys.join(', ')}`);
  check(r3.keys.every((k) => k.startsWith('intel:')), 'all storage keys use the intel: prefix');
  check(r3.bytes < 8 * 1048576, 'fits chrome.storage.local default 10 MB quota');

  // 4. Entries sampled from the downloaded feeds must hit; lookalikes on shared hosts must not.
  console.log('\n[4] lookups for entries sampled from the feeds');
  const r4 = await sw.evaluate(async () => {
    const got = await chrome.storage.local.get(['intel:feed:phishing-filter', 'intel:feed:sinking-yachts', 'intel:feed:urlhaus-filter']);
    const pick = (arr, n, f = () => true) => { const a = arr.filter(f); const out = []; for (let i = 0; i < n && a.length; i++) out.push(a[Math.floor((i + 0.5) * a.length / n)]); return out; };
    const cases = [];
    for (const [k, v] of Object.entries(got)) {
      const name = k.slice('intel:feed:'.length);
      for (const h of pick(v.h.split('\n'), 3, (x) => !/^[\d[]/.test(x))) {
        cases.push({ name, url: `http://${h}/`, expect: 'host' });
        cases.push({ name, url: `https://login.${h}/x?y=1`, expect: 'host' });
      }
      if (v.u) for (const e of pick(v.u.split('\n'), 4, (x) => /^(docs\.google\.com|sites\.google\.com|qrco\.de|bit\.ly|new\.express\.adobe\.com|dropbox\.com)\//.test(x))) {
        cases.push({ name, url: `https://${e}`, expect: 'url' });
        cases.push({ name, url: `https://${e}${e.includes('?') ? '&' : '?'}utm_source=x`, expect: 'url' });
      }
    }
    cases.push({ url: 'https://docs.google.com/forms/d/e/clicksafe-not-listed/viewform', expect: null });
    cases.push({ url: 'https://sites.google.com/view/clicksafe-not-listed', expect: null });
    cases.push({ url: 'https://bit.ly/clicksafeNotListed', expect: null });
    cases.push({ url: 'https://clicksafe-not-listed.pages.dev/', expect: null });
    cases.push({ url: 'https://clicksafe-not-listed.weebly.com/', expect: null });
    const res = await Promise.all(cases.map((c) => intel.intelLookup(c.url)));
    return cases.map((c, i) => ({ ...c, r: res[i] }));
  });
  for (const c of r4) {
    const f = c.r.feed;
    const ok = c.expect === null ? f === null : !!f && f.match === c.expect;
    check(ok, `${c.url.slice(0, 90)}`, f ? `-> ${f.source}/${f.list} ${f.match}` + (c.r.ageDays !== null ? ` age ${c.r.ageDays}d` : '') : '-> no hit');
  }

  // 5. Well-known domains: no hit, old.
  console.log('\n[5] well-known domains');
  const r5 = await sw.evaluate(async () => Promise.all(['https://google.com/', 'https://github.com/settings', 'https://www.example.com/'].map((u) => intel.intelLookup(u))));
  for (const x of r5) check(x.feed === null && x.ageDays > 3650, `${x.registrable}: no hit, ${x.ageDays} days old (created ${x.created?.slice(0, 10)})`);

  // 6. Brand-new domains: newest SinkingYachts additions (last 3 days).
  console.log('\n[6] newest feed domains (RDAP age)');
  const r6 = await sw.evaluate(async () => {
    const r = await realFetch('https://phish.sinking.yachts/v2/recent/259200', { headers: { 'X-Identity': 'ClickSafe browser extension test' } }).then((x) => x.json());
    const doms = [...new Set(r.filter((c) => c.type === 'add').flatMap((c) => c.domains))].filter((d) => intel.registrableDomain(d) === d && /^[a-z0-9.-]+$/.test(d)).slice(-12);
    const res = await Promise.all(doms.map((d) => intel.intelLookup(`https://${d}/`)));
    return doms.map((d, i) => ({ d, ageDays: res[i].ageDays, created: res[i].created, feed: res[i].feed?.source || null, note: res[i].notes.at(-1) }));
  });
  for (const x of r6) console.log(`      ${x.d.padEnd(34)} ${x.ageDays === null ? '   -' : String(x.ageDays).padStart(4)}d  feed=${x.feed}  ${x.ageDays === null ? x.note : x.created}`);
  const newest = r6.filter((x) => x.ageDays !== null).sort((a, b) => a.ageDays - b.ageDays)[0];
  check(r6.every((x) => x.feed), 'every recent SinkingYachts domain hits the feed');
  if (newest) check(newest.ageDays < 120, `newest dated domain is young: ${newest.d} ${newest.ageDays} days`);
  else console.log('      (no recent domain had an RDAP creation date; nothing to assert)');

  // 7. RDAP caching: concurrent lookups of an unregistered domain = one RDAP request, then negative-cached.
  console.log('\n[7] RDAP dedupe + negative cache');
  const r7 = await sw.evaluate(async () => {
    const d = `clicksafe-test-${Date.now().toString(36)}.com`;
    fetchLog.length = 0;
    const [a] = await Promise.all([intel.intelLookup(`https://${d}/`), intel.intelLookup(`https://www.${d}/a`)]);
    const t0 = performance.now();
    await intel.intelLookup(`https://${d}/b`);
    return { d, a, n: fetchLog.filter((u) => u.includes(d)).length, again: performance.now() - t0 };
  });
  check(r7.n === 1 && r7.a.ageDays === null, `unregistered ${r7.d}: 1 RDAP request for 3 lookups, negative-cached (${r7.again.toFixed(2)} ms)`, r7.a.notes.at(-1));

  // 8. registrableDomain / isShortener / unwrap.
  console.log('\n[8] helpers');
  const r8 = await sw.evaluate(() => {
    const reg = [['foo.bar.co.uk', 'bar.co.uk'], ['x.github.io', 'x.github.io'], ['a.b.pages.dev', 'b.pages.dev'], ['github.io', 'github.io'], ['www.github.io', 'github.io'],
      ['deep.a.b.c.example.com.au', 'example.com.au'], ['shop.example.co.jp', 'example.co.jp'], ['WWW.Example.COM.', 'example.com'], ['my-app.vercel.app', 'my-app.vercel.app'],
      ['x.y.netlify.app', 'y.netlify.app'], ['foo.web.app', 'foo.web.app'], ['api.proj.workers.dev', 'proj.workers.dev'], ['co.uk', ''], ['localhost', ''], ['192.168.1.1', '192.168.1.1'],
      ['xn--80ak6aa92e.com', 'xn--80ak6aa92e.com'], ['a.b.example.com.br', 'example.com.br'], ['sub.example.ac.za', 'example.ac.za']];
    const short = [['bit.ly', true], ['www.bit.ly', true], ['t.co', true], ['tinyurl.com', true], ['qrco.de', true], ['example.com', false], ['co.uk', false], ['google.com', false]];
    const T = 'https://evil.example/p?a=1';
    const E = encodeURIComponent(T);
    const wrap = [
      [`https://www.google.com/url?sa=t&q=${E}`, T], [`https://www.google.co.uk/url?url=${E}`, T], [`https://www.youtube.com/redirect?event=video_description&q=${E}`, T],
      [`https://l.facebook.com/l.php?u=${E}&h=AT1`, T], [`https://l.instagram.com/?u=${E}&e=AT`, T], [`https://href.li/?${T}`, T],
      [`https://steamcommunity.com/linkfilter/?url=${T}`, T], [`https://steamcommunity.com/linkfilter/?u=${E}`, T],
      [`https://www.tiktok.com/link/v2?aid=1988&lang=en&scene=bio_url&target=${E}`, T], [`https://duckduckgo.com/l/?uddg=${E}`, T],
      [`https://www.bing.com/ck/a?!&&p=x&u=a1${btoa(T).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}&ntb=1`, T],
      [`https://out.reddit.com/t3_x?url=${E}&token=y`, T], [`https://evil-example.translate.goog/p?a=1&_x_tr_sl=auto&_x_tr_tl=en`, T],
      ['https://www.google.com/search?q=https://evil.example', null], ['https://example.com/?url=https://evil.example', null],
      ['https://www.google.com/url?q=javascript:alert(1)', null], ['not a url', null],
    ];
    return {
      reg: reg.map(([h, e]) => [h, e, intel.registrableDomain(h)]),
      short: short.map(([h, e]) => [h, e, intel.isShortener(h)]),
      wrap: wrap.map(([u, e]) => [u, e, intel.unwrap(u)]),
    };
  });
  for (const [h, e, got] of r8.reg) check(got === e, `registrableDomain(${h}) = ${j(got)}`, got === e ? '' : `expected ${j(e)}`);
  check(r8.short.every(([, e, g]) => e === g), `isShortener: ${r8.short.map(([h, , g]) => `${h}=${g}`).join(' ')}`);
  for (const [u, e, got] of r8.wrap) check(got === e, `unwrap(${u.slice(0, 64)}) = ${j(got)}`);

  // 9. Wrapped / shortened / free-hosted / garbage inputs through intelLookup.
  console.log('\n[9] intelLookup on wrappers, shorteners, hosting and bad input');
  const r9 = await sw.evaluate(async () => {
    const got = await chrome.storage.local.get(['intel:feed:phishing-filter']);
    const h = got['intel:feed:phishing-filter'].h.split('\n').find((x) => !/^[\d[]/.test(x));
    const u = got['intel:feed:phishing-filter'].u.split('\n').find((x) => x.startsWith('docs.google.com/'));
    const L = (x) => intel.intelLookup(x);
    return {
      h, u,
      g: await L(`https://www.google.com/url?q=${encodeURIComponent(`http://${h}/login`)}`),
      fb: await L(`https://l.facebook.com/l.php?u=${encodeURIComponent(`https://${u}`)}`),
      short: await L('https://bit.ly/3xYzAbc'),
      host: await L('https://clicksafe-demo.pages.dev/'),
      bad: await Promise.all(['not a url', null, 'javascript:alert(1)', 'https://co.uk/', 'ftp://example.com/'].map(L)),
    };
  });
  check(r9.g.feed?.match === 'host' && r9.g.unwrapped === `http://${r9.h}/login`, `google /url wrapper around ${r9.h} -> feed hit + unwrapped`);
  check(r9.fb.feed?.match === 'url', `facebook l.php wrapper around docs.google.com page -> url hit`, r9.fb.feed?.entry?.slice(0, 60));
  check(r9.short.shortener && r9.short.ageDays === null, 'bit.ly link: shortener=true, no age', j(r9.short.notes));
  check(r9.host.freeHosting && r9.host.registrable === 'clicksafe-demo.pages.dev' && r9.host.ageDays === null, 'pages.dev site: freeHosting, own registrable unit, no age');
  check(r9.bad.every((x) => x && x.feed === null && Array.isArray(x.notes) && x.notes.length), `bad input never throws: ${r9.bad.map((x) => x.notes[0]).join(' | ')}`);

  // 10. Speed after load: 10k lookups (RDAP answers cached), plus the sync helpers.
  console.log('\n[10] timing');
  const r10 = await sw.evaluate(async () => {
    const got = await chrome.storage.local.get(['intel:feed:phishing-filter', 'intel:feed:sinking-yachts', 'intel:feed:urlhaus-filter']);
    const hosts = Object.values(got).flatMap((v) => v.h.split('\n'));
    const pool = ['https://google.com/search?q=x', 'https://github.com/a/b/issues/', 'https://www.example.com/x/', 'http://192.0.2.10/p/', 'https://clicksafe-demo.pages.dev/', 'https://bit.ly/3xYzAbc',
      `http://${hosts.find((x) => !/^[\d[]/.test(x))}/login`,
      `https://${got['intel:feed:phishing-filter'].u.split('\n').find((x) => x.startsWith('docs.google.com/'))}`];
    for (const u of pool) await intel.intelLookup(u); // warm RDAP cache
    let hits = 0;
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) { const b = pool[i % pool.length]; const r = await intel.intelLookup(b + (b.includes('?') ? '&r=' : '?r=') + i); if (r.feed) hits++; }
    const lookupUs = (performance.now() - t0) / 10; // ms for 10k -> µs per lookup
    const t1 = performance.now();
    let n = 0;
    for (let i = 0; i < 10000; i++) { const h = hosts[(i * 7919) % hosts.length]; if (intel.registrableDomain(h)) n++; if (intel.isShortener(h)) n++; if (intel.unwrap(`https://${h}/`)) n++; }
    const helperUs = (performance.now() - t1) / 10;
    return { lookupUs, helperUs, hits, n };
  });
  console.log(`      intelLookup x10k (feeds + cached RDAP): ${r10.lookupUs.toFixed(1)} µs/lookup (${r10.hits} feed hits)`);
  console.log(`      registrableDomain+isShortener+unwrap x10k feed hosts: ${r10.helperUs.toFixed(1)} µs/host`);
  check(r10.lookupUs < 500 && r10.hits > 2000, 'lookup is fast after first load (< 500 µs) and feed hits are found');

  // 11. Mirror fallback: primary host down -> next mirror.
  console.log('\n[11] mirror fallback (malware-filter.gitlab.io blocked)');
  const r11 = await sw.evaluate(async () => {
    blockHosts.push('malware-filter.gitlab.io');
    fetchLog.length = 0;
    const res = await race.refreshFeeds(true);
    blockHosts.length = 0;
    return { res, log: fetchLog.slice() };
  });
  for (const s of r11.res.sources) console.log(`      ${s.name.padEnd(16)} ${String(s.count).padStart(6)} via ${s.via} from ${s.from}${s.note ? ' (' + s.note + ')' : ''}`);
  const mf = r11.res.sources.filter((s) => s.name !== 'sinking-yachts');
  check(r11.res.ok && mf.every((s) => s.from && !s.from.includes('malware-filter.gitlab.io') && s.count > 1000), 'malware-filter lists fetched from a mirror');
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
