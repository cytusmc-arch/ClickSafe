// Fast local checks: URL-level (before the page loads) and content-level (after it renders, hidden).
import { hostOf, inList, isPrivateHost } from './settings.js';

export const CAT_LABEL = {
  adult: 'adult content', sexual: 'sexual content', nudity: 'nudity', gore: 'gore or shock content',
  shock: 'shock content', violence: 'graphic violence', self_harm: 'self-harm content', hate: 'hate or extremist content',
  drugs: 'drug sales', gambling: 'a gambling site', scam: 'a scam', phishing: 'a phishing or look-alike site',
  malware: 'malware or a fake download', iplogger: 'an IP logger', ip_logger: 'an IP logger', doxxing: 'private personal info',
  blocklist: 'a site on your block list', error: 'an unfinished check', other: 'content against platform guidelines',
  harassment: 'harassment or bullying', extremism: 'violent extremist content', weapons: 'weapons or explosives',
  dangerous: 'dangerous acts or challenges', piracy: 'pirated streams or downloads', misinfo: 'harmful misinformation',
  animal_cruelty: 'animal cruelty', child_safety: 'content that endangers minors', eating_disorder: 'eating-disorder content',
  suggestive: 'sexually suggestive content', guidelines: 'content against platform guidelines',
};

// Which on/off category toggle (if any) governs an AI/local category.
export const CAT_TOGGLE = {
  adult: 'adult', sexual: 'adult', nudity: 'adult', suggestive: 'adult', gore: 'gore', shock: 'gore', violence: 'gore',
  gambling: 'gambling', iplogger: 'iplogger', ip_logger: 'iplogger',
};

const BRANDS = {
  tiktok: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokshop.com'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discord.new', 'discord.gift', 'discordapp.net', 'discord.media'],
  steam: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamgames.com'],
  steamcommunity: ['steamcommunity.com'], steampowered: ['steampowered.com'],
  twitch: ['twitch.tv'], youtube: ['youtube.com', 'youtu.be'], paypal: ['paypal.com', 'paypal.me'],
  roblox: ['roblox.com'], epicgames: ['epicgames.com'], instagram: ['instagram.com'], facebook: ['facebook.com', 'fb.com'],
  microsoft: ['microsoft.com', 'live.com', 'office.com', 'microsoftonline.com'], coinbase: ['coinbase.com'],
  binance: ['binance.com'], metamask: ['metamask.io'], netflix: ['netflix.com'], streamlabs: ['streamlabs.com'],
  streamelements: ['streamelements.com'], snapchat: ['snapchat.com'], minecraft: ['minecraft.net'],
};

// Brand names as they appear in page titles, for "fake login" detection.
const LOGIN_BRANDS = [
  [/\btik ?tok\b/i, BRANDS.tiktok], [/\bdiscord\b/i, BRANDS.discord], [/\bsteam\b/i, BRANDS.steam],
  [/\bpaypal\b/i, BRANDS.paypal], [/\b(microsoft|outlook|office ?365)\b/i, BRANDS.microsoft],
  [/\bgoogle\b/i, ['google.com']], [/\b(apple ?id|icloud)\b/i, ['apple.com', 'icloud.com']],
  [/\broblox\b/i, BRANDS.roblox], [/\bepic ?games\b/i, BRANDS.epicgames], [/\binstagram\b/i, BRANDS.instagram],
  [/\bfacebook\b/i, BRANDS.facebook], [/\btwitch\b/i, BRANDS.twitch], [/\b(metamask|coinbase|binance)\b/i, [...BRANDS.metamask, ...BRANDS.coinbase, ...BRANDS.binance]],
];

const SCAM_WORDS = /(nitro|gift|free|verify|verification|login|signin|claim|giveaway|support|security|appeal|reward|promo|airdrop|bonus|unban)/;

function regDomain(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  const sld = p[p.length - 2];
  if (p[p.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(sld)) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

const deglyph = (s) => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i|]/g, 'l')
  .replace(/3/g, 'e').replace(/5/g, 's').replace(/4/g, 'a').replace(/-/g, '');

