// Serves site/ with the headers from site/_headers, then checks the page in Chromium:
// CSP violations, console errors, failed requests, horizontal overflow, and screenshots.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SITE = path.resolve(import.meta.dirname, '../../site');
const OUT = process.env.OUT || path.join(os.tmpdir(), 'clicksafe-site');
fs.mkdirSync(OUT, { recursive: true });

// Minimal _headers parser: "/path" lines start a block, indented "Name: value" lines add headers.
const rules = [];
for (const line of fs.readFileSync(path.join(SITE, '_headers'), 'utf8').split(/\r?\n/)) {
  if (!line.trim() || /^\s*!/.test(line)) continue;
  if (!/^\s/.test(line)) rules.push({ pat: line.trim(), h: {} });
  else { const i = line.indexOf(':'); rules.at(-1).h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
}
const match = (pat, p) => pat === p || (pat.endsWith('*') && p.startsWith(pat.slice(0, -1)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.zip': 'application/zip' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(SITE, p);
  const ok = f.startsWith(SITE + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() && !path.basename(f).startsWith('_');
  const file = ok ? f : path.join(SITE, '404.html');
  const h = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
  for (const r of rules) if (match(r.pat, p)) Object.assign(h, r.h);
  res.writeHead(ok ? 200 : 404, h);
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(8788, r));
const BASE = 'http://localhost:8788';

const browser = await chromium.launch({ channel: 'chromium', headless: true });
let failed = false;
for (const [name, vp] of [['desktop', { width: 1366, height: 860 }], ['mobile', { width: 375, height: 812 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/404 \(Not Found\)/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/etc/passwd')) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'} @${e.lineNumber}`));
  });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4500); // let the demo loop run (CSSOM style changes)
  const r = await page.evaluate(() => ({
    csp: window.__csp,
    overflow: document.documentElement.scrollWidth - innerWidth,
    wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 5).map((e) => e.tagName + '.' + e.className),
    fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
    sha: document.querySelector('.sha code')?.textContent.length,
    ext: document.getElementById('extUrl').textContent,
    demoScene: document.querySelector('.scene.on')?.id,
  }));
  await page.click('#copyBtn');
  await page.waitForTimeout(200);
  const copied = await page.textContent('#copyBtn');
  await page.screenshot({ path: path.join(OUT, `${name}-top.png`) });
  await page.screenshot({ path: path.join(OUT, `${name}-full.png`), fullPage: true });
  const nf = await page.goto(BASE + '/nope/../../../etc/passwd');
  await page.screenshot({ path: path.join(OUT, `${name}-404.png`) });
  console.log(`[${name}]`, JSON.stringify({ ...r, copied, notFound: nf.status() }), '\n  problems:', problems.length ? problems : 'none');
  if (r.csp.length || problems.length || r.overflow > 0) failed = true;
  await ctx.close();
}
await browser.close();
server.close();
console.log(failed ? 'SITE CHECK: PROBLEMS FOUND' : 'SITE CHECK: clean', '· screenshots in', OUT);
