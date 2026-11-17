// Static analysis of everything a page runs: external script files, inline <script> blocks and code the
// page generated at runtime (eval / new Function / string timers / document.write, captured by guard.js).
// Finds the techniques behind "verify you're human" clipboard malware, crypto miners, wallet drainers,
// IP grabbers and data exfiltration, browser lockers, auto-downloads and heavy obfuscation.
// Also pulls out image / video URLs that only exist inside code, so they get checked too.

// severity: critical = block on its own · high = keep hidden · medium = needs a second look · low = note
const RULES = [
  // Clipboard hijacking ("ClickFix"): copy a command, then tell the user to press Win+R and paste it.
  { id: 'clip-cmd', sev: 'high', cat: 'malware', desc: 'Puts a system command on the clipboard',
    all: [/navigator\.clipboard\.write(Text)?\s*\(|execCommand\(\s*['"]copy|clipboardData\.setData\s*\(/, /\b(powershell|pwsh|mshta|cmd(\.exe)?\s*\/[ck]|iex\s*\(|invoke-(expression|webrequest|restmethod)|frombase64string|certutil(\.exe)?\s+-urlcache|bitsadmin\s+\/transfer|rundll32|regsvr32|wscript|cscript|msiexec\s+\/[iq]|curl\s+-[a-z]*\s*https?:\S+\s*\|\s*(ba|z)?sh)/i] },
  { id: 'fake-captcha', sev: 'high', cat: 'malware', desc: 'Fake "verify you are human" check with Run-dialog instructions',
    all: [/(win(dows)?\s*(key)?\s*\+\s*r|windows\s+key\s*\+|run\s+dialog|\\u229e|⊞)/i, /(ctrl|control)\s*\+\s*v|paste/i, /(verif|captcha|robot|human)/i] },

  // Crypto miners.
  { id: 'miner', sev: 'critical', cat: 'malware', desc: 'Browser crypto miner',
    any: [/coinhive|coin-hive|cryptonight|crypto-?loot|coinimp|webminepool|minero\.cc|deepminer|jsecoin|monerise|webmine\.cz|ppoi\.org|projectpoi|authedmine|CH\.Anonymous|stratum\+tcp:\/\/|\bminer\.start\s*\(|cryptonight_hash/i] },

  // Wallet drainers.
  { id: 'drainer-kit', sev: 'critical', cat: 'scam', desc: 'Known crypto wallet-drainer kit',
    any: [/\b(inferno|pink|angel|venom|monkey|ace|ms|medusa|atomic)\s*drainer\b|drainer[_\s-]?(kit|v\d|config|panel)|seaport.{0,200}setApprovalForAll/i] },
  { id: 'drainer-approve', sev: 'high', cat: 'scam', desc: 'Asks your wallet to approve transfers of all your tokens/NFTs',
    all: [/setApprovalForAll|increaseAllowance|transferFrom|PermitBatch|PermitSingle|eth_signTypedData(_v4)?/, /ethereum\.request|eth_requestAccounts|wallet_requestPermissions|WalletConnect|web3modal/i] },

  // IP grabbing and exfiltration.
  { id: 'webhook-exfil', sev: 'critical', cat: 'malware', desc: 'Sends data to a hidden Discord webhook',
    any: [/discord(app)?\.com\/api\/webhooks\/\d{5,}\/[\w-]{20,}/i] },
  { id: 'telegram-exfil', sev: 'critical', cat: 'malware', desc: 'Sends data to a hidden Telegram bot',
    any: [/api\.telegram\.org\/bot\d{6,}:[\w-]{30,}/i] },
  { id: 'ip-lookup', sev: 'medium', cat: 'ip_logger', desc: 'Looks up the visitor\'s IP address',
    any: [/(api(64)?\.ipify\.org|ipinfo\.io|ip-api\.com|ipapi\.co|ipwho\.is|ipwhois\.app|ifconfig\.me|icanhazip\.com|checkip\.amazonaws\.com|api\.myip\.com|geolocation-db\.com|freegeoip\.app|extreme-ip-lookup\.com|ipdata\.co|api\.ip\.sb|ipgeolocation\.io|ipregistry\.co|wtfismyip\.com|myexternalip\.com|ident\.me|ipecho\.net|ip\.seeip\.org|api\.bigdatacloud\.net|iplogger\.|grabify\.)/i] },
  { id: 'webrtc-ip', sev: 'medium', cat: 'ip_logger', desc: 'Uses WebRTC to discover the visitor\'s IP address',
    all: [/RTCPeerConnection/, /stun:|turn:/i, /onicecandidate|icecandidate/, /candidate/] },
  { id: 'cred-exfil', sev: 'critical', cat: 'phishing', desc: 'Sends typed passwords to a third party',
    all: [/(password|passwd|pwd|seed ?phrase|mnemonic|private ?key)/i, /(api\.telegram\.org|discord(app)?\.com\/api\/webhooks|formspree\.io|ngrok|pipedream|webhook\.site)/i] },

  // Browser lockers / tech-support scams.
  { id: 'kb-lock', sev: 'high', cat: 'scam', desc: 'Tries to lock your keyboard (scareware)', any: [/navigator\.keyboard\.lock\s*\(/] },
  { id: 'history-flood', sev: 'high', cat: 'scam', desc: 'Floods history so the back button stops working',
    any: [/(for|while)\s*\([^)]{0,60}\)\s*\{?[^}]{0,120}history\.pushState/] },
  { id: 'locker', sev: 'medium', cat: 'scam', desc: 'Forces fullscreen and blocks leaving the page',
    all: [/requestFullscreen|webkitRequestFullscreen/, /onbeforeunload|beforeunload/, /\balert\s*\(|\bconfirm\s*\(/] },
  { id: 'tech-scam', sev: 'high', cat: 'scam', desc: 'Fake virus / tech-support warning',
    any: [/(call|contact)\s+(microsoft|windows|apple)\s+(support|technician|helpline)|your (computer|pc|device) (has been|is) (blocked|locked|infected|hacked)|error\s*#?\s*dw6vb36|toll[ -]free.{0,40}(support|microsoft)/i] },

  // Auto-downloads of programs.
  { id: 'auto-download', sev: 'high', cat: 'malware', desc: 'Starts a program download by itself',
    any: [/\.download\s*=\s*['"`][^'"`]{0,80}\.(exe|scr|msi|msix|bat|cmd|ps1|vbs|vbe|js|jse|hta|lnk|jar|apk|iso|img|vhdx?|dll|reg|cpl)['"`]/i, /data:application\/(x-msdownload|x-msdos-program|x-ms-installer|hta)/i] },
  { id: 'blob-download', sev: 'medium', cat: 'malware', desc: 'Builds a file in the page and downloads it',
    all: [/new\s+Blob\s*\(/, /createObjectURL/, /\.download\s*=/, /\.click\s*\(\s*\)/, /octet-stream|x-msdownload|application\/zip/i] },

  // Obfuscation (common in malware, sometimes in ads).
  { id: 'packer', sev: 'medium', cat: 'malware', desc: 'Packed / self-decoding code', any: [/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/] },
  { id: 'decode-exec', sev: 'medium', cat: 'malware', desc: 'Decodes hidden code and runs it',
    any: [/(eval|Function|setTimeout|setInterval)\s*\(\s*(window\.)?(atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/, /document\.write\s*\(\s*(unescape|atob)\s*\(/] },
  { id: 'keylogger', sev: 'medium', cat: 'phishing', desc: 'Records keystrokes and sends them away',
    all: [/addEventListener\(\s*['"]key(down|press|up)['"]/, /sendBeacon|new\s+WebSocket|XMLHttpRequest|fetch\s*\(/, /\.key\b|keyCode|which/] },
  { id: 'notify-spam', sev: 'low', cat: 'scam', desc: 'Asks to send you notifications', any: [/Notification\.requestPermission|pushManager\.subscribe/] },
];

const CAP_PER_SCRIPT = 600_000;
const sevRank = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

function snippet(text, re) {
  const m = re.exec(text);
  if (!m) return '';
  const a = Math.max(0, m.index - 70), b = Math.min(text.length, m.index + m[0].length + 70);
  return text.slice(a, b).replace(/\s+/g, ' ').slice(0, 240);
}

function obfuscationScore(text) {
  const t = text.slice(0, 200_000);
  const hexIds = (t.match(/_0x[0-9a-f]{4,6}/g) || []).length;
  const esc = (t.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/gi) || []).length;
  const longB64 = /['"`][A-Za-z0-9+/=]{12000,}['"`]/.test(t);
  return { hexIds, escDensity: esc / Math.max(1, t.length / 4), longB64 };
}

// scripts: [{ src: 'https://…/x.js' | 'inline #3' | 'runtime eval', text }]
export function scanScripts(scripts, pageText = '') {
  const findings = [];
  const seen = new Set();
  for (const sc of scripts) {
    const text = String(sc.text || '').slice(0, CAP_PER_SCRIPT);
    if (!text) continue;
    for (const r of RULES) {
      const hit = r.any ? r.any.find((re) => re.test(text)) : r.all.every((re) => re.test(text)) ? r.all[0] : null;
      if (!hit) continue;
      const key = r.id + '|' + sc.src;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ id: r.id, sev: r.sev, cat: r.cat, desc: r.desc, src: String(sc.src || '').slice(0, 160), snippet: snippet(text, new RegExp(hit.source, hit.flags.replace('g', ''))) });
    }
    const o = obfuscationScore(text);
    if (o.hexIds > 300 || o.escDensity > 0.25) {
      findings.push({ id: 'obfuscated', sev: 'low', cat: 'malware', desc: 'Heavily obfuscated code', src: String(sc.src || '').slice(0, 160), snippet: text.slice(0, 160).replace(/\s+/g, ' ') });
    }
  }
  // The page tells you to press Win+R and paste: the text alone is enough.
  if (/(win(dows)?\s*(key)?\s*(\+|and)\s*r\b|windows\s+key\s*\+\s*r|run\s+dialog)/i.test(pageText) && /((ctrl|control)\s*(\+|and)\s*v|paste)/i.test(pageText) && /(verif|captcha|robot|human)/i.test(pageText)) {
    findings.push({ id: 'fake-captcha-text', sev: 'critical', cat: 'malware', desc: 'Page tells you to paste a command into the Run dialog', src: 'page text', snippet: '' });
  }
  // Clipboard command + a fake check on the same page = ClickFix, whatever the file split.
  const ids = new Set(findings.map((f) => f.id));
  if (ids.has('clip-cmd') && (ids.has('fake-captcha') || /(verif|captcha|robot|human)/i.test(pageText))) {
    findings.push({ id: 'clickfix', sev: 'critical', cat: 'malware', desc: 'Fake human check that copies a malicious command', src: 'combined', snippet: '' });
  }
  if (ids.has('ip-lookup') && (ids.has('webhook-exfil') || ids.has('telegram-exfil'))) {
    findings.push({ id: 'ip-grabber', sev: 'critical', cat: 'ip_logger', desc: 'Grabs your IP address and sends it away', src: 'combined', snippet: '' });
  }
  findings.sort((a, b) => sevRank[b.sev] - sevRank[a.sev]);
  return findings;
}

export function summarize(findings) {
  if (!findings.length) return { level: 'none', count: 0 };
  const top = findings[0];
  return { level: top.sev, category: top.cat, reason: top.desc, count: findings.length, ids: [...new Set(findings.map((f) => f.id))] };
}

// URLs of images / videos that only exist in code (lazy galleries, "surprise" payloads, preloads).
export function mediaInCode(text, base) {
  const t = String(text || '').slice(0, CAP_PER_SCRIPT);
  const out = { images: new Set(), videos: new Set(), dataImages: [] };
  const abs = (u) => { try { return new URL(u.replace(/\\\//g, '/'), base).href; } catch { return ''; } };
  for (const m of t.matchAll(/(?:https?:)?(?:\\?\/){2}[^\s'"`<>()\\]{3,400}?\.(jpe?g|png|gif|webp|avif|mp4|webm|m4v|mov)(?:\?[^\s'"`<>()\\]{0,200})?(?=['"`\s)\\]|$)/gi)) {
    const u = abs(m[0].startsWith('//') || m[0].startsWith('\\/') ? 'https:' + m[0].replace(/\\\//g, '/') : m[0]);
    if (!/^https?:/.test(u)) continue;
    (/(mp4|webm|m4v|mov)$/i.test(m[1]) ? out.videos : out.images).add(u);
    if (out.images.size > 120) break;
  }
  for (const m of t.matchAll(/data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]{400,1500000}/g)) {
    out.dataImages.push(m[0]);
    if (out.dataImages.length >= 8) break;
  }
  return { images: [...out.images], videos: [...out.videos], dataImages: out.dataImages };
}