function dist(a, b) { // Damerau-Levenshtein (optimal string alignment)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

const ok = () => ({ action: 'ok', notes: [] });

// URL-only check. action: 'block' | 'flag' | 'ok'
export function checkUrl(url, s) {
  let u; try { u = new URL(url); } catch { return ok(); }
  const host = u.hostname.toLowerCase();
  const r = ok();
  if (isPrivateHost(host)) return r;
  if (inList(host, s.blocked)) return { action: 'block', category: 'blocklist', reason: 'On your block list', notes: [] };

  const flag = (category, reason) => { if (r.action === 'ok') Object.assign(r, { action: 'flag', category, reason }); r.notes.push(reason); };

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) flag('malware', 'Link goes to a raw IP address');
  if (host.split('.').some((p) => p.startsWith('xn--'))) flag('phishing', 'Internationalised look-alike domain (punycode)');

  const label = regDomain(host).split('.')[0];
  const g = deglyph(label);
  for (const [brand, official] of Object.entries(BRANDS)) {
    if (inList(host, official)) continue;
    const b = deglyph(brand);
    if (g === b && label !== brand) return { action: 'block', category: 'phishing', reason: `Look-alike of ${brand} (${host})`, notes: [] };
    if (label === brand) flag('phishing', `Uses the ${brand} name on an unofficial domain`);
    else if (brand.length >= 6 && dist(g, b) <= (brand.length >= 10 ? 2 : 1)) flag('phishing', `Domain looks like ${brand}`);
    else if (label.includes(brand) && SCAM_WORDS.test(label.replace(brand, ''))) flag('scam', `"${brand}" + bait words in the domain`);
  }

  const path = decodeURIComponentSafe(u.pathname + u.search).toLowerCase();
  if (s.cats.adult && /(^|[\/_\-.?=&+])(porn|porno|nsfw|hentai|xxx|nudes?|onlyfans|r34|rule34)([\/_\-.?=&+]|$)/.test(path)) flag('adult', 'Explicit words in the link');
  if (s.cats.gore && /(^|[\/_\-.?=&+])(gore|beheading|decapitation)([\/_\-.?=&+]|$)/.test(path)) flag('gore', 'Gore words in the link');
  return r;
}

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

const STRONG = /\b(porn|porno|pornhub|xxx|hentai|nsfw|nudes?|naked|sex ?(tape|video|cam|chat)s?|camgirls?|cam girls?|live sex|milf|blowjob|cumshot|creampie|gangbang|fetish|bdsm|erotic|escort|onlyfans leaks?|xvideos|xnxx|stripchat|chaturbate)\b/gi;
const GORE = /\b(gore|beheading|decapitat\w*|dismember\w*|real death|death video|graphic footage|shock site)\b/gi;
const GAMBLE = /\b(casino|free spins|deposit bonus|sportsbook|slots?|roulette|blackjack|plinko|crash game|bet now|wager|jackpot)\b/gi;
const AGE_GATE = /(you must be (18|21)|18\+ only|over 18|i am 18 or older|i'?m over 18|adults only|adult content warning|enter if you are 18|age verification)/i;
// Text aimed at an AI checker ("ignore previous instructions", fake verdict JSON...). Real pages don't do this.
const INJECT = /(ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|rules)|disregard (the )?(system|previous) (prompt|instructions)|\byou are (an? )?(ai|llm|large language model|language model|safety classifier|content (safety )?(classifier|filter|moderator))\b|"verdict"\s*:|(classify|mark|rate|label) (this|the) (page|site|website) as (safe|clean)|system prompt|<\/?page>)/i;
const IPLOG = /(ip ?logger|ip ?grabber|grabify|your ip (address )?(has been|was) (logged|recorded)|iplogger)/i;

const count = (re, s) => (s.match(re) || []).length;

