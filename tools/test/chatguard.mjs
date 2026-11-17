// End-to-end test for extension/chatguard.js (chat link badges).
// Loads a COPY of extension/ whose background is replaced by a test background that registers
// chatguard.js on fixture hosts and answers 'precheck' with canned verdicts. Fixture pages mimic
// Twitch chat, YouTube live chat (iframe + /redirect?q= links), Kick chat and a generic message list.
// Fixture hosts end in .test ("www.twitch.tv.test"): chatguard treats them as the platform without the suffix.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIX = path.join(import.meta.dirname, 'fixtures');
const OUT = process.env.OUT || path.join(os.tmpdir(), 'clicksafe-chatguard');
const PORT = Number(process.env.PORT || 8794);
fs.mkdirSync(OUT, { recursive: true });

// ---------- extension copy with a test background ----------
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'clicksafe-chatguard-ext-'));
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
fs.rmSync(path.join(EXT, '_metadata'), { recursive: true, force: true });
fs.writeFileSync(path.join(EXT, 'background.js'), `
// TEST BACKGROUND (temp copy only).
globalThis.calls = [];
const polls = new Map();
let offAnswered = false;
globalThis.ready = (async () => {
  const ex = await chrome.scripting.getRegisteredContentScripts();
  if (ex.length) await chrome.scripting.unregisterContentScripts({ ids: ex.map((x) => x.id) });
  await chrome.scripting.registerContentScripts([{
    id: 'cs-chatguard', js: ['chatguard.js'],
    matches: ['*://*.twitch.tv.test/*', '*://*.youtube.com.test/*', '*://kick.com.test/*', '*://*.generic.test/*'],
    allFrames: true, runAt: 'document_start',
  }]);
  return true;
})();
function verdict(url) {
  const h = new URL(url).hostname;
  if (h === 'evil.test') return { state: 'unsafe', label: 'scam', category: 'scam', finalUrl: null };
  if (h === 'bit.ly') return { state: 'unsafe', label: 'scam', category: 'scam', finalUrl: 'https://evil.test/landing' };
  if (h === 'sketchy.test') return { state: 'caution', label: 'brand-new site', category: 'new' };
  if (h === 'slow.test') { const n = (polls.get(url) || 0) + 1; polls.set(url, n); return n < 3 ? { state: 'pending', retryMs: 300 } : { state: 'safe', label: 'looks safe', finalUrl: url }; }
  if (h === 'tinyurl.com') return { state: 'safe', label: '', finalUrl: 'https://example.org/page' };
  if (h === 'none.test') return undefined;
  if (h === 'off.test') { if (!offAnswered) { offAnswered = true; return { state: 'off' }; } }
  return { state: 'safe', label: 'looks safe', finalUrl: url };
}
chrome.runtime.onMessage.addListener((m, snd, reply) => {
  if (m?.t !== 'precheck') return false;
  calls.push({ url: m.url, deep: m.deep, frameId: snd.frameId, tab: snd.tab?.id, page: snd.url, at: Date.now() });
  const v = verdict(m.url);
  setTimeout(() => reply(v), 60);
  return true;
});
`);

