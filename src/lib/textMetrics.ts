import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';

/**
 * Text boxes and stamps are saved with the PDF standard fonts (Helvetica), which
 * every PDF reader has. Measuring with the same font metrics on screen and in the
 * saved file means lines wrap in the same places.
 */
let regular: Font | null = null;
let bold: Font | null = null;
const fontFor = (isBold: boolean) =>
  isBold ? (bold ??= Font.load(FontNames.HelveticaBold)) : (regular ??= Font.load(FontNames.Helvetica));

/** Replaces characters the standard fonts can't draw (they cover Western European text). */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 63;
    out += cp === 10 || Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp) ? ch : '?';
  }
  return out;
}

/** Width of `text` in points, with kerning (same method as pdf-lib). */
export function textWidth(text: string, size: number, isBold = false): number {
  const font = fontFor(isBold);
  const names: string[] = [];
  for (const ch of toWinAnsi(text).replace(/\n/g, '')) {
    names.push(Encodings.WinAnsi.encodeUnicodeCodePoint(ch.codePointAt(0)!).name);
  }
  let total = 0;
  for (let i = 0; i < names.length; i++) {
    total += (font.getWidthOfGlyph(names[i]) || 250) + (names[i + 1] ? font.getXAxisKerningForPair(names[i], names[i + 1]) || 0 : 0);
  }
  return (total * size) / 1000;
}

/** Splits text into lines that fit `maxWidth`, honouring explicit line breaks. */
export function wrapText(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const next = line + word;
      if (line && textWidth(next.trimEnd(), size) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
        // A single word longer than the box: break it by characters.
        while (line && textWidth(line, size) > maxWidth) {
          let cut = line.length - 1;
          while (cut > 1 && textWidth(line.slice(0, cut), size) > maxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = next;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