// Content check on what the hidden page rendered. action: 'block' | 'hold' | 'ok'
export function analyzeContent(d, s) {
  const notes = [];
  const title = d.title || '', desc = `${d.description || ''} ${d.ogTitle || ''} ${d.ogDesc || ''}`;
  const heads = (d.headings || []).join(' '), text = d.text || '', host = (d.host || hostOf(d.url)).toLowerCase();
  const alts = (d.images || []).map((i) => i.alt).join(' ');

  if (s.cats.adult && (d.rta || /adult|mature|rta-5042/i.test(d.rating || ''))) {
    return { action: 'block', category: 'adult', reason: 'Page labels itself as adult-only (RTA/rating tag)', notes };
  }
  // "Verify you're human: press Win+R, Ctrl+V, Enter" = the page wants you to run malware.
  const head = `${title} ${heads} ${text.slice(0, 4000)}`;
  if (/(win(dows)?\s*(key)?\s*(\+|and)\s*r\b|windows\s+key\s*\+\s*r|⊞\s*\+?\s*r|run\s+dialog)/i.test(head) &&
      /((ctrl|control|⌘|cmd)\s*(\+|and)\s*v\b|paste)/i.test(head) && /(verif|captcha|robot|human|security check|cloudflare)/i.test(head)) {
    return { action: 'block', category: 'malware', reason: 'Fake "verify you\'re human" page that tells you to run a command', notes };
  }
  if (s.cats.iplogger && IPLOG.test(`${title} ${heads} ${text.slice(0, 1500)}`)) {
    return { action: 'block', category: 'iplogger', reason: 'Page looks like an IP logger', notes };
  }

  const titleHits = count(STRONG, title);
  const adultScore = titleHits * 4 + count(STRONG, desc) * 3 + count(STRONG, heads) * 2 + Math.min(10, count(STRONG, text)) + Math.min(4, count(STRONG, alts));
  const goreScore = count(GORE, title) * 4 + count(GORE, desc) * 3 + count(GORE, heads) * 2 + Math.min(8, count(GORE, text));
  const gambleScore = count(GAMBLE, title) * 3 + count(GAMBLE, desc) * 2 + count(GAMBLE, heads) * 2 + Math.min(8, count(GAMBLE, text));

  if (s.cats.adult && titleHits && adultScore >= 10) return { action: 'block', category: 'adult', reason: 'Strong explicit-content signals', notes };
  if (s.cats.gore && count(GORE, title) && goreScore >= 10) return { action: 'block', category: 'gore', reason: 'Strong gore/shock signals', notes };

  let r = { action: 'ok', notes };
  const hold = (category, reason, force = false) => {
    if (r.action === 'ok' || (force && !r.force)) r = { action: 'hold', category, reason, notes, force };
    notes.push(reason);
  };

  if (INJECT.test(`${title} ${desc} ${heads} ${text} ${alts}`)) hold('scam', 'Page contains text aimed at manipulating the AI checker', true);

  if (s.cats.adult && adultScore >= 4) hold('adult', 'Explicit words on the page');
  if (s.cats.adult && AGE_GATE.test(`${title} ${heads} ${text.slice(0, 2000)}`)) hold('adult', 'Age-gated (18+) page');
  if (s.cats.gore && goreScore >= 4) hold('gore', 'Gore/shock words on the page');
  if (s.cats.gambling && gambleScore >= 6) hold('gambling', 'Gambling / casino content');

  if (d.passwordFields > 0) {
    for (const [re, domains] of LOGIN_BRANDS) {
      if (re.test(`${title} ${heads}`) && !inList(host, domains)) { hold('phishing', 'Login form imitating a brand on another domain'); break; }
    }
  }
  const lower = `${title} ${heads} ${text.slice(0, 3000)}`.toLowerCase();
  if (/connect (your )?wallet/.test(lower) && /(claim|airdrop|reward|mint|giveaway)/.test(lower)) hold('scam', 'Crypto "connect wallet to claim" page');
  if (/free (discord )?nitro|steam gift card|free robux|free v-?bucks/.test(lower) && (d.passwordFields > 0 || /log ?in|sign ?in|verify/.test(lower))) hold('scam', 'Free-gift bait asking you to log in');
  if (/(your (pc|computer|device) (is|has been) (infected|locked|hacked)|call (microsoft|windows) support)/.test(lower)) hold('scam', 'Fake virus / tech-support warning');
  return r;
}

