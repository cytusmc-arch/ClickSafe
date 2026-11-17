// Compact public-suffix helper (no DOM). Not the full Mozilla PSL: it covers the multi-label
// suffixes people actually meet, plus "free hosting" platforms where every subdomain is a separate,
// anonymous site (github.io, pages.dev, vercel.app...). For those the subdomain is the unit that
// matters, and the platform's own domain age says nothing about the site.

// ccTLD -> second-level labels that are public suffixes (e.g. uk: co -> "co.uk").
const CC = Object.assign(Object.create(null), {
  uk: 'co ac gov ltd me net nhs org plc police sch', au: 'com net org edu gov asn id csiro', nz: 'co ac geek gen govt health iwi kiwi maori mil net org parliament school',
  jp: 'co ne or ac ad ed go gr lg', kr: 'co ne or re pe go mil ac hs ms es sc kg', cn: 'com net org gov edu ac mil', tw: 'com net org edu gov idv mil club ebiz game',
  hk: 'com net org edu gov idv', mo: 'com net org edu gov', sg: 'com net org edu gov per', my: 'com net org edu gov mil name biz', in: 'co net org firm gen ind ac edu gov res mil nic',
  za: 'co org net gov ac web edu nom law mil school', mx: 'com org net gob edu', ar: 'com net org gob edu int mil tur', br: 'com net org gov edu art blog app dev eco emp eng esp etc far ind inf jor log mus not ong pro psi rec srv tmp tur tv vlog wiki adv arq bio coop med mil nom radio seg vet',
  tr: 'com net org gen biz info web gov edu av bbs bel dr k12 kep mil name pol tel tv', ua: 'com net org in gov edu kiev kyiv pp', ru: 'com net org pp msk spb', pl: 'com net org info biz waw edu gov',
  il: 'co org net ac gov muni k12', id: 'co or web ac go my biz net sch mil', th: 'co in or ac go mi net', vn: 'com net org edu gov int ac biz info name pro health', ph: 'com net org edu gov mil ngo',
  pk: 'com net org edu gov fam biz web', ng: 'com net org edu gov name sch mil mobi', eg: 'com net org edu gov eun sci', sa: 'com net org edu gov med pub sch', ae: 'co net org ac gov mil sch',
  qa: 'com net org edu gov name sch mil', kw: 'com net org edu gov emb', om: 'com net org edu gov co med pro', bh: 'com net org edu gov', co: 'com net org edu gov mil nom', pe: 'com net org edu gob mil nom',
  ve: 'co com net org edu gob mil web info', ec: 'com net org edu gob fin info med pro', cl: 'gob gov mil co', uy: 'com net org edu gub mil', lk: 'com net org edu gov', ke: 'co or ne ac go sc me mobi info',
  tz: 'co or ne ac go sc me mobi tv hotel info', ug: 'co or ne ac go sc com org', gh: 'com org edu gov mil', es: 'com nom org gob edu', pt: 'com org gov edu', gr: 'com net org edu gov', cy: 'com net org ac gov biz',
  mt: 'com net org edu gov', at: 'co or ac gv', be: 'ac', fr: 'com asso nom gouv prd tm', it: 'co gov edu', hu: 'co org info tm priv', ro: 'com org info nt rec store tm www arts firm nom', rs: 'co org edu ac gov in',
  ba: 'com net org edu gov', hr: 'com from iz name', ir: 'co ac org net gov sch id', kz: 'com net org edu gov mil', uz: 'co com net org', by: 'com net gov mil', ge: 'com net org edu gov', am: 'com net org',
  az: 'com net org edu gov biz info name pro', jo: 'com net org edu gov', lb: 'com net org edu gov', tn: 'com ens fin gov ind info intl nat net org perso tourism', ma: 'co net gov org ac press', dz: 'com org net gov edu asso pol art',
  et: 'com gov org edu biz name info net', zw: 'co ac gov org', na: 'co com org', bw: 'co org', zm: 'co com org ac gov', mu: 'co com org net ac gov or', la: 'com net org edu gov per info int', bn: 'com net org edu gov',
  fj: 'com net org ac gov biz info name pro mil', ws: 'com net org edu gov', to: 'com net org edu gov mil', gg: 'co net org', je: 'co net org', im: 'co com net org ac ltd plc tt tv', io: 'com net org edu gov mil',
  me: 'co net org edu ac gov its priv', ly: 'com net org edu gov plc sch med id', so: 'com net org edu gov me sch', sc: 'com net org edu gov', ai: 'com net org off', ag: 'com net org co nom', bz: 'com net org edu gov co',
  vc: 'com net org edu gov mil', lc: 'com net org edu gov co', gy: 'com net org edu gov co', tt: 'com net org edu gov co biz info name pro', pr: 'com net org edu gov biz info name pro isla', do: 'com net org edu gob gov mil art sld web',
  gt: 'com net org edu gob mil ind', hn: 'com net org edu gob mil', ni: 'com net org edu gob co in info nom web mil biz', sv: 'com org edu gob red', cr: 'co ac ed fi go or sa', pa: 'com net org edu gob abo ac ing med nom sld',
  bo: 'com net org edu gob gov int mil tv web', py: 'com net org edu gov coop mil', cu: 'com net org edu gov inf',
});
// ccTLDs where every second-level label is a public suffix (PSL "*.tld").
const WILD = new Set(['bd', 'ck', 'er', 'fk', 'jm', 'kh', 'mm', 'np', 'pg']);
// Fallback for other two-letter ccTLDs: these second-level labels are nearly always suffixes.
const GENERIC_SLD = new Set(['com', 'net', 'org', 'gov', 'edu', 'ac', 'co', 'gob', 'mil', 'nom']);
// Registry-style suffixes sold by private operators (CentralNic etc.).
const PRIVATE_SLD = ['us.com', 'uk.com', 'eu.com', 'de.com', 'cn.com', 'br.com', 'ru.com', 'sa.com', 'za.com', 'jpn.com', 'uy.com', 'gb.net', 'uk.net', 'jp.net', 'se.net', 'hu.net', 'in.net', 'za.org', 'eu.org', 'com.de', 'com.se', 'co.com', 'co.nl', 'co.no', 'us.org', 'pp.ua'];

