# ClickSafe — Stream Link Shield

A Chrome extension for streamers. When you click a link, or a page redirects you, ClickSafe checks it **before your stream sees it** and keeps anything against TikTok, Twitch, YouTube or Instagram guidelines off screen. You don't paste links anywhere; it works automatically on every click and every redirect.

Free, no account, no API key. Website and download: **https://clicksafe.pages.dev**

## How a link is checked

1. **Link & threat check.** Look-alike domains, known adult, gore, gambling and IP-logger sites, public phishing and malware feeds, and domain age.
2. **Sealed preview.** Before an unchecked site loads, it is opened in a sealed remote browser ([Jina Reader](https://jina.ai/reader/)) and screenshotted. Your PC never touches it, and every redirect hop is followed. Login and token links are skipped to keep your accounts private.
3. **Hidden real check.** The page then loads behind a shield, blurred and muted, and ClickSafe:
   - presses Play on videos and samples frames across the whole video;
   - fast-forwards the page's timers (7 minutes by default), so "normal for a minute, then surprise" tricks show up during the check;
   - reads every script, including hidden and runtime-generated code;
   - reads every image, including hidden ones, CSS backgrounds, images only referenced in code, and images inside embedded frames.
4. **Several models.**
   - An on-device image model (nudity and gore, nothing leaves your PC).
   - A vision AI verdict, plus a second opinion from a different model when signals are mixed.
   - A safety model on the page text.
   - Speech-to-text on the start of videos.
   - A script analyst.
5. **Verdict.** The page is shown, kept hidden, or blocked. Lockdown mode (on by default) means guideline-breaking pages can't be revealed.

It catches NSFW and gore, malware, ClickFix / fake "verify you're human" pages, IP grabbers and webhook data theft, crypto drainers and miners, browser lockers, tech-support scams and phishing.

### While you browse

- **Clipboard guard:** pages can't put commands on your clipboard.
- **IP grabbers:** IP-lookup and Discord/Telegram webhook requests are blocked.
- **Downloads:** program and script downloads from unchecked sites are cancelled.
- **Prompts:** camera, mic, location and notification prompts are denied.
- **Traps:** keyboard-lock and fullscreen traps are blocked.
- **Search:** SafeSearch is forced on Google, Bing, DuckDuckGo, Yahoo and Brave, and YouTube Restricted Mode is enabled.
- **Chat badges:** links in Twitch, Kick, YouTube, TikTok, X and Discord chat get safe, caution or unsafe badges.
- **Panic button:** **Alt+Shift+X** covers and mutes the page instantly.
- **Right-click check:** right-click any link and choose "Check this link with ClickSafe" to check it without opening it.

## Privacy

What leaves your computer, and where it goes:

| What | Where | When |
|---|---|---|
| The link you open | Jina Reader (`r.jina.ai`) | Sealed preview of unchecked sites (not login/token links) |
| Page text, a few images or screenshots, script excerpts | OVHcloud AI Endpoints (anonymous, no key) | AI checks of unchecked sites |
| The first seconds of a video's audio | OVHcloud Whisper | Only if the page has a direct video file |
| The domain name | The registry's RDAP server | Domain-age check |
| Nothing | — | The on-device image model, threat feeds (downloaded lists), and sites on your allowed list |

You can turn each of these off in the options. You can also point the AI at your own OpenAI-compatible endpoint.

## Install

**From a release:** download `clicksafe.zip` from the [website](https://clicksafe.pages.dev) and unzip it. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.

**From source:** load the `extension/` folder the same way.

## Develop

```
extension/        the extension (Manifest V3, no build step)
  background.js   service worker: rules, checks, verdicts
  guard.js        page-world guard: timers, clipboard, network, prompts
  shield.js       the overlay that hides the page while it is checked
  collect.js      gathers images, scripts and video frames
  preflight.*     the sealed-preview page shown before a link loads
  chatguard.js    chat link badges
  offscreen.js    on-device model and video sampling (lab/)
  lib/            heuristics, AI, script scanner, threat intel
site/             website (Cloudflare Pages)
tools/build.py    builds site/clicksafe.zip from extension/
tools/test/       Playwright end-to-end tests
```

```bash
python tools/build.py
cd tools/test && npm install && npx playwright install chromium
node run.mjs          # end-to-end: fake sites on *.test, real AI calls
node intel.mjs        # threat feeds and domain age
node chatguard.mjs    # chat link badges
node medialab.mjs     # on-device model, contact sheets, video frames
node site-check.mjs   # website CSP, layout and console errors
```

The free AI tier allows about 2 requests per minute per model, so running the end-to-end suite twice in a row can make checks wait for a free slot.

## Credits

- Image model: [image-safety-classifier-xs](https://huggingface.co/OwenElliott/image-safety-classifier-xs) by Owen Elliott (MIT). It was converted for TensorFlow.js; see `extension/vendor/LICENSES.md`.
- [TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache-2.0).
- Threat feeds, downloaded at runtime and not bundled: [malware-filter](https://gitlab.com/malware-filter) phishing-filter and urlhaus-filter by curbengh (CC BY-SA 4.0, built from PhishTank, OpenPhish, PhishStats and abuse.ch URLhaus), and [SinkingYachts](https://phish.sinking.yachts).
- AI: [OVHcloud AI Endpoints](https://endpoints.ai.cloud.ovh.net) and [Jina Reader](https://jina.ai/reader/).
- Fonts on the website: Bricolage Grotesque and Geist (SIL Open Font License).

## Licence

ClickSafe is free software under the [GNU General Public License v3.0](LICENSE). You can use, study, share and change it. If you distribute a modified version, you must publish its source under the same licence.

Third-party files keep their own licences; see `extension/vendor/LICENSES.md`.
