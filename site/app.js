'use strict';
(() => {
  const $ = (id) => document.getElementById(id);

  // ----- browser-aware extensions URL -----
  const ua = navigator.userAgent;
  let ext = 'chrome://extensions';
  if (/Edg\//.test(ua)) ext = 'edge://extensions';
  else if (/OPR\//.test(ua)) ext = 'opera://extensions';
  else if (navigator.brave) ext = 'brave://extensions';
  $('extUrl').textContent = ext;

  const toast = $('toast');
  let tt = 0;
  const say = (parts, ms = 6000) => {
    toast.replaceChildren(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : Object.assign(document.createElement('b'), { textContent: p.b }))));
    toast.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => toast.classList.remove('on'), ms);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(ext); return true; } catch { return false; } };

  const copyBtn = $('copyBtn');
  copyBtn.addEventListener('click', async () => {
    const ok = await copy();
    copyBtn.textContent = ok ? 'Copied' : 'Select it';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1600);
  });

  for (const a of document.querySelectorAll('a.dl')) a.addEventListener('click', async () => {
    const ok = await copy();
    say(ok ? ['Downloading… ', { b: ext }, ' is copied. Paste it into a new tab for step 2.'] : ['Downloading… then follow the 3 steps below.']);
    setTimeout(() => $('install').scrollIntoView({ behavior: 'smooth' }), 350);
    const steps = ['st1', 'st2', 'st3'].map($);
    steps.forEach((s, i) => setTimeout(() => { steps.forEach((x) => x.classList.remove('lit')); s.classList.add('lit'); }, 900 + i * 1400));
  });

  // ----- hero demo loop -----
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scenes = ['sLive', 'sShield', 'sBlocked', 'sSafe'];
  const show = (id) => scenes.forEach((s) => $(s).classList.toggle('on', s === id));
  const cur = $('cur');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (n, c) => { $('d' + n).className = c; };
  const CASES = [
    { link: 'free-skins.gift/claim', host: 'free-skins.gift', bad: 'a scam', who: 'n0tabot', cls: 'u4', msg: 'omg look at this ' },
    { link: 'patchnotes.gg/season-4', host: 'patchnotes.gg', bad: null, who: 'dex', cls: 'u2', msg: 'new patch notes are out ' },
  ];
  function setMsg(c) {
    const b = Object.assign(document.createElement('b'), { className: c.cls, textContent: c.who });
    const l = Object.assign(document.createElement('span'), { className: 'lnk', id: 'lnk', textContent: c.link });
    $('msg').replaceChildren(b, document.createTextNode(' ' + c.msg), l);
  }
  async function loop() {
    for (let i = 0; ; i = (i + 1) % CASES.length) {
      const c = CASES[i];
      setMsg(c);
      $('dTitle').textContent = 'Going LIVE · 2.4K watching'; $('dTab').style.setProperty('--fav', '#ff3b5c');
      $('dUrl').textContent = 'live.example/yourchannel';
      show('sLive');
      cur.style.left = '30%'; cur.style.top = '40%';
      await wait(900);
      const lnk = $('lnk'), vp = lnk.closest('.viewport').getBoundingClientRect(), r = lnk.getBoundingClientRect();
      cur.style.left = ((r.left + r.width * 0.4 - vp.left) / vp.width * 100) + '%';
      cur.style.top = ((r.top + r.height * 0.55 - vp.top) / vp.height * 100) + '%';
      await wait(1000);
      lnk.classList.add('hot'); cur.classList.add('click'); await wait(140); cur.classList.remove('click');
      await wait(250);
      cur.style.left = '110%';
      $('dHost').textContent = c.host; $('dUrl').textContent = c.link;
      $('dTitle').textContent = 'Checking… · ClickSafe'; $('dTab').style.setProperty('--fav', '#3ddc97');
      step(1, 'a'); step(2, ''); step(3, '');
      show('sShield');
      await wait(650); step(1, 'ok'); step(2, 'a');
      await wait(650); step(2, 'ok'); step(3, 'a');
      await wait(1100); step(3, 'ok');
      await wait(250);
      if (c.bad) { $('dCat').textContent = c.bad; $('dTitle').textContent = 'Blocked · ClickSafe'; show('sBlocked'); }
      else { $('dTitle').textContent = 'Season 4 map changes, explained'; $('dTab').style.setProperty('--fav', '#b4552d'); show('sSafe'); }
      await wait(2600);
    }
  }
  if (!reduce) loop(); else { show('sShield'); step(1, 'ok'); step(2, 'ok'); step(3, 'a'); }
})();