const ICANN = new Set(PRIVATE_SLD);
for (const [tld, labels] of Object.entries(CC)) for (const l of labels.split(' ')) if (l) ICANN.add(`${l}.${tld}`);

// Free / anonymous hosting where anyone can publish at <name>.<suffix>. Order does not matter.
export const HOSTING = new Set(`
github.io githubusercontent.com gitlab.io codeberg.page pages.dev workers.dev r2.dev trycloudflare.com vercel.app now.sh netlify.app
web.app firebaseapp.com firebasestorage.app appspot.com cloudfunctions.net run.app a.run.app blogspot.com herokuapp.com herokudns.com
glitch.me repl.co replit.app replit.dev onrender.com fly.dev railway.app up.railway.app azurewebsites.net azurestaticapps.net
cloudapp.net azureedge.net blob.core.windows.net web.core.windows.net trafficmanager.net s3.amazonaws.com cloudfront.net amplifyapp.com
elasticbeanstalk.com myshopify.com wixsite.com wixstudio.com wixstudio.io editorx.io weebly.com weeblysite.com wordpress.com wpcomstaging.com
square.site squarespace.com carrd.co webflow.io framer.app framer.website framer.ai notion.site gitbook.io ngrok.io ngrok-free.app ngrok.app
ngrok.dev ngrok-free.dev loca.lt serveo.net surge.sh neocities.org 000webhostapp.com tiiny.site w3spaces.com godaddysites.com jimdosite.com
jimdofree.com mystrikingly.com webnode.page yolasite.com mobirisesite.com translate.goog duckdns.org ddns.net hopto.org zapto.org sytes.net
no-ip.org no-ip.biz freeddns.org dynu.net linkpc.net dweb.link on.fleek.co fleek.co hf.space streamlit.app lovable.app bolt.host deno.dev
deno.net val.run web.val.run pythonanywhere.com ondigitalocean.app cyclic.app koyeb.app b4a.app back4app.io glide.page glideapp.io softr.app
bubbleapps.io tilda.ws tumblr.com start.page webwave.dev myportfolio.com webcindario.com teemill.com boxmode.io plutio.com mypinata.cloud
nftstorage.link w3s.link supabase.co oast.pro oast.fun oast.live oast.site oast.online oast.me interact.sh screenconnect.com aliyuncs.com
myqcloud.com b-cdn.net volces.com rf.gd epizy.com infinityfreeapp.com wuaze.com great-site.net free.nf 42web.io kesug.com unaux.com
byethost.com ueuo.com zyrosite.com hostingersite.com builderallwppro.com site123.me webador.com webador.site ucraft.site
beehiiv.com substack.com medium.com hashnode.dev super.site mmm.page stackblitz.io csb.app codesandbox.io
netlify.com digitaloceanspaces.com linodeobjects.com backblazeb2.com wasabisys.com
`.trim().split(/\s+/));

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export const isIp = (h) => IPV4.test(h) || h.startsWith('[') || h.includes(':');

