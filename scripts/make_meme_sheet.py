#!/usr/bin/env python3
"""Contact sheet of every web/memes/png/*.png -> the path given as argument (default docs/fly-ask-screens/51-meme-png-sheet.png)."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parent.parent
files = sorted((ROOT / 'web' / 'memes' / 'png').glob('*.png'))
out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'docs' / 'fly-ask-screens' / '51-meme-png-sheet.png'
cols, cell = 9, 220
rows = -(-len(files) // cols)
sheet = Image.new('RGB', (cols * cell, rows * (cell + 18)), (11, 15, 26))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert('RGBA'); im.thumbnail((cell - 8, cell - 8))
    x, y = (i % cols) * cell + 4, (i // cols) * (cell + 18) + 2
    sheet.paste(im, (x, y), im)
    d.text((x, y + cell - 6), f.stem[:30], fill=(190, 200, 220))
sheet.save(out, optimize=True)
print(out, sheet.size, len(files))