// ---------- fixture server ----------
const route = (host, p) => ({
  'www.twitch.tv.test': 'chat-twitch.html',
  'www.youtube.com.test': p.startsWith('/live_chat') ? 'chat-youtube-livechat.html' : 'chat-youtube.html',
  'kick.com.test': 'chat-kick.html',
  'chat.generic.test': 'chat-generic.html',
})[host];
const server = http.createServer((req, res) => {
  const f = route((req.headers.host || '').split(':')[0], req.url);
  res.writeHead(f ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(f ? fs.readFileSync(path.join(FIX, f)) : 'not found');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const U = (host, p = '/') => `http://${host}:${PORT}${p}`;

const ctx = await chromium.launchPersistentContext(path.join(OUT, 'profile-' + Date.now()), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 760 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP *.test 127.0.0.1'],
});
let sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
if (!sw) sw = await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/background.js') });
await sw.evaluate(() => globalThis.ready);

// ---------- helpers ----------
const results = [];
function ok(name, pass, info = '') { results.push({ name, pass: !!pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v || Date.now() - t0 > ms) return v; await sleep(step); } }
const calls = () => sw.evaluate(() => globalThis.calls);
const callsFor = async (re) => (await calls()).filter((c) => re.test(c.page));
// All badges in a page/frame: aria-label plus what they sit after (link href or text).
const badges = (t) => t.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.localName.startsWith('clicksafe-link-')).map((b) => {
  let p = b.previousSibling;
  while (p && p.nodeType === 1 && p.localName.startsWith('clicksafe-link-')) p = p.previousSibling;
  const r = b.getBoundingClientRect();
  return { label: b.getAttribute('aria-label') || '', href: p && p.nodeType === 1 && p.localName === 'a' ? p.getAttribute('href') : null, text: p && p.nodeType === 3 ? p.data : null, w: r.width, h: r.height };
}));
const settled = (bs) => bs.length && bs.every((b) => !/^(ClickSafe is checking|Waiting to check)/.test(b.label));
const byHref = (bs, href) => bs.filter((b) => b.href === href);
async function axTexts(page, frameUrlPart) { // visible accessible text, including closed shadow roots
  const cdp = await ctx.newCDPSession(page);
  let frameId;
  if (frameUrlPart) {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const walk = (n) => (n.frame.url.includes(frameUrlPart) ? n.frame.id : (n.childFrames || []).map(walk).find(Boolean));
    frameId = walk(frameTree);
  }
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', frameId ? { frameId } : {});
  await cdp.detach();
  return nodes.filter((n) => !n.ignored).map((n) => n.name?.value || '').filter(Boolean);
}
const pages = [];
ctx.on('page', (p) => pages.push(p));
const errors = [];
function watchErrors(p, name) { p.on('console', (m) => { if (m.type() === 'error' && /chatguard|clicksafe/i.test(m.text() + (m.location()?.url || ''))) errors.push(`${name}: ${m.text()}`); }); p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); }

// ======================= Twitch =======================
const t = await ctx.newPage(); watchErrors(t, 'twitch');
let t0 = Date.now();
await t.goto(U('www.twitch.tv.test', '/somechannel'));
let tb = await waitFor(async () => { const b = await badges(t); return b.length >= 9 && settled(b) && b; }, 10000);
console.log(`\n[twitch] ${tb ? tb.length : 0} badges settled in ${Date.now() - t0} ms`);
tb = tb || await badges(t);
const expectT = {
  'https://example.com/cool': /^Checked: looks safe$/,
  'https://evil.test/free-skins': /^Unsafe: scam$/,
  'https://bit.ly/3xYz': /^Unsafe: scam\. Goes to: evil\.test$/,
  'https://sketchy.test/promo': /^Caution: brand-new site$/,
  'https://slow.test/page': /^Checked: looks safe$/,
  'https://tinyurl.com/abc': /^Checked: looks safe\. Goes to: example\.org$/,
  'https://none.test/': /^Not checked/,
  'https://merch.example.net/': /^Checked: looks safe$/,
};
for (const [href, re] of Object.entries(expectT)) { const b = byHref(tb, href); ok(`twitch badge ${href}`, b.length && b.every((x) => re.test(x.label)), b.map((x) => x.label).join(' | ') || 'no badge'); }
ok('twitch duplicate link gets a badge too', byHref(tb, 'https://example.com/cool').length === 2);
const internal = ['https://www.twitch.tv/otherchannel', 'https://clips.twitch.tv/FunnyClip', '/videos/123', '/directory', 'https://www.twitch.tv/turbo', 'https://www.twitch.tv/team/cool', 'https://static-cdn.jtvnw.net/panel.png'];
ok('twitch internal links ignored', internal.every((h) => !byHref(tb, h).length));
ok('twitch nav link ignored', !byHref(tb, 'https://blog.example.com/').length);
ok('chat input text not scanned', !tb.some((b) => /in-the-input-box/.test(b.text || '')));
ok('badge is small', tb.every((b) => b.w <= 16 && b.h <= 16), `${tb[0]?.w}x${tb[0]?.h}`);
let tc = await callsFor(/somechannel/);
ok('no precheck for platform-internal URLs', !tc.some((c) => /twitch\.tv|jtvnw/.test(c.url)));
ok('dedupe: one precheck per URL', tc.filter((c) => c.url === 'https://example.com/cool').length === 1, JSON.stringify(tc.map((c) => [c.url, c.deep])));
ok('chat link is deep', tc.find((c) => c.url === 'https://example.com/cool')?.deep === true);
ok('panel link is not deep', tc.find((c) => c.url === 'https://merch.example.net/')?.deep === false);
ok('pending re-polled until safe', tc.filter((c) => c.url === 'https://slow.test/page').length === 3);