export function normHost(h) {
  h = String(h || '').trim().toLowerCase();
  if (h.includes('/') || h.includes('@')) { try { h = new URL(h.includes('://') ? h : 'http://' + h).hostname; } catch { return ''; } }
  return h.replace(/\.+$/, '');
}

// The longest public suffix of host: { suffix, hosting } (hosting = free-hosting platform suffix).
export function publicSuffix(host) {
  // A hosting suffix only counts when there is a label in front of it (github.io itself is a normal domain).
  const first = host.indexOf('.');
  for (let i = first; i >= 0; i = host.indexOf('.', i + 1)) {
    const s = host.slice(i + 1);
    if (HOSTING.has(s)) {
      if (i === first && host.slice(0, i) === 'www') break; // www.weebly.com is the platform's own site
      return { suffix: s, hosting: true };
    }
  }
  const d1 = host.lastIndexOf('.');
  if (d1 < 0) return { suffix: host, hosting: false };
  const d2 = host.lastIndexOf('.', d1 - 1); // -1 when host has two labels
  if (d2 >= 0) {
    const three = host.slice(host.lastIndexOf('.', d2 - 1) + 1);
    if (ICANN.has(three)) return { suffix: three, hosting: false };
  }
  const two = host.slice(d2 + 1), tld = host.slice(d1 + 1);
  if (ICANN.has(two) || WILD.has(tld) || (tld.length === 2 && !CC[tld] && GENERIC_SLD.has(host.slice(d2 + 1, d1)))) return { suffix: two, hosting: false };
  return { suffix: tld, hosting: false };
}

// eTLD+1 ("registrable domain"), or for free-hosting platforms the site's own subdomain.
// Returns { domain, suffix, hosting } — domain is '' for bare suffixes / invalid input; IPs return themselves.
export function registrable(host) {
  host = normHost(host);
  if (!host) return { domain: '', suffix: '', hosting: false };
  if (isIp(host)) return { domain: host, suffix: '', hosting: false, ip: true };
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host)) return { domain: '', suffix: '', hosting: false };
  const { suffix, hosting } = publicSuffix(host);
  if (host === suffix) return { domain: '', suffix, hosting };
  const end = host.length - suffix.length - 1; // the dot before the suffix
  return { domain: host.slice(host.lastIndexOf('.', end - 1) + 1), suffix, hosting };
}

// True for bare public suffixes (co.uk, com) — never valid as a "whole site" entry.
export function isPublicSuffix(host) {
  const h = normHost(host);
  return !!h && !isIp(h) && publicSuffix(h).suffix === h;
}