// Merge URL check, local content check and AI verdict into one decision.
// returns { action: 'reveal' | 'hold' | 'block', category, reason, source }
export function combine(u, local, ai, s) {
  const allowed = (cat) => { const t = CAT_TOGGLE[cat]; return !t || s.cats[t]; };
  if (local.action === 'block') return { action: 'block', category: local.category, reason: local.reason, source: 'local' };
  // Pages that try to talk to the AI never get an automatic pass, whatever the AI answers.
  if (local.force) return { action: 'hold', category: local.category, reason: local.reason, source: 'local' };
  const flagged = u.action === 'flag' ? u : local.action === 'hold' ? local : null;

  if (ai && !ai.error) {
    if (ai.verdict === 'unsafe' && allowed(ai.category)) return { action: 'block', category: ai.category, reason: ai.reason, source: 'ai', model: ai.model };
    if (ai.verdict === 'caution' && allowed(ai.category)) return { action: 'hold', category: ai.category, reason: ai.reason, source: 'ai', model: ai.model };
    if (flagged && (ai.verdict !== 'safe' || (ai.confidence ?? 0) < 0.85)) {
      return { action: 'hold', category: flagged.category, reason: `${flagged.reason} — AI not confident it's safe`, source: 'local' };
    }
    return { action: 'reveal', category: 'none', reason: ai.reason || 'Looks safe', source: 'ai', model: ai.model };
  }
  if (ai?.error && s.strict) return { action: 'hold', category: 'error', reason: `AI scan unavailable (${ai.error})`, source: 'error' };
  if (flagged) return { action: 'hold', category: flagged.category, reason: flagged.reason, source: 'local' };
  return { action: 'reveal', category: 'none', reason: 'Passed local checks', source: 'local' };
}

// ---------- deep scan: behaviour seen while the page ran hidden (reported by guard.js) ----------
export const SIGNAL_RULES = {
  clipboardCmd: { action: 'block', cat: 'malware', reason: 'Tried to put a system command on your clipboard (fake "verify you\'re human")' },
  kbLock: { action: 'block', cat: 'scam', reason: 'Tried to lock your keyboard (scareware)' },
  exfil: { action: 'block', cat: 'malware', reason: 'Sent data to a hidden webhook' },
  download: { action: 'block', cat: 'malware', reason: 'Tried to download a program by itself' },
  historyFlood: { action: 'hold', cat: 'scam', reason: 'Flooded your history to break the back button' },
  fullscreen: { action: 'hold', cat: 'scam', reason: 'Tried to force fullscreen without a click' },
  walletSign: { action: 'hold', cat: 'scam', reason: 'Asked your crypto wallet to sign something' },
  iplookup: { action: 'flag', cat: 'iplogger', reason: 'Looked up your IP address' },
  webrtc: { action: 'flag', cat: 'iplogger', reason: 'Tried to discover your IP address through WebRTC' },
  walletConnect: { action: 'flag', cat: 'scam', reason: 'Asked to connect your crypto wallet' },
  miner: { action: 'flag', cat: 'malware', reason: 'Runs heavy background code (possible crypto miner)' },
};

const SEV = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const GUARD_HARD = /sexual|violent|suicide|self-harm/i;