// --- clicks ---
const clicks = () => t.evaluate(() => window.__clicks.slice());
const nPages = pages.length;
await t.click('#m2 a');
await sleep(150);
let ax = await axTexts(t);
ok('unsafe click blocked', !(await clicks()).includes('https://evil.test/free-skins'));
ok('blocked toast shown', ax.some((s) => s.includes('ClickSafe blocked this link: scam')), ax.filter((s) => /ClickSafe/.test(s)).join(' | '));
await t.screenshot({ path: path.join(OUT, 'twitch-blocked-toast.png') });
await t.click('#m2 a', { button: 'middle' });
await t.click('#m3 a', { modifiers: ['Control'] });
await t.focus('#m3 a'); await t.keyboard.press('Enter');
await sleep(200);
ok('middle / ctrl / Enter on unsafe links blocked', !(await clicks()).some((h) => /evil|bit\.ly/.test(h)) && pages.length === nPages, JSON.stringify(await clicks()));
await t.click('#m4 a');
await sleep(120);
ax = await axTexts(t);
ok('caution first click held', !(await clicks()).includes('https://sketchy.test/promo'));
ok('caution toast shown', ax.some((s) => s.includes('Click again to open (it will still be checked)')));
await t.screenshot({ path: path.join(OUT, 'twitch-caution-toast.png') });
await t.click('#m4 a');
ok('caution second click opens', (await clicks()).includes('https://sketchy.test/promo'));
await t.click('#m1 a');
ok('safe click passes through', (await clicks()).includes('https://example.com/cool'));

// --- re-render ---
await t.evaluate(() => window.rerender('m1'));
const rr = await waitFor(async () => { const b = byHref(await badges(t), 'https://example.com/cool'); return b.length === 2 && b.every((x) => /^Checked/.test(x.label)) && b; }, 3000);
ok('badge back after message re-render (cached, no new precheck)', rr && (await callsFor(/somechannel/)).filter((c) => c.url === 'https://example.com/cool').length === 1);
await t.evaluate(() => window.stripForeign('m2'));
const t1 = Date.now();
const back = await waitFor(async () => byHref(await badges(t), 'https://evil.test/free-skins').length === 1, 3000, 20);
ok('badge re-added after the page removed it', back, `${Date.now() - t1} ms`);
await t.evaluate(() => window.rerender('m2'));
await sleep(300);
await t.click('#m2 a');
ok('re-rendered unsafe link still blocked', !(await clicks()).includes('https://evil.test/free-skins'));

// --- tooltip (visual) ---
await t.mouse.move(5, 5);
await sleep(200);
await t.hover('[aria-label^="Unsafe: scam. Goes to"]');
await sleep(250);
ax = await axTexts(t);
ok('tooltip shows where a shortener goes', ax.some((s) => s === 'Goes to: evil.test'));
await t.screenshot({ path: path.join(OUT, 'twitch-tooltip.png') });

