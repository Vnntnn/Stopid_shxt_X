#!/usr/bin/env python3
"""Render every meme in web/memes/captions.js to web/memes/png/<id>.png (headless Chromium + Pillow).

Usage: python3 scripts/make_meme_pngs.py [id ...]     (no ids = all)
Needs: chromium (CHROMIUM env var overrides the path), Pillow, fonts Liberation Sans, Noto Sans Thai, Noto Color Emoji.
Each PNG is palette-quantised until it is under MAX_BYTES, then its luminance is checked (photosensitivity rule: no big white or black fields).
"""
import concurrent.futures as cf, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MEMES = ROOT / 'web' / 'memes'
OUT = MEMES / 'png'
MAX_BYTES = 110_000
PAGE_BG = (11, 15, 26)  # transparent pixels are judged over the page's dark background
# luminance limits (also enforced by tests/fly-meme-png.test.js)
MEAN_MIN, MEAN_MAX, BRIGHT_MAX, DARK_MAX = 0.04, 0.42, 0.22, 0.38


def load_memes():
    txt = (MEMES / 'captions.js').read_text(encoding='utf-8')
    m = re.search(r'window\.MEMES\s*=\s*(\[.*?\n\]);', txt, re.S)
    # captions.js is JS (unquoted keys): let Node evaluate it so there is one source of truth
    js = "global.window={};require('fs');eval(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(window.MEMES))"
    return json.loads(subprocess.check_output(['node', '-e', js, str(MEMES / 'captions.js')], text=True))


def lin(v):
    v /= 255
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4


LUT = [lin(i) for i in range(256)]


def luminance_stats(img):
    im = img.convert('RGBA')
    bg = Image.new('RGBA', im.size, PAGE_BG + (255,))
    im = Image.alpha_composite(bg, im).convert('RGB')
    n = im.width * im.height
    tot = bright = dark = 0.0
    for r, g, b in im.get_flattened_data():
        l = 0.2126 * LUT[r] + 0.7152 * LUT[g] + 0.0722 * LUT[b]
        tot += l
        bright += l > 0.8
        dark += l < 0.0015
    return tot / n, bright / n, dark / n


def shoot(meme, tmp):
    w, h = meme['size']
    raw = Path(tmp) / f"{meme['id']}.png"
    prof = tempfile.mkdtemp(dir=tmp)
    cmd = [os.environ.get('CHROMIUM', 'chromium'), '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
           f'--user-data-dir={prof}', '--default-background-color=00000000', '--virtual-time-budget=4000', f'--window-size={w},{h}',
           f'--screenshot={raw}', f"file://{MEMES / 'generator.html'}#{meme['id']}"]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    shutil.rmtree(prof, ignore_errors=True)
    im = Image.open(raw)
    im = im.crop((0, 0, w, h)) if im.size != (w, h) else im
    return im


def save(meme, im):
    dst = OUT / f"{meme['id']}.png"
    rgba = im.convert('RGBA')
    has_alpha = rgba.getchannel('A').getextrema()[0] < 255
    for colours in (256, 128, 64, 48, 32):
        q = rgba.quantize(colours, method=Image.Quantize.FASTOCTREE if has_alpha else Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) if has_alpha else rgba.convert('RGB').quantize(colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        q.save(dst, optimize=True)
        if dst.stat().st_size <= MAX_BYTES:
            break
    return dst, colours


def main(argv):
    memes = load_memes()
    if argv:
        memes = [m for m in memes if m['id'] in argv]
    OUT.mkdir(parents=True, exist_ok=True)
    problems = []
    with tempfile.TemporaryDirectory() as tmp, cf.ThreadPoolExecutor(4) as pool:
        shots = list(pool.map(lambda m: (m, shoot(m, tmp)), memes))
    for m, im in shots:
        dst, colours = save(m, im)
        mean, bright, dark = luminance_stats(Image.open(dst))
        ok = MEAN_MIN <= mean <= MEAN_MAX and bright <= BRIGHT_MAX and dark <= DARK_MAX and dst.stat().st_size <= 120_000 and 480 <= im.width <= 720 and 480 <= im.height <= 720
        print(f"{'ok ' if ok else 'BAD'} {m['id']:24s} {im.width}x{im.height} {dst.stat().st_size // 1024:4d} KB  q{colours:3d}  mean {mean:.3f} bright {bright:.3f} dark {dark:.3f}")
        if not ok:
            problems.append(m['id'])
    if problems:
        print('PROBLEMS:', ', '.join(problems))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
