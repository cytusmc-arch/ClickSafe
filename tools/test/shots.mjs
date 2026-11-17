import { chromium } from 'playwright';
const OUT = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await p.goto('http://127.0.0.1:8790/', { waitUntil: 'networkidle' });
console.log('overflow', await p.evaluate(() => [innerWidth, document.documentElement.scrollWidth]));
await p.screenshot({ path: OUT + '/m-full.png', fullPage: true });
await b.close();
