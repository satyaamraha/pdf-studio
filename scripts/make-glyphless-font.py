"""Builds the invisible font used for OCR text (src/lib/ocr.ts, GLYPHLESS_TTF).

Every glyph is empty and 500 units wide. Run with fontTools installed:
    python3 scripts/make-glyphless-font.py  # prints the base64 to paste into ocr.ts
"""
import base64
import io

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder([".notdef", "space"])
fb.setupCharacterMap({0x20: "space"})
empty = TTGlyphPen(None).glyph()
fb.setupGlyf({".notdef": empty, "space": empty})
fb.setupHorizontalMetrics({".notdef": (500, 0), "space": (500, 0)})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "GlyphLessFont", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, fsType=0)
fb.setupPost()
out = io.BytesIO()
fb.save(out)
print(base64.b64encode(out.getvalue()).decode())
