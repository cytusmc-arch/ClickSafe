"""Build ClickSafe: icons, DNR blocklist rulesets, extension zip, and site download.

Usage: python tools/build.py
"""
import hashlib
import json
import re
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
SITE = ROOT / "site"

LISTS = {
    "adult": {
        "domains": """pornhub.com xvideos.com xnxx.com xhamster.com redtube.com youporn.com tube8.com spankbang.com
eporner.com beeg.com tnaflix.com motherless.com hclips.com txxx.com porntrex.com youjizz.com 4tube.com porn.com
brazzers.com realitykings.com bangbros.com naughtyamerica.com onlyfans.com fansly.com manyvids.com chaturbate.com
stripchat.com bongacams.com livejasmin.com cam4.com camsoda.com myfreecams.com flirt4free.com imlive.com rule34.xxx
rule34.paheal.net rule34video.com gelbooru.com nhentai.net e-hentai.org exhentai.org hentaihaven.xxx hanime.tv
f95zone.to literotica.com xhamsterlive.com pornpics.com sex.com redgifs.com erome.com thothub.to fapello.com
coomer.su kemono.su simpcity.su influencersgonewild.com noodlemagazine.com hqporner.com daftsex.com fuq.com
iwara.tv hentai2read.com hitomi.la luscious.net imagefap.com xvideos.red pornhubpremium.com""",
        "keywords": r"porn|xxx|xvideo|xnxx|xhamster|hentai|nsfw|onlyfans|chaturbate|stripchat|camgirl|sexcam|rule34|nudes",
    },
    "gore": {
        "domains": """bestgore.com bestgore.fun theync.com goregrish.com kaotic.com documentingreality.com crazyshit.com
efukt.com heavy-r.com watchpeopledie.tv seegore.com gorecenter.com hoodsite.com goatse.cx lemonparty.org
meatspin.com tubgirl.com shockgore.com""",
        "keywords": r"bestgore|goregrish|theync|seegore|gorecenter|watchpeopledie|shockgore",
    },
    "gambling": {
        "domains": """stake.com stake.us roobet.com rollbit.com csgoempire.com duelbits.com gamdom.com bc.game shuffle.com
chumbacasino.com bet365.com draftkings.com fanduel.com betway.com 1xbet.com 888casino.com pokerstars.com
csgoroll.com hellcase.com key-drop.com clash.gg rainbet.com thunderpick.io razed.com""",
        "keywords": r"casino|sportsbook|gambling",
    },
    "iplogger": {
        "domains": """grabify.link iplogger.org iplogger.com iplogger.ru iplogger.co iplogger.info 2no.co yip.su iplis.ru
ezstat.ru blasze.tk blasze.com ps3cfw.com bmwforum.co leancoding.co spottyfly.com stopify.co joinmy.site
crabrave.pw lovebird.guru trulove.guru dateing.club otherhalf.life shrekis.life datasig.io datauth.io
headshot.monster gaming-at-my.best progaming.monster yourmy.monster screenshare.host imageshare.best
screenshot.best gamingfun.me catsnthing.com mypic.icu catsnthings.fun curiouscat.club gotyour.pics
gamergirl.pro partpicker.shop sportshub.bar locations.quest freegiftcards.co quickmessage.us fortnight.space
fortnitechat.site youshouldclick.us""",
        "keywords": r"grabify|iplogger|ipgrabber",
    },
}


def rules_for(cat: str, spec: dict) -> list:
    domains = sorted(set(spec["domains"].split()))
    rules = []
    rid = 1
    for d in domains:
        rules.append({
            "id": rid, "priority": 20,
            "action": {"type": "redirect", "redirect": {"extensionPath": f"/blocked.html?src=list&cat={cat}&h={d}"}},
            "condition": {"requestDomains": [d], "resourceTypes": ["main_frame"]},
        })
        rid += 1
    rules.append({
        "id": rid, "priority": 20,
        "action": {"type": "redirect", "redirect": {"extensionPath": f"/blocked.html?src=list&cat={cat}"}},
        "condition": {"regexFilter": rf"^https?://[^/?#]*({spec['keywords']})[^/?#]*([/?#]|$)", "resourceTypes": ["main_frame"]},
    })
    rid += 1
    rules.append({
        "id": rid, "priority": 20, "action": {"type": "block"},
        "condition": {"requestDomains": domains, "resourceTypes": ["sub_frame"]},
    })
    return rules


def shield_poly(s: float, cx: float, top: float, w: float, h: float) -> list:
    """Shield outline: flat-ish top shoulders, sides, curved point at the bottom."""
    pts = []
    hw = w / 2
    pts += [(cx, top), (cx + hw, top + h * 0.13)]
    # right side straight down, then bezier to the bottom point
    p0, p1, p2, p3 = (cx + hw, top + h * 0.45), (cx + hw, top + h * 0.78), (cx + hw * 0.35, top + h * 0.93), (cx, top + h)
    for i in range(1, 25):
        t = i / 24
        x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t ** 2 * p2[0] + t ** 3 * p3[0]
        y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t ** 2 * p2[1] + t ** 3 * p3[1]
        pts.append((x, y))
    right = pts[1:]
    left = [(2 * cx - x, y) for (x, y) in reversed(right)]
    return [(cx, top)] + right + left[1:]


def make_icons():
    S = 1024
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=230, fill=(11, 13, 18, 255))
    d.polygon(shield_poly(S, S / 2, 150, 600, 730), fill=(61, 220, 151, 255))
    d.line([(370, 520), (475, 625), (665, 420)], fill=(11, 13, 18, 255), width=78, joint="curve")
    for x, y in [(370, 520), (665, 420)]:
        d.ellipse((x - 39, y - 39, x + 39, y + 39), fill=(11, 13, 18, 255))
    (EXT / "icons").mkdir(exist_ok=True)
    for n in (16, 32, 48, 128):
        im.resize((n, n), Image.LANCZOS).save(EXT / "icons" / f"{n}.png")
    SITE.mkdir(exist_ok=True)
    im.resize((256, 256), Image.LANCZOS).save(SITE / "icon.png")
    im.resize((64, 64), Image.LANCZOS).save(SITE / "favicon.png")


def main():
    make_icons()
    (EXT / "rules").mkdir(exist_ok=True)
    for cat, spec in LISTS.items():
        (EXT / "rules" / f"{cat}.json").write_text(json.dumps(rules_for(cat, spec), indent=1))

    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    out = SITE / "clicksafe.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(EXT.rglob("*")):
            if f.is_file() and not f.name.startswith(".") and "_metadata" not in f.relative_to(EXT).parts:
                z.write(f, f.relative_to(EXT).as_posix())
    data = out.read_bytes()
    kb = max(1, round(len(data) / 1024))
    sha = hashlib.sha256(data).hexdigest()
    idx = SITE / "index.html"
    if idx.exists():
        html = idx.read_text(encoding="utf-8")
        html = re.sub(r"<!--meta-->.*?<!--/meta-->", f"<!--meta-->v{version} · {kb} KB<!--/meta-->", html, flags=re.S)
        html = re.sub(r"<!--sha-->.*?<!--/sha-->", f"<!--sha--><code>{sha}</code><!--/sha-->", html, flags=re.S)
        idx.write_text(html, encoding="utf-8")
    (SITE / "version.json").write_text(json.dumps({"version": version, "size_kb": kb, "sha256": sha}))
    print(f"built v{version}: {out} ({kb} KB) sha256={sha[:16]}…")


if __name__ == "__main__":
    main()
