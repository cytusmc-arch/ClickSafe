// ClickSafe chat guard: checks links people post in stream chat (and other user-posted links on
// streaming platforms) BEFORE the streamer clicks, and marks each link with a small verdict badge.
// Classic content script (no imports). Registered for all frames at document_start, isolated world.
(() => {
  'use strict';
  if (window.__clickSafeChatGuard) return;
  try { Object.defineProperty(window, '__clickSafeChatGuard', { value: true }); } catch { return; }
  if (!/^https?:$/.test(location.protocol) || !globalThis.chrome?.runtime?.id) return;

  // ---------- platform ----------
  const under = (h, d) => h === d || h.endsWith('.' + d);
  const norm = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const PAGE_HOST = norm(location.hostname);
  const TEST = PAGE_HOST.endsWith('.test'); // e2e fixtures: "www.twitch.tv.test" behaves like www.twitch.tv
  const unTest = (h) => (TEST ? h.replace(/\.test$/, '') : h);
  const SITE = unTest(PAGE_HOST);
  const SLD = /^(co|com|net|org|ac|gov|edu|or|ne|go|gob|nic|mil|ltd|plc)$/;
  function reg(h) { // registrable-domain approximation (no PSL in a content script)
    h = norm(h).replace(/^www\d*\./, '');
    if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
    const p = h.split('.');
    return p.length <= 2 ? h : p.slice(p.at(-1).length === 2 && SLD.test(p.at(-2)) ? -3 : -2).join('.');
  }

  // msg: a single message/comment (text inside is scanned for plain-text URLs too).
  // ctx: wider chat/message containers. ignore: platform UI chrome (nav, guide, footers).
  const PLATFORMS = [
    { id: 'twitch', sites: ['twitch.tv'],
      own: ['twitch.tv', 'ttvnw.net', 'jtvnw.net', 'twitchcdn.net', 'twitchsvc.net', 'twitch.a2z.com', 'ext-twitch.tv'],
      chatPath: /^\/(popout|embed)\/[^/]+\/chat|^\/popout\//,
      msg: '.chat-line__message,[data-a-target="chat-line-message"],.vod-message,.video-chat__message,.seventv-message,.chat-line__message-container,.whisper-line',
      ctx: '.chat-scrollable-area__message-container,[data-test-selector="chat-scrollable-area__message-container"],.chat-room__content,.video-chat__message-list-wrapper,.whispers-thread',
      ignore: '.top-nav,#sideNav,[data-a-target="side-nav-bar"],[data-a-target="top-nav-container"]' },
    { id: 'kick', sites: ['kick.com'], own: ['kick.com'],
      chatPath: /^\/popout\/[^/]+\/chat|^\/[^/]+\/chatroom/,
      msg: '[data-chat-entry],.chat-entry,#chatroom-messages [data-index]',
      ctx: '#chatroom-messages,#chatroom,[class*="chatroom" i]', ignore: '' },
    { id: 'youtube', sites: ['youtube.com'],
      own: ['youtube.com', 'youtu.be', 'yt.be', 'ytimg.com', 'ggpht.com', 'googlevideo.com', 'youtube-nocookie.com', 'youtubekids.com',
        'accounts.google.com', 'support.google.com', 'policies.google.com', 'myaccount.google.com', 'consent.youtube.com'],
      chatPath: /^\/live_chat/,
      msg: 'yt-live-chat-text-message-renderer,yt-live-chat-paid-message-renderer,yt-live-chat-membership-item-renderer,yt-live-chat-banner-renderer,ytd-comment-renderer,ytd-comment-view-model,ytm-comment-renderer',
      ctx: 'yt-live-chat-renderer,yt-live-chat-item-list-renderer,ytd-comments,ytd-comment-thread-renderer',
      ignore: 'ytd-masthead,#masthead-container,#guide,ytd-guide-renderer,ytd-mini-guide-renderer,tp-yt-app-drawer' },
    { id: 'tiktok', sites: ['tiktok.com'],
      own: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'ttwstatic.com', 'byteoversea.com', 'ibytedtos.com', 'tiktokw.us'],
      chatPath: null,
      msg: '[data-e2e="chat-message"],[data-e2e*="comment-level" i],[data-e2e*="comment-text" i],[class*="DivChatMessage"],[class*="CommentItem"]',
      ctx: '[data-e2e*="chat-room" i],[class*="DivChatRoom"],[class*="ChatRoomContainer"],[class*="CommentList"],[data-e2e*="comment-list" i]', ignore: '' },
    { id: 'x', sites: ['x.com', 'twitter.com'], own: ['x.com', 'twitter.com', 'twimg.com', 'pscp.tv', 'periscope.tv'],
      chatPath: /^\/messages\//,
      msg: '[data-testid="tweetText"],[data-testid="messageEntry"]',
      ctx: 'article[data-testid="tweet"],[data-testid="DmActivityContainer"],[data-testid="DMDrawer"]', ignore: '' },
    { id: 'discord', sites: ['discord.com', 'discordapp.com'],
      own: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discord.gift', 'discordstatus.com', 'dis.gd'],
      chatPath: /^\/channels\//,
      msg: '[id^="chat-messages-"],li[class*="messageListItem"],[class*="messageContent"]',
      ctx: '[data-list-id="chat-messages"],[class*="messagesWrapper"],[class*="chatContent"]', ignore: '' },
  ];
  const P = PLATFORMS.find((p) => p.sites.some((d) => under(SITE, d))) ||
    { id: 'generic', sites: [reg(SITE)], own: [reg(SITE)], chatPath: null, msg: '.message,.chat-message', ctx: '', ignore: '' };
  const MSG = P.msg + ',[data-message-id],[data-chat-entry],[class*="chat-line" i],[class*="chat-message" i],[class*="chatmessage" i]';
  const CTX = MSG + ',[role=log],[role=feed]' + (P.ctx ? ',' + P.ctx : '');
  const IGNORE = 'nav,[role=navigation],footer,[role=contentinfo],[role=menu],[role=menubar]' + (P.ignore ? ',' + P.ignore : '');
  const NO_TEXT = 'a,script,style,noscript,textarea,input,select,[contenteditable]:not([contenteditable=false])';
  const pageIsChat = () => !!P.chatPath && P.chatPath.test(location.pathname);
  const isOwn = (h) => { const x = unTest(h); return x === SITE || P.own.some((d) => under(x, d)); };

  // ---------- URL helpers ----------
  const LOOSE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,30})(?::\d{2,5})?(?:[/?#]\S*)?$/i;
  function looseUrl(s) { // "https://x.y/z", "x.y/z" or "www.x.y" -> URL; null otherwise
    s = String(s || '').replace(/[​-‍⁠﻿]/g, '').trim().replace(/(…|\.{3})$/, '');
    if (!s || s.length > 2048 || /\s/.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) { if (!LOOSE.test(s)) return null; s = 'https://' + s; }
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u : null; } catch { return null; }
  }
  // Link wrappers that carry the real target in a query parameter.
  const WRAPPERS = [
    [/(^|\.)youtube\.com$/, /^\/redirect/, ['q']],
    [/(^|\.)google\.[a-z.]{2,6}$/, /^\/url$/, ['q', 'url']],
    [/^lm?\.facebook\.com$/, /^\/l\.php/, ['u']],
    [/^l\.instagram\.com$/, /^\//, ['u']],
    [/(^|\.)tiktok\.com$/, /^\/link\//, ['target', 'url']],
    [/^steamcommunity\.com$/, /^\/linkfilter/, ['url', 'u']],
    [/^(m\.)?vk\.com$/, /^\/away\.php/, ['to']],
    [/^out\.reddit\.com$/, /^\//, ['url']],
    [/^slack-redir\.net$/, /^\/link/, ['url']],
  ];
  const OWN_PARAMS = ['q', 'url', 'u', 'target', 'to', 'dest', 'destination', 'redirect', 'redirect_url', 'link', 'href'];
  function unwrap(u) {
    for (let i = 0; i < 3; i++) {
      const h = unTest(norm(u.hostname));
      const w = WRAPPERS.find(([hr, pr]) => hr.test(h) && pr.test(u.pathname));
      const params = w ? w[2] : isOwn(norm(u.hostname)) && u.search ? OWN_PARAMS : null;
      if (!params) return u;
      let next = null;
      for (const p of params) { const v = u.searchParams.get(p); if (v && (next = looseUrl(v))) break; }
      if (!next) return u;
      u = next;
    }
    return u;
  }
  // x.com shows the expanded URL in the t.co anchor (title / text); the href is only the shortener.
  function xDisplay(a) {
    for (const s of [a.getAttribute('data-expanded-url'), a.title, a.textContent]) { const u = looseUrl(s); if (u && norm(u.hostname) !== 't.co') return u; }
    return null;
  }
  const textHost = (a) => { const t = a.textContent || ''; if (t.length > 300) return ''; const u = looseUrl(t); return u ? norm(u.hostname) : ''; };
  const keyOf = (u) => { const c = new URL(u.href); c.hash = ''; return c.href.slice(0, 4096); };
  const hostOfUrl = (s) => { try { return norm(new URL(s).hostname); } catch { return ''; } };
  const stripW = (h) => h.replace(/^www\./, '');

  // Plain-text URLs in chat (TikTok LIVE, Kick and Discord often don't make them clickable).
  const TEXT_URL = /(?:^|[\s(<"'[{])((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,30})(?::\d{2,5})?(?:[/?#][^\s<>"'`]*)?)/gi;
  const QUICK = /\.[a-z]{2}|:\/\//i;
  const TLDS = new Set(('com net org io gg tv co me xyz app dev link site online live shop store club fun top info biz ru su ly to cc gl be us uk de fr nl pl es it eu ca au in br jp ' +
    'vip win bet casino porn sex xxx adult cam tk ml ga cf gq icu buzz click cyou rest monster sbs cfd lol pw ws mobi pro gift gay sexy ' +
    'tube video stream games game lat cloud space website page sbs bond today news art').split(' '));
  if (TEST) TLDS.add('test');
  function textUrl(raw) {
    const u = looseUrl(raw);
    if (!u) return null;
    if (/^https?:\/\//i.test(raw) || /^www\./i.test(raw)) return u;
    return TLDS.has(u.hostname.split('.').at(-1).toLowerCase()) ? u : null;
  }

  // ---------- state ----------
  const RATE = 20, WINDOW = 60000, QUEUE_MAX = 120, POLL_MAX = 12, CACHE_MAX = 3000, ARM_MS = 4000;
  const FINAL = new Set(['safe', 'caution', 'unsafe', 'unknown']);
  const STATES = new Set(['safe', 'caution', 'unsafe', 'pending', 'unknown', 'off']);
  const CAT_WORDS = { adult: 'adult content', porn: 'adult content', gore: 'graphic violence', violence: 'graphic violence', gambling: 'gambling',
    iplogger: 'IP logger', phishing: 'scam', scam: 'scam', malware: 'malware', typosquat: 'fake look-alike site', shortener: 'hidden destination' };
  const cache = new Map();   // url key -> entry (dedupe)
  const queue = new Map();   // url key -> entry, insertion order = age (newest last)
  const sentAt = [];         // timestamps of new prechecks (rate window)
  const armed = new Map();   // caution: url key -> "second click allowed until"
  const liveItems = new Set();
  let itemOf = new WeakMap(), skipped = new WeakMap(), textSeen = new WeakMap();
  const badgeItem = new WeakMap(), holderOf = new WeakMap(), elItems = new WeakMap(), visible = new WeakSet(), seen = new WeakSet();
  let pumpTimer = 0, paused = false, dead = false;

  function entryFor(key, url) {
    let e = cache.get(key);
    if (!e) {
      e = { key, url, state: 'new', label: '', category: '', finalUrl: '', items: new Set(), sentDeep: false, polls: 0, timer: 0, inflight: false, upgrade: false, wantDeep: false, retried: false };
      cache.set(key, e);
      if (cache.size > CACHE_MAX) for (const [k, old] of cache) { if (cache.size <= CACHE_MAX * 0.9) break; if (!old.items.size && !old.inflight) { cache.delete(k); queue.delete(k); } }
    }
    return e;
  }
  const anyVisible = (e) => { for (const it of e.items) if (visible.has(it.el) && it.node.isConnected) return true; return false; };
  const wantsDeep = (e) => { for (const it of e.items) if (it.chat && visible.has(it.el) && it.node.isConnected) return true; return false; };
  const isLive = (e) => { for (const it of e.items) if (it.node.isConnected) return true; return false; };

  function setState(e, state, label = '', category = '', finalUrl = '') {
    e.state = state; e.label = cleanLabel(label, category); e.category = String(category || '').slice(0, 40);
    e.finalUrl = typeof finalUrl === 'string' && /^https?:\/\//i.test(finalUrl) ? finalUrl : '';
    for (const it of e.items) renderItem(it);
  }
  function cleanLabel(label, category) {
    const s = String(label || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    return s || CAT_WORDS[String(category || '').toLowerCase()] || '';
  }

  // ---------- precheck queue: dedupe, ~20 new checks/min, newest (and on-screen) first ----------
  function enqueue(e, upgrade) {
    if (paused || dead) return;
    if (upgrade && !FINAL.has(e.state)) upgrade = false;
    if (e.inflight) { if (upgrade) e.wantDeep = true; return; }
    e.upgrade = !!upgrade;
    if (!upgrade) setState(e, 'queued');
    e.queuedAt = Date.now();
    queue.delete(e.key); queue.set(e.key, e);
    while (queue.size > QUEUE_MAX) {
      const [k, old] = queue.entries().next().value;
      queue.delete(k);
      if (!old.upgrade) setState(old, 'stale', 'lots of links at once');
    }
    schedulePump(50);
  }
  function schedulePump(ms) { if (!pumpTimer) pumpTimer = setTimeout(pump, Math.max(0, ms)); }
  function pump() {
    pumpTimer = 0;
    if (paused || dead) return;
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] >= WINDOW) sentAt.shift();
    while (queue.size && sentAt.length < RATE) {
      let pick = null, last = null;
      for (const e of queue.values()) { if (!measured(e, now)) continue; last = e; if (anyVisible(e)) pick = e; }
      pick = pick || last;
      if (!pick) break;
      queue.delete(pick.key);
      if (!isLive(pick)) { if (!pick.upgrade) setState(pick, 'stale'); continue; }
      sentAt.push(now);
      send(pick);
    }
    if (queue.size) schedulePump(sentAt.length < RATE ? 100 : sentAt[0] + WINDOW - Date.now() + 25);
  }
  // Wait for IntersectionObserver's first report (so `deep` is right), at most 1 s (background tabs never report).
  function measured(e, now) {
    if (now - e.queuedAt > 1000) return true;
    for (const it of e.items) if (seen.has(it.el)) return true;
    return false;
  }
  async function send(e) {
    const deep = wantsDeep(e);
    e.inflight = true;
    if (!e.upgrade && e.state !== 'pending') setState(e, 'pending');
    let r, failed = false;
    try { r = await chrome.runtime.sendMessage({ t: 'precheck', url: e.url, deep }); } catch { failed = true; }
    e.inflight = false;
    if (cache.get(e.key) !== e || paused) return; // refreshed / switched off meanwhile
    if (failed && !chrome.runtime?.id) return goDead();
    if (failed && !e.retried) { e.retried = true; return later(e, 4000); }
    if (!r || typeof r !== 'object' || !STATES.has(r.state)) {
      if (e.upgrade) { e.upgrade = false; return; } // keep the earlier verdict
      return setState(e, 'unknown', "ClickSafe couldn't check it");
    }
    if (r.state === 'off') return goOff();
    if (r.state === 'pending') {
      if (++e.polls > POLL_MAX) { if (e.upgrade) { e.upgrade = false; return; } return setState(e, 'unknown', 'the check took too long'); }
      return later(e, Math.min(30000, Math.max(250, Number(r.retryMs) || 1500)));
    }
    e.polls = 0; e.retried = false; e.upgrade = false;
    if (deep) e.sentDeep = true;
    setState(e, r.state, r.label, r.category, r.finalUrl);
    if (e.wantDeep) { e.wantDeep = false; if (!e.sentDeep && (r.state === 'safe' || r.state === 'caution')) enqueue(e, true); }
  }
  function later(e, ms) { // re-poll (not counted as a new check)
    e.inflight = true;
    e.timer = setTimeout(() => { e.timer = 0; e.inflight = false; if (cache.get(e.key) === e && !paused && !dead) send(e); }, ms);
  }

  // ---------- items: one per link (anchor) or plain-text URL occurrence ----------
  function classify(a, href) {
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    let shown = '';
    if (P.id === 'x' && norm(u.hostname) === 't.co') { const d = xDisplay(a); if (d) { u = d; shown = norm(d.hostname); } }
    u = unwrap(u);
    const host = norm(u.hostname);
    if (!host || isOwn(host)) return null;
    const chat = pageIsChat() || !!a.closest(CTX);
    if (!chat && a.closest(IGNORE)) return null;
    if (!shown) shown = textHost(a);
    const mismatch = !!shown && reg(unTest(shown)) !== reg(unTest(host));
    return { url: u.href, key: keyOf(u), host, shownHost: shown || host, mismatch, chat };
  }
  function handleAnchor(a) {
    if (a.localName !== 'a') return;
    const href = a.getAttribute('href');
    const prev = itemOf.get(a);
    if (prev) { if (prev.href === href) { attachBadge(prev); return; } untrack(prev); }
    else if (skipped.get(a) === href) return;
    const info = href && classify(a, href);
    if (!info) { if (href) skipped.set(a, href); return; }
    skipped.delete(a);
    track({ kind: 'a', node: a, el: a, href, after: null, ...info });
  }
  function processText(t) {
    const data = t.data, prev = textSeen.get(t);
    if (prev && prev.data === data) { prev.items.forEach(attachBadge); return; }
    if (prev) prev.items.forEach(untrack);
    const p = t.parentElement, items = [];
    textSeen.set(t, { data, items });
    if (!p || p.localName === TAG || p.closest(NO_TEXT)) return;
    TEXT_URL.lastIndex = 0;
    for (let m; (m = TEXT_URL.exec(data)) && items.length < 3;) {
      const raw = m[1].replace(/[.,!?:;)\]}'"»]+$/, '');
      const u = textUrl(raw);
      if (!u) continue;
      const host = norm(u.hostname), key = keyOf(u);
      if (isOwn(host) || items.some((i) => i.key === key)) continue;
      items.push({ kind: 'text', node: t, el: p, href: raw, url: u.href, key, host, shownHost: host, mismatch: false, chat: true, after: items.at(-1) || null });
    }
    items.forEach(track);
  }
  function track(it) {
    const e = it.entry = entryFor(it.key, it.url);
    e.items.add(it);
    liveItems.add(it);
    if (it.kind === 'a') itemOf.set(it.node, it);
    let set = elItems.get(it.el);
    if (!set) { elItems.set(it.el, set = new Set()); io.observe(it.el); }
    set.add(it);
    attachBadge(it);
    renderItem(it);
    if (e.state === 'new' || e.state === 'stale') enqueue(e, false);
    else if (e.state === 'queued') { queue.delete(e.key); queue.set(e.key, e); }
  }
  function untrack(it) {
    liveItems.delete(it);
    it.entry.items.delete(it);
    if (it.kind === 'a' && itemOf.get(it.node) === it) itemOf.delete(it.node);
    const set = elItems.get(it.el);
    if (set) { set.delete(it); if (!set.size) { elItems.delete(it.el); io.unobserve(it.el); visible.delete(it.el); } }
    if (it.badge) { it.badge.remove(); badgeItem.delete(it.badge); }
  }

  // ---------- badge: tiny custom element, closed shadow root, inline !important styles ----------
  const RAND = Math.random().toString(36).slice(2, 8);
  const TAG = 'clicksafe-link-' + RAND, LAYER_TAG = 'clicksafe-layer-' + RAND;
  // One precomputed inline !important string: beats any page stylesheet and keeps style work cheap.
  // (No `all:` reset or `contain` on hundreds of hosts: those made style recalc/layerize ~10x slower.)
  const BADGE_STYLE = Object.entries({
    display: 'inline-block', width: '14px', height: '14px', 'min-width': '14px', 'min-height': '14px', 'max-width': '14px', 'max-height': '14px',
    margin: '0 2px 0 4px', padding: '0', border: '0', outline: '0', 'box-shadow': 'none', 'vertical-align': '-2px', 'line-height': '0',
    'font-size': '0', flex: 'none', float: 'none', order: '0', position: 'static', inset: 'auto', 'z-index': 'auto', opacity: '1',
    visibility: 'visible', 'content-visibility': 'visible', 'pointer-events': 'auto', transform: 'none', translate: 'none', scale: 'none',
    rotate: 'none', filter: 'none', 'clip-path': 'none', mask: 'none', 'mix-blend-mode': 'normal', overflow: 'visible', cursor: 'help',
    'user-select': 'none', 'box-sizing': 'content-box', background: 'transparent', animation: 'none', transition: 'none',
  }).map(([k, v]) => `${k}:${v}!important`).join(';');
  const BADGE_SHEET = 'svg{display:block;width:14px;height:14px;overflow:visible}' +
    '.spin{transform-origin:7px 7px;animation:r .9s linear infinite}@keyframes r{to{transform:rotate(1turn)}}' +
    '@media (prefers-reduced-motion:reduce){.spin{animation:none}}';
  let SHEET = null; // shared by every badge's shadow root
  try { SHEET = new CSSStyleSheet(); SHEET.replaceSync(BADGE_SHEET); } catch { SHEET = null; }
  const svg = (b) => `<svg viewBox="0 0 14 14" aria-hidden="true">${b}</svg>`;
  const Q_MARK = '<circle cx="7" cy="7" r="6" fill="none" stroke="#8b95a5" stroke-width="1.3"/><path d="M5.3 5.5a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.6-.9 1.3" fill="none" stroke="#8b95a5" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="10.3" r=".85" fill="#8b95a5"/>';
  const ICONS = {
    safe: svg('<circle cx="7" cy="7" r="6.5" fill="#3ddc97"/><path d="M4.1 7.3l2 2 3.8-4.1" fill="none" stroke="#06140d" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'),
    caution: svg('<path d="M7 1.3l6.1 10.9H.9z" fill="#ffb547" stroke="#ffb547" stroke-width="1.2" stroke-linejoin="round"/><path d="M7 5.2v3.3" stroke="#1d1200" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10.4" r=".9" fill="#1d1200"/>'),
    unsafe: svg('<circle cx="7" cy="7" r="6.5" fill="#ff5d6c"/><rect x="3.2" y="6" width="7.6" height="2" rx=".7" fill="#fff"/>'),
    pending: svg('<circle cx="7" cy="7" r="4.8" fill="none" stroke="#8b95a5" stroke-opacity=".35" stroke-width="1.8"/><path class="spin" d="M7 2.2a4.8 4.8 0 0 1 4.8 4.8" fill="none" stroke="#8b95a5" stroke-width="1.8" stroke-linecap="round"/>'),
    queued: svg('<circle cx="7" cy="7" r="2.6" fill="#8b95a5" fill-opacity=".75"/>'),
    stale: svg(Q_MARK),
    unknown: svg(Q_MARK),
  };
  const STATUS = {
    safe: () => 'Checked: looks safe',
    caution: (l) => 'Caution: ' + (l || 'be careful with this link'),
    unsafe: (l) => 'Unsafe: ' + (l || 'blocked by ClickSafe'),
    pending: () => 'ClickSafe is checking this link…',
    queued: () => 'Waiting to check this link…',
    stale: (l) => 'Not checked yet' + (l ? ` (${l})` : ''),
    unknown: (l) => 'Not checked: ' + (l || "ClickSafe couldn't check it"),
  };
  function important(el, props) { for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important'); }
  const TPL = {};
  let PROTO = null;
  function icon(s) {
    let t = TPL[s];
    if (!t) { t = TPL[s] = document.createElement('template'); t.innerHTML = ICONS[s] || ''; }
    return t.content.cloneNode(true);
  }
  function makeBadge(it) {
    if (!PROTO) { PROTO = document.createElement(TAG); PROTO.setAttribute('style', BADGE_STYLE); PROTO.setAttribute('role', 'img'); }
    const b = PROTO.cloneNode(false); // copies the already-parsed inline style
    let holder = null;
    try {
      const sr = b.attachShadow({ mode: 'closed' });
      if (SHEET) { sr.adoptedStyleSheets = [SHEET]; holder = sr; }
      else { sr.innerHTML = `<style>${BADGE_SHEET}</style><span></span>`; holder = sr.lastChild; }
    } catch { /* attachShadow blocked: aria-label still carries the verdict */ }
    holderOf.set(b, holder);
    badgeItem.set(b, it);
    return b;
  }
  function attachBadge(it) {
    if (!it.badge) it.badge = makeBadge(it);
    const prev = it.after ? it.after.badge : it.node;
    if (!prev || !prev.parentNode || it.badge.previousSibling === prev) return;
    if ((it.moves = (it.moves || 0) + 1) > 40) return; // the page keeps removing it: stop fighting
    prev.after(it.badge);
  }
  function effective(it) {
    const e = it.entry;
    let s = e.state === 'new' ? 'queued' : e.state, label = e.label;
    if (it.mismatch && s !== 'unsafe' && s !== 'caution') { s = 'caution'; label = 'the link text shows a different site'; }
    return [s, label];
  }
  function goesTo(it) {
    const fin = it.entry.finalUrl ? hostOfUrl(it.entry.finalUrl) : '';
    if (fin && stripW(fin) !== stripW(it.shownHost)) return fin;
    return it.mismatch ? it.host : '';
  }
  function describe(it) {
    const [s, label] = effective(it);
    const g = goesTo(it);
    return { s, status: STATUS[s](label), goes: g ? 'Goes to: ' + g : '' };
  }
  function renderItem(it) {
    if (!it.badge) return;
    const d = describe(it);
    const aria = d.status + (d.goes ? '. ' + d.goes : '');
    if (it.shown === d.s && it.aria === aria) return;
    const iconChanged = it.shown !== d.s;
    it.shown = d.s; it.aria = aria;
    it.badge.setAttribute('aria-label', aria);
    const h = holderOf.get(it.badge);
    if (h && iconChanged) h.replaceChildren(icon(d.s));
    if (tipFor && tipItem === it) showTip(it, tipFor);
  }

  // ---------- tooltip + toast layer (top layer popover, closed shadow root) ----------
  const LAYER_PROPS = {
    all: 'initial', position: 'fixed', inset: 'auto', top: '0', left: '0', width: '0', height: '0', margin: '0', padding: '0', border: '0',
    overflow: 'visible', background: 'transparent', display: 'block', opacity: '1', visibility: 'visible', 'pointer-events': 'none',
    'z-index': '2147483647', transform: 'none', filter: 'none', 'clip-path': 'none', contain: 'none', 'color-scheme': 'dark',
  };
  const LAYER_CSS = `:host{all:initial}
.box{position:fixed;left:0;top:0;max-width:min(320px,calc(100vw - 16px));box-sizing:border-box;font:600 12px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  color:#e8ecf3;background:#12151c;border:1px solid #2b3240;border-radius:8px;padding:6px 9px;box-shadow:0 6px 22px rgba(0,0,0,.45);
  pointer-events:none;opacity:0;visibility:hidden;transition:opacity .12s;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;text-align:left}
.box.on{opacity:1;visibility:visible}
.l2{font:500 11.5px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;color:#9aa4b2;margin-top:2px}
.l2:empty{display:none}
.toast{display:flex;gap:7px;align-items:center}
.toast.bad{background:#1d0f13;border-color:#4a222a;color:#ffd7db}
.toast.warn{background:#1d170b;border-color:#4a3812;color:#ffe2b0}
.toast svg{width:14px;height:14px;flex:none}
@media (prefers-reduced-motion:reduce){.box{transition:none}}`;
  let layer = null, tipEl = null, toastEl = null, toastTimer = 0, tipFor = null, tipItem = null;
  function ensureLayer() {
    if (!layer) {
      layer = document.createElement(LAYER_TAG);
      important(layer, LAYER_PROPS);
      layer.setAttribute('popover', 'manual');
      const sr = layer.attachShadow({ mode: 'closed' });
      sr.innerHTML = `<style>${LAYER_CSS}</style><div class="box tip" role="tooltip"><div class="l1"></div><div class="l2"></div></div><div class="box toast" role="status" aria-live="polite"></div>`;
      [tipEl, toastEl] = sr.querySelectorAll('.box');
    }
    const root = document.documentElement;
    if (!root) return false;
    if (!layer.isConnected || root.lastElementChild !== layer) root.appendChild(layer);
    try { if (layer.matches(':popover-open')) layer.hidePopover(); layer.showPopover(); } catch { /* ignore */ }
    return true;
  }
  function place(box, rect, below) {
    const w = box.offsetWidth, h = box.offsetHeight, vw = innerWidth, vh = innerHeight;
    let top = below ? rect.bottom + 6 : rect.top - h - 6;
    if (top < 4) top = rect.bottom + 6;
    if (top + h > vh - 4) top = Math.max(4, rect.top - h - 6);
    const left = Math.min(Math.max(4, rect.left + rect.width / 2 - w / 2), Math.max(4, vw - w - 4));
    box.style.left = left + 'px'; box.style.top = top + 'px';
  }
  function showTip(it, el) {
    if (!el.isConnected || !ensureLayer()) return;
    const d = describe(it);
    tipEl.firstChild.textContent = d.status;
    tipEl.lastChild.textContent = d.goes;
    tipFor = el; tipItem = it;
    tipEl.classList.add('on');
    place(tipEl, (it.badge?.isConnected ? it.badge : el).getBoundingClientRect(), false);
  }
  function hideTip() { tipFor = null; tipItem = null; tipEl?.classList.remove('on'); }
  function toast(el, kind, text, ms) {
    if (!ensureLayer()) return;
    hideTip();
    toastEl.className = 'box toast on ' + kind;
    toastEl.innerHTML = kind === 'bad' ? ICONS.unsafe : ICONS.caution;
    toastEl.append(document.createTextNode(text));
    place(toastEl, el.getBoundingClientRect(), true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
  }

  // ---------- clicks: block unsafe, confirm caution (capture phase, window level) ----------
  function anchorFrom(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (let i = 0; i < path.length && i < 25; i++) { const n = path[i]; if (n && n.localName === 'a' && n.hasAttribute?.('href')) return n; }
    return null;
  }
  function itemForAnchor(a) {
    let it = itemOf.get(a);
    if (!it && !paused && !dead && skipped.get(a) !== a.getAttribute('href')) { handleAnchor(a); it = itemOf.get(a); }
    return it || null;
  }
  function stop(e) { e.preventDefault(); e.stopImmediatePropagation(); }
  function onActivate(e) {
    if (!e.isTrusted || paused) return;
    if (e.type === 'keydown' && (e.key !== 'Enter' || e.repeat)) return;
    if (e.type === 'auxclick' && e.button !== 1) return;
    const a = anchorFrom(e);
    const it = a && itemForAnchor(a);
    if (!it) return;
    const [s, label] = effective(it);
    if (s === 'unsafe') { stop(e); toast(a, 'bad', 'ClickSafe blocked this link: ' + (label || 'unsafe'), 3500); return; }
    if (s !== 'caution' || e.type === 'dragstart') return;
    const now = Date.now(), k = it.entry.key;
    if ((armed.get(k) || 0) > now) { if (e.type !== 'keydown') armed.delete(k); return; } // second click: let it open
    stop(e);
    armed.set(k, now + ARM_MS);
    toast(a, 'warn', 'Click again to open (it will still be checked)', ARM_MS);
  }
  for (const t of ['click', 'auxclick', 'keydown', 'dragstart']) window.addEventListener(t, onActivate, true);

  // Hover / focus: tooltip on the badge always; on the link itself when there is something to say.
  const worthTip = (it) => { const d = describe(it); return d.goes || d.s === 'unsafe' || d.s === 'caution'; };
  window.addEventListener('pointerover', (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (t.localName === TAG) { const it = badgeItem.get(t); if (it) showTip(it, t); return; }
    const a = t.closest('a[href]'), it = a && itemOf.get(a);
    if (it && worthTip(it)) showTip(it, a);
  }, true);
  window.addEventListener('pointerout', (e) => {
    if (tipFor && (e.target === tipFor || tipFor.contains(e.target)) && !(e.relatedTarget && tipFor.contains(e.relatedTarget))) hideTip();
  }, true);
  window.addEventListener('focusin', (e) => { const a = anchorFrom(e), it = a && itemOf.get(a); if (it && worthTip(it)) showTip(it, a); }, true);
  window.addEventListener('focusout', () => { if (tipFor && tipFor.localName === 'a') hideTip(); }, true);
  window.addEventListener('scroll', () => { if (tipFor) hideTip(); }, { capture: true, passive: true });

  // ---------- visibility ----------
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const el = en.target;
      seen.add(el);
      if (!en.isIntersecting) { visible.delete(el); continue; }
      visible.add(el);
      for (const it of elItems.get(el) || []) {
        const e = it.entry;
        if (e.state === 'stale') enqueue(e, false);
        else if (!it.chat || e.sentDeep) continue;
        else if (e.inflight) e.wantDeep = true;
        else if (e.state === 'safe' || e.state === 'caution') enqueue(e, true); // seen in chat now: ask for the deep check
      }
    }
  });

  // ---------- DOM watching: only added nodes, batched in idle time ----------
  let work = [], textWork = [];
  const reattach = new Set(), hrefChanged = new Set();
  let scheduled = false;
  function schedule() { if (!scheduled) { scheduled = true; requestIdleCallback(runWork, { timeout: 120 }); } }
  const isOurs = (n) => n.localName === TAG || n.localName === LAYER_TAG;
  const mo = new MutationObserver((muts) => {
    if (paused || dead) return;
    for (const m of muts) {
      if (m.type === 'attributes') { if (m.target.localName === 'a') hrefChanged.add(m.target); continue; }
      for (const n of m.addedNodes) if ((n.nodeType === 1 && !isOurs(n)) || (n.nodeType === 3 && n.data.length > 3)) work.push(n);
      for (const n of m.removedNodes) if (n.nodeType === 1 && n.localName === TAG) { const it = badgeItem.get(n); if (it && liveItems.has(it)) reattach.add(it); }
    }
    schedule();
  });
  function runWork(deadline) {
    scheduled = false;
    if (paused || dead) { work = []; textWork = []; return; }
    const end = performance.now() + (deadline.didTimeout ? 8 : Math.min(15, Math.max(4, deadline.timeRemaining())));
    for (const it of reattach) if (it.node.isConnected && liveItems.has(it)) attachBadge(it);
    reattach.clear();
    for (const a of hrefChanged) if (a.isConnected) handleAnchor(a);
    hrefChanged.clear();
    let i = 0;
    for (; i < work.length && (i & 15 || performance.now() < end); i++) processNode(work[i]);
    work = i >= work.length ? [] : work.slice(i);
    let j = 0;
    for (; j < textWork.length && (j & 7 || performance.now() < end); j++) walkText(textWork[j]);
    textWork = j >= textWork.length ? [] : textWork.slice(j);
    if (work.length || textWork.length) schedule();
  }
  function processNode(n) {
    if (!n.isConnected) return;
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (p && !isOurs(p) && QUICK.test(n.data) && (pageIsChat() || p.closest(CTX))) processText(n);
      return;
    }
    if (n.localName === 'a') handleAnchor(n);
    else if (n.firstElementChild) {
      const as = n.getElementsByTagName('a');
      if (as.length > 200) for (const a of as) work.push(a); // huge subtree (SPA navigation): spread over idle slices
      else for (let k = 0; k < as.length; k++) handleAnchor(as[k]);
    }
    if (pageIsChat() || n.closest(CTX)) textWork.push(n);
    else if (n.firstElementChild) for (const c of n.querySelectorAll(CTX)) textWork.push(c);
  }
  function walkText(root) {
    if (!root.isConnected) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.data.length > 3 && QUICK.test(t.data)) processText(t);
  }
  function fullScan() {
    const root = document.documentElement;
    if (!root) return;
    for (const a of root.getElementsByTagName('a')) work.push(a);
    if (pageIsChat()) { if (document.body) textWork.push(document.body); }
    else for (const c of root.querySelectorAll(CTX)) textWork.push(c);
    schedule();
  }

  // Housekeeping: forget links whose messages scrolled out of chat; put back badges the page dropped.
  setInterval(() => {
    if (paused || dead) return;
    requestIdleCallback(() => {
      for (const it of liveItems) {
        if (!it.node.isConnected) untrack(it);
        else if (it.badge && !it.badge.isConnected) attachBadge(it);
      }
      for (const [k, e] of queue) if (!isLive(e)) { queue.delete(k); if (!e.upgrade) e.state = 'stale'; }
    }, { timeout: 2000 });
  }, 7000);

  // ---------- lifecycle ----------
  function clearAll() {
    for (const e of cache.values()) clearTimeout(e.timer);
    cache.clear(); queue.clear(); armed.clear();
    clearTimeout(pumpTimer); pumpTimer = 0;
  }
  function goOff() { // ClickSafe is switched off: no badges, no checks, until a refresh
    paused = true;
    clearAll();
    for (const it of [...liveItems]) untrack(it);
    itemOf = new WeakMap(); skipped = new WeakMap(); textSeen = new WeakMap();
    work = []; textWork = [];
    hideTip(); toastEl?.classList.remove('on');
  }
  function goDead() { // extension reloaded: this script can't talk to it any more
    if (dead) return;
    dead = true;
    mo.disconnect();
    clearTimeout(pumpTimer);
    for (const e of cache.values()) {
      clearTimeout(e.timer);
      if (!FINAL.has(e.state)) setState(e, 'unknown', 'ClickSafe was updated, reload this page');
    }
    queue.clear();
  }
  function refresh() {
    if (dead) return;
    if (paused) { paused = false; clearAll(); fullScan(); return; }
    clearAll();
    const fresh = new Set();
    for (const it of [...liveItems]) {
      if (!it.node.isConnected) { untrack(it); continue; }
      const e = entryFor(it.key, it.url);
      it.entry = e; e.items.add(it); fresh.add(e);
    }
    for (const e of fresh) { if (anyVisible(e)) enqueue(e, false); else setState(e, 'stale'); }
  }
  try {
    chrome.runtime.onMessage.addListener((m) => { if (m && m.t === 'chatguard:refresh') refresh(); });
  } catch { /* ignore */ }

  mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  fullScan();
})();