// ======================= Burst =======================
const b = await ctx.newPage(); watchErrors(b, 'burst');
await b.goto(U('www.twitch.tv.test', '/burstchannel'));
await waitFor(async () => settled(await badges(b)) && (await badges(b)).length >= 9, 10000);
const before = (await callsFor(/burstchannel/)).length;
const appendMs = await b.evaluate(() => window.burst(500, 30));
const allIn = await waitFor(() => b.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.localName.startsWith('clicksafe-link-') && e.previousSibling?.getAttribute?.('href')?.startsWith('https://site')).length >= 500 && performance.now()), 15000, 25);
const burst = await b.evaluate((end) => { const B = window.__burst; B.running = false; return { badgesMs: Math.round(end - B.t0), maxGap: Math.round(B.maxGap), long: window.__long.slice(B.longBefore) }; }, allIn || 0);
const ping0 = Date.now(); await b.evaluate(() => 1); const pingMs = Date.now() - ping0;
await sleep(1500);
const bc = await callsFor(/burstchannel/);
const bb = await badges(b);
console.log(`\n[burst] 500 messages appended in ${Math.round(appendMs)} ms; all 500 badges in ${burst.badgesMs} ms; max frame gap ${burst.maxGap} ms; long tasks ${JSON.stringify(burst.long)}; eval round-trip after ${pingMs} ms`);
console.log(`        prechecks: ${before} before burst, ${bc.length} total in this tab (limit 20/min); waiting badges: ${bb.filter((x) => /^Waiting/.test(x.label)).length}`);
ok('burst: every link badged', !!allIn);
ok('burst: page stays responsive (no frame gap > 250 ms)', burst.maxGap < 250, `${burst.maxGap} ms`);
ok('burst: rate limited to 20 new prechecks/min', bc.length <= 20, `${bc.length}`);
ok('burst: overflow queued, not dropped silently', bb.some((x) => /^Waiting to check/.test(x.label)));

// ======================= YouTube =======================
const y = await ctx.newPage(); watchErrors(y, 'youtube');
t0 = Date.now();
await y.goto(U('www.youtube.com.test', '/watch?v=abc'));
const yb = await waitFor(async () => { const x = await badges(y); return x.length >= 2 && settled(x) && x; }, 8000);
const desc = (yb || []).find((x) => x.href?.includes('shop.example.com'));
ok('youtube description /redirect?q= decoded and checked', desc && /^Checked/.test(desc.label), desc?.label);
ok('youtube comment link unsafe', (yb || []).some((x) => x.href?.includes('evil.test%2Frobux') && /^Unsafe: scam/.test(x.label)));
ok('youtube internal + masthead links ignored', (yb || []).length === 2, `${(yb || []).length} badges`);
const frame = await waitFor(async () => y.frames().find((f) => f.url().includes('/live_chat')), 5000);
const fb = await waitFor(async () => { const x = await badges(frame); return x.length >= 2 && settled(x) && x; }, 8000);
console.log(`\n[youtube] live chat badges settled ${Date.now() - t0} ms after navigation`);
ok('youtube live chat (iframe) unsafe link', (fb || []).some((x) => x.href?.includes('evil.test%2Fphish') && x.label === 'Unsafe: scam'), (fb || []).map((x) => x.label).join(' | '));
ok('youtube live chat safe link', (fb || []).some((x) => x.href?.includes('example.com%2Fyt') && /^Checked/.test(x.label)));
ok('youtube live chat internal links ignored', (fb || []).length === 2);
const yc = await callsFor(/youtube\.com\.test/);
ok('youtube precheck gets decoded target', yc.some((c) => c.url === 'https://evil.test/phish' && c.deep === true && c.frameId !== 0), JSON.stringify(yc.map((c) => [c.url, c.deep, c.frameId])));
ok('youtube description precheck not deep', yc.find((c) => c.url === 'https://shop.example.com/merch')?.deep === false);
await frame.click('#c1 a');
await sleep(150);
const fax = await axTexts(y, '/live_chat');
ok('youtube live chat unsafe click blocked', !(await frame.evaluate(() => window.__clicks)).length && fax.some((s) => s.includes('ClickSafe blocked this link')));
await y.screenshot({ path: path.join(OUT, 'youtube-livechat.png') });

