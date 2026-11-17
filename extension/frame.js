// Runs in embedded frames (ads, players, widgets) of pages that are being checked. When the background
// asks, it reports what the frame shows: images, sampled video frames, scripts and a bit of text, so
// content hidden inside an iframe is checked like the rest of the page.
(() => {
  'use strict';
  if (window.top === window || window.__clickSafeFrame) return;
  Object.defineProperty(window, '__clickSafeFrame', { value: true });
  chrome.runtime.onMessage.addListener((m, snd, reply) => {
    if (m?.t !== 'frame:collect' || snd.id !== chrome.runtime.id || snd.tab) return false; // only the service worker
    (async () => {
      const C = globalThis.ClickSafeCollect;
      if (!C) return reply(null);
      const r = document.documentElement.getBoundingClientRect();
      const out = {
        url: location.href,
        area: Math.round((innerWidth || r.width) * (innerHeight || r.height)),
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
        images: C.gatherImages({ max: 30, snaps: 6 }),
        embeds: C.embeds(),
        scripts: m.scripts ? C.gatherScripts({ maxInline: 120_000 }) : null,
        videos: m.play ? await C.sampleVideos({ max: 1, budgetMs: 6000 }) : [],
      };
      reply(out);
    })().catch(() => reply(null));
    return true;
  });
})();
