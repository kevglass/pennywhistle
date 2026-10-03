#!/usr/bin/env python3
"""Build app/omr/edwin-metrics.json, used to read text in MuseScore 4 PDFs.

    python3 scripts/edwin-metrics.py FONT_DIR   (FONT_DIR holds Edwin-Roman.otf, -Bold, -Italic, -BdIta)

MuseScore embeds its text font (Edwin) as a subset with no character map, so the PDF
only says "glyph 7". The advance width and outline bounds of each glyph survive the
subsetting, and together they identify the character. This writes, for each style,
[char, advance, xMin, yMin, xMax, yMax] per character in 1000-unit em space.

Get the fonts from https://github.com/musescore/MuseScore/tree/main/fonts/edwin (OFL).
Needs fontTools (pip install fonttools).
"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen

src = sys.argv[1] if len(sys.argv) > 1 else '.'
out = {}
for style in ['Roman', 'Bold', 'Italic', 'BdIta']:
    font = TTFont(os.path.join(src, f'Edwin-{style}.otf'))
    upm = font['head'].unitsPerEm
    glyphs = font.getGlyphSet()
    rows = []
    for cp, name in sorted(font.getBestCmap().items()):
        if cp < 32 or cp > 0x2FFF:
            continue
        pen = BoundsPen(glyphs)
        glyphs[name].draw(pen)
        bounds = pen.bounds or (0, 0, 0, 0)
        rows.append([chr(cp), round(font['hmtx'][name][0] * 1000 / upm)] + [round(v * 1000 / upm) for v in bounds])
    out[style] = rows
path = os.path.join(os.path.dirname(__file__), '..', 'app', 'omr', 'edwin-metrics.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print(path, {k: len(v) for k, v in out.items()})
