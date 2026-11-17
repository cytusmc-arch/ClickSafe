// Sealed remote browser. The link is opened by Jina Reader's headless Chrome on its own servers
// (keyless, ~20 requests/min per IP): the site never sees your IP, can't run code on your PC and can't
// start a download. We get back the final URL after redirects, the page text, its image list and a
// full-page screenshot, which the local model and the AI check before the page is allowed to load here.
import { SEALED_BASE } from './settings.js';

const COOL = 'sealedCooldown';

// Links that carry a one-time secret must never be opened by a third party first: it could use up a
// login / password-reset / payment token, or see it. Those go straight to the local (hidden) check.
const SECRET_PARAM = /^(token|access_token|id_token|refresh_token|code|auth|authuser|key|apikey|api_key|sig|signature|x-amz-signature|x-goog-signature|otp|magic|reset|verify|verification|session|sid|ticket|state|nonce|jwt|hash|login_token|invite|password|pwd|email)$/i;
const SECRET_PATH = /\/(auth|oauth2?|login|logout|signin|sign-in|sso|saml|callback|verify|verification|confirm|reset|activate|magic|unsubscribe|invite|checkout|pay|payment|billing|account\/recover)(\/|$)/i;

export function sealedEligible(url) {
  let u; try { u = new URL(url); } catch { return { ok: false, why: 'bad url' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, why: 'not a web link' };
  if (u.username || u.password) return { ok: false, why: 'link contains credentials' };
  for (const k of u.searchParams.keys()) if (SECRET_PARAM.test(k)) return { ok: false, why: 'link carries a one-time token' };
  if (SECRET_PATH.test(u.pathname)) return { ok: false, why: 'login / account link' };
  if (/[A-Za-z0-9_-]{40,}/.test(u.pathname + u.search)) return { ok: false, why: 'link carries a long secret-looking value' };
  return { ok: true };
}

async function cooling() { return ((await chrome.storage.session.get(COOL))[COOL] || 0) > Date.now(); }
async function cool(ms) { await chrome.storage.session.set({ [COOL]: Date.now() + ms }); }

function headings(md) {
  return [...String(md).matchAll(/^#{1,2}\s+(.+)$/gm)].map((m) => m[1].replace(/[*_`[\]]/g, '').trim()).filter(Boolean).slice(0, 8).map((s) => s.slice(0, 120));
}
function mdText(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links -> text
    .replace(/[#>*_`|~-]{1,}/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Returns { ok, finalUrl, title, description, text, headings, images:[url], links, httpStatus, shotUrl, ms } or { ok:false, error, rateLimited }
export async function sealedFetch(url, signal) {
  if (await cooling()) return { ok: false, error: 'sealed browser busy', rateLimited: true };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(SEALED_BASE + url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-Return-Format': 'markdown,pageshot',
        'X-With-Images-Summary': 'all',
        'X-No-Cache': 'true',
        'X-Timeout': '18',
      },
    });
  } catch (e) { return { ok: false, error: signal.aborted ? 'timed out' : 'sealed browser unreachable' }; }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after')) || 30;
    await cool(Math.min(120, ra) * 1000);
    return { ok: false, error: 'sealed browser rate-limited', rateLimited: true };
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') await cool(20000);
  let j;
  try { j = await res.json(); } catch { return { ok: false, error: `sealed browser HTTP ${res.status}` }; }
  const d = j?.data;
  if (!d || typeof d !== 'object') return { ok: false, error: String(j?.readableMessage || j?.message || `sealed browser HTTP ${res.status}`).slice(0, 120) };
  const imgs = d.images && typeof d.images === 'object' ? Object.values(d.images) : [];
  const md = String(d.content || '');
  return {
    ok: true,
    ms: Date.now() - t0,
    finalUrl: String(d.finalUrl || d.url || url),
    title: String(d.title || '').slice(0, 200),
    description: String(d.description || '').slice(0, 300),
    text: mdText(md).slice(0, 6000),
    textLen: md.length,
    headings: headings(md),
    images: imgs.map(String).filter((u) => /^https?:\/\//.test(u)).slice(0, 80),
    links: d.links && typeof d.links === 'object' ? Object.keys(d.links).length : 0,
    httpStatus: Number(d.httpStatus) || 0,
    shotUrl: String(d.pageshotUrl || d.screenshotUrl || ''),
    challenge: /just a moment|checking your browser|attention required|enable javascript and cookies/i.test(`${d.title} ${md.slice(0, 600)}`),
  };
}

// Fetch the remote screenshot (hosted by the sealed browser, not by the site) and cut the full-page
// shot into up to `max` tiles of ~1:1 so the AI sees readable detail.
export async function shotTiles(shotUrl, signal, max = 3) {
  if (!/^https:\/\//.test(shotUrl)) return [];
  const r = await fetch(shotUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) return [];
  const blob = await r.blob();
  if (blob.size > 25e6) return [];
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height, tileH = Math.min(H, Math.round(W * 1.1));
  const out = [];
  for (let y = 0, i = 0; y < H && i < max; y += tileH, i++) {
    const h = Math.min(tileH, H - y);
    if (h < 120 && i > 0) break;
    const sc = Math.min(1, 1024 / Math.max(W, h));
    const c = new OffscreenCanvas(Math.round(W * sc), Math.round(h * sc));
    c.getContext('2d').drawImage(bmp, 0, y, W, h, 0, 0, c.width, c.height);
    const jb = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const u8 = new Uint8Array(await jb.arrayBuffer());
    let s = '';
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
    out.push('data:image/jpeg;base64,' + btoa(s));
  }
  bmp.close();
  return out;
}