// Merge every check into one decision.
// x: { u, local, ai, ai2, intel, scripts: { summary, analyst }, signals: [{ type }], media: { max }, guard, audio, sealedSafe }
export function decide(x, s) {
  const allowed = (cat) => { const t = CAT_TOGGLE[cat]; return !t || s.cats[t]; };
  const out = (action, category, reason, source, extra = {}) => ({ action, category, reason, source, ...extra });
  const sc = x.scripts?.summary || { level: 'none' };
  const an = x.scripts?.analyst && !x.scripts.analyst.error ? x.scripts.analyst : null;
  const sigs = (x.signals || []).map((g) => ({ ...g, rule: SIGNAL_RULES[g.type] })).filter((g) => g.rule && allowed(g.rule.cat));
  const ais = [x.ai, x.ai2].filter((a) => a && !a.error);

  // 1. Hard evidence: block without waiting for anyone to agree.
  if (x.local?.action === 'block') return out('block', x.local.category, x.local.reason, 'local');
  if (x.intel?.feed) return out('block', 'phishing', `Listed in the ${x.intel.feed.source} threat feed`, 'threat feed');
  const hardSig = sigs.find((g) => g.rule.action === 'block');
  if (hardSig) return out('block', hardSig.rule.cat, hardSig.rule.reason, 'behaviour');
  if (sc.level === 'critical' && allowed(sc.category)) return out('block', sc.category, sc.reason, 'script scan');
  if (an?.verdict === 'malicious' && an.confidence >= 0.75 && SEV[sc.level] >= SEV.medium && allowed(an.category)) return out('block', an.category, an.reason || sc.reason, 'script analyst', { model: an.model });
  if (s.cats.adult && (x.media?.max ?? 0) >= 0.92) return out('block', 'sexual', 'On-device model found explicit imagery', 'local model');
  if (s.cats.gore && (x.media?.gore ?? 0) >= 0.92) return out('block', 'gore', 'On-device model found graphic violence', 'local model');
  for (const a of ais) if (a.verdict === 'unsafe' && allowed(a.category)) return out('block', a.category, a.reason, 'ai', { model: a.model });

  // 2. Keep hidden, whatever the AI says.
  if (x.local?.force) return out('hold', x.local.category, x.local.reason, 'local');
  if (x.guard?.categories?.some((c) => /jailbreak/i.test(c))) return out('hold', 'scam', 'Page text tries to manipulate AI checkers', 'safety model');
  const holdSig = sigs.find((g) => g.rule.action === 'hold');
  if (holdSig) return out('hold', holdSig.rule.cat, holdSig.rule.reason, 'behaviour');
  if (sc.level === 'high' && allowed(sc.category) && !(an?.verdict === 'benign' && an.confidence >= 0.8)) return out('hold', sc.category, sc.reason, 'script scan');
  if (an && an.verdict !== 'benign' && SEV[sc.level] >= SEV.medium && allowed(an.category)) return out('hold', an.category, an.reason || sc.reason, 'script analyst', { model: an.model });
  for (const a of ais) if (a.verdict === 'caution' && a.category && a.category !== 'none' && allowed(a.category)) return out('hold', a.category, a.reason, 'ai', { model: a.model });

  // 3. Warning signs: shown only if the AI is confident it's safe (and the second model agrees, if asked).
  const flags = [];
  if (x.u?.action === 'flag') flags.push([x.u.category, x.u.reason]);
  if (x.local?.action === 'hold') flags.push([x.local.category, x.local.reason]);
  if (x.intel?.ageDays != null && x.intel.ageDays < 21) flags.push(['phishing', `Domain registered ${x.intel.ageDays} day${x.intel.ageDays === 1 ? '' : 's'} ago`]);
  for (const g of sigs) if (g.rule.action === 'flag') flags.push([g.rule.cat, g.rule.reason]);
  if (sc.level === 'medium' && allowed(sc.category)) flags.push([sc.category, sc.reason]);
  if (s.cats.adult && (x.media?.max ?? 0) >= 0.6) flags.push(['suggestive', 'On-device model found possibly explicit imagery']);
  if (s.cats.gore && (x.media?.gore ?? 0) >= 0.6) flags.push(['gore', 'On-device model found possibly graphic imagery']);
  if (x.guard?.safety === 'unsafe' && x.guard.categories?.some((c) => GUARD_HARD.test(c))) flags.push(['other', `Safety model flagged the text (${x.guard.categories.join(', ')})`]);
  if (x.audio?.flag) flags.push([x.audio.flag.category, x.audio.flag.reason]);
  if (flags.length) {
    const sure = ais.length && ais.every((a) => a.verdict === 'safe' && (a.confidence ?? 0) >= 0.85);
    if (!sure) return out('hold', flags[0][0], `${flags[0][1]}${ais.length ? " — AI not confident it's safe" : ''}`, 'local');
  }

  // 4. The check itself didn't finish.
  if (s.aiEnabled && !ais.length && !x.sealedSafe && s.strict) return out('hold', 'error', `AI scan unavailable (${x.ai?.error || 'no answer'})`, 'error');
  const a = ais[0];
  return out('reveal', 'none', a?.reason || (x.sealedSafe ? 'Cleared in the sealed preview' : 'Passed local checks'), a ? 'ai' : 'local', a ? { model: a.model } : {});
}
