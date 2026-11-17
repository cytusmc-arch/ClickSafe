// Settings + small URL helpers shared by the service worker and extension pages.

export const DEFAULT_TRUSTED = [
  'tiktok.com', 'twitch.tv', 'youtube.com', 'youtu.be', 'kick.com', 'google.com',
  'wikipedia.org', 'github.com', 'discord.com', 'streamlabs.com', 'streamelements.com',
  'obsproject.com', 'spotify.com', 'microsoft.com', 'live.com', 'apple.com', 'amazon.com',
  'chatgpt.com', 'claude.ai', 'clicksafe.pages.dev',
];

// One-click suggestions on the settings page (not allowed until the user adds them).
export const SUGGESTED_SITES = [
  'instagram.com', 'x.com', 'reddit.com', 'facebook.com', 'roblox.com', 'epicgames.com', 'steampowered.com',
  'steamcommunity.com', 'minecraft.net', 'fortnite.com', 'medal.tv', 'streamable.com', 'fandom.com',
  'netflix.com', 'twitter.com', 'linkedin.com', 'pinterest.com',
];

// User-content hosts under trusted domains: anyone can publish there, so they are always checked.
export const NEVER_TRUST = [
  'sites.google.com', 'docs.google.com', 'drive.google.com', 'forms.gle', 'groups.google.com', 'books.google.com',
  'onedrive.live.com', 'gist.github.com', 'clips.twitch.tv',
];

// Free, anonymous default: OVHcloud AI Endpoints. No key, no signup, limited per IP
// (2 req/min per model). Every model below accepts images; ClickSafe rotates through them.
export const OVH_BASE = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';
export const OVH_MODELS = ['Mistral-Small-3.2-24B-Instruct-2506', 'Qwen3.6-27B', 'Qwen2.5-VL-72B-Instruct', 'Qwen3.8-27B', 'Qwen3.5-397B-A17B', 'Qwen3.5-9B'];
// Extra keyless specialists on the same anonymous endpoint (each model has its own per-IP limit).
export const OVH_TEXT_MODELS = ['gpt-oss-120b', 'Meta-Llama-3_3-70B-Instruct', 'gpt-oss-20b']; // script / malware analyst
export const OVH_GUARD_MODELS = ['Qwen3Guard-Gen-8B', 'Qwen3Guard-Gen-0.6B'];                  // text safety classifier
export const OVH_WHISPER = 'whisper-large-v3-turbo';                                           // audio transcription
// Sealed remote browser: Jina Reader renders the link on its own servers (keyless, ~20 req/min per IP).
export const SEALED_BASE = 'https://r.jina.ai/';

// Presets for "use my own endpoint" (all OpenAI-compatible /chat/completions).
export const AI_PRESETS = [
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1' },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1' },
  { id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', name: 'Mistral', base: 'https://api.mistral.ai/v1' },
  { id: 'ovh-key', name: 'OVHcloud (with key)', base: OVH_BASE },
  { id: 'other', name: 'Other (OpenAI-compatible)', base: '' },
];

export const DEFAULTS = {
  enabled: true,
  lockdown: true,   // guideline-breaking pages can't be revealed, allowed or opened anyway from the page
  watchMedia: true, // after a page is shown, new images/videos stay blurred until checked
  aiEnabled: true,
  customAi: false,  // off = the free anonymous OVHcloud scanner
  customPreset: 'openrouter',
  customBase: '',
  customKey: '',
  customModels: [],
  sendImages: true,
  strict: true,
  holdAfterMs: 6000,
  aiTimeoutMs: 30000,
  // Deep scan
  sealed: true,        // open untrusted links in a sealed remote browser first (your PC never touches them until cleared)
  timeWarpMin: 7,      // fast-forward page timers this many minutes while hidden (0 = off)
  playMedia: true,     // press play on videos and sample frames across the whole timeline
  deepScripts: true,   // read every script (incl. code generated at runtime) for malware, drainers, IP grabbers
  localModel: true,    // on-device NSFW model screens every image and video frame
  listenAudio: true,   // transcribe video audio and check it for slurs / explicit speech
  textGuard: true,     // dedicated safety model double-checks page text
  secondOpinion: true, // a second vision model must agree when signals are mixed
  // Protection extras
  clipboardGuard: true,  // never let an unchecked site put commands on your clipboard ("verify you're human" malware)
  blockPrompts: true,    // deny camera / mic / location / notification / fullscreen-lock prompts on unchecked sites
  blockIpLookups: true,  // stop unchecked sites from looking up your IP or sending data to webhooks
  blockDownloads: true,  // cancel risky downloads (exe, scripts, disk images...) from unchecked sites
  safeSearch: true,      // force SafeSearch on Google, Bing, DuckDuckGo, Yahoo, Brave
  ytRestrict: 'moderate', // YouTube Restricted Mode: 'off' | 'moderate' | 'strict'
  threatFeeds: true,     // live phishing / malware feeds
  domainAge: true,       // flag domains registered in the last few weeks
  chatGuard: true,       // badge links in Twitch / YouTube / Kick / TikTok / X / Discord chat before you click
  activityLog: true,     // keep a local log of what was checked
  cats: { adult: true, gore: true, gambling: true, iplogger: true },
  trusted: DEFAULT_TRUSTED,
  blocked: [],
};

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings, cats: { ...DEFAULTS.cats, ...(settings.cats || {}) } };
  // Effective AI endpoint (never stored): anonymous default unless the user switched to their own.
  const custom = s.customAi && /^https:\/\/[^/\s]+/i.test(s.customBase || '') && (s.customModels || []).length;
  s.apiBase = custom ? s.customBase.replace(/\/+$/, '') : OVH_BASE;
  s.apiKey = custom ? String(s.customKey || '') : '';
  s.models = custom ? s.customModels : OVH_MODELS;
  s.aiProvider = custom ? 'custom' : 'anonymous';
  return s;
}

export async function saveSettings(patch) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const next = { ...settings, ...patch };
  for (const k of ['apiBase', 'apiKey', 'models', 'aiProvider']) delete next[k];
  await chrome.storage.local.set({ settings: next });
  return getSettings();
}

export function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

export function inList(host, list) {
  return !!host && list.some((d) => host === d || host.endsWith('.' + d));
}

export function matchIn(host, list) {
  return list.find((d) => host === d || host.endsWith('.' + d)) || '';
}

export function isPrivateHost(h) {
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '[::1]' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

// "https://www.Example.com/x" -> "example.com"; returns '' when not a usable domain.
export function normDomain(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return '';
  if (/[/:]/.test(s)) s = hostOf(s.includes('://') ? s : 'https://' + s);
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && s.length <= 253 ? s : '';
}