// ======================= Kick =======================
const k = await ctx.newPage(); watchErrors(k, 'kick');
await k.goto(U('kick.com.test', '/somestreamer'));
let kb = await waitFor(async () => { const x = await badges(k); return x.length >= 3 && settled(x) && x; }, 8000) || [];
ok('kick plain-text URL badged (unsafe)', kb.some((x) => /evil\.test\/kick/.test(x.text || '') && x.label === 'Unsafe: scam'), kb.map((x) => `${x.href || x.text}: ${x.label}`).join(' | '));
ok('kick link badged', kb.some((x) => x.href === 'https://example.com/kick' && /^Checked/.test(x.label)));
ok('kick bare domain in text badged', kb.some((x) => /freestuff\.xyz/.test(x.text || '')));
ok('kick internal / file-name lookalikes ignored', kb.length === 3, `${kb.length} badges`);
await k.evaluate(() => window.say(9, 'late link https://sketchy.test/late'));
const late = await waitFor(async () => (await badges(k)).find((x) => /sketchy\.test\/late/.test(x.text || '') && /^Caution/.test(x.label)), 5000);
ok('kick text added after the row is scanned', !!late);
await k.screenshot({ path: path.join(OUT, 'kick-chat.png') });

// ======================= Generic list =======================
const g = await ctx.newPage(); watchErrors(g, 'generic');
await g.goto(U('chat.generic.test', '/'));
let gb = await waitFor(async () => { const x = await badges(g); return x.length >= 3 && settled(x) && x; }, 8000) || [];
const mask = gb.find((x) => x.href === 'https://phish.example/login');
ok('masked link (text shows another site) is caution', mask && mask.label === 'Caution: the link text shows a different site. Goes to: phish.example', mask?.label);
let gc = await callsFor(/generic\.test/);
ok('off-screen chat link checked shallow first', gc.find((c) => c.url === 'https://example.org/old')?.deep === false);
ok('on-screen chat link checked deep', gc.find((c) => c.url === 'https://example.com/new')?.deep === true);
await g.evaluate(() => { document.getElementById('log').scrollTop = 0; });
const up = await waitFor(async () => (await callsFor(/generic\.test/)).some((c) => c.url === 'https://example.org/old' && c.deep === true), 4000);
ok('scrolled into view -> deep re-check', !!up);
await sleep(300);
// refresh from the background: cache cleared, visible links re-checked, others wait until visible
const nBefore = (await callsFor(/generic\.test/)).length;
await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: '*://chat.generic.test/*' }); await chrome.tabs.sendMessage(tab.id, { t: 'chatguard:refresh' }); });
const re = await waitFor(async () => { const c = (await callsFor(/generic\.test/)).slice(nBefore); return c.some((x) => x.url === 'https://example.org/old') && c; }, 4000);
gb = await badges(g);
ok('refresh re-checks visible links', !!re, re ? re.map((x) => x.url).join(', ') : '');
ok('refresh leaves off-screen links for later', byHref(gb, 'https://example.com/new')[0]?.label.startsWith('Not checked yet'), byHref(gb, 'https://example.com/new')[0]?.label);
await g.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
const back2 = await waitFor(async () => /^Checked/.test(byHref(await badges(g), 'https://example.com/new')[0]?.label || ''), 4000);
ok('off-screen link checked once it scrolls into view', !!back2);
// 'off' from the background: everything disappears until a refresh
await g.evaluate(() => window.add('off link <a href="https://off.test/x">https://off.test/x</a>'));
const gone = await waitFor(async () => (await badges(g)).length === 0, 4000);
ok("'off' verdict removes all badges", !!gone);
await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: '*://chat.generic.test/*' }); await chrome.tabs.sendMessage(tab.id, { t: 'chatguard:refresh' }); });
const again = await waitFor(async () => { const x = await badges(g); return x.length >= 4 && settled(x); }, 6000);
ok('refresh after off brings badges back', !!again);
await g.screenshot({ path: path.join(OUT, 'generic.png') });

ok('no content-script errors', !errors.length, errors.join(' | '));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${OUT}`);
await ctx.close();
server.close();
fs.rmSync(EXT, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
