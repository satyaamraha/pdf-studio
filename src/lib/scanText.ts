import type { Box } from './geometry';
import { pdfjs, type PDFDocumentProxy } from './pdf';

/**
 * Reading the look of a word in a scanned picture, so it can be replaced convincingly:
 * where the visible word is, the paper and ink colours, and the size, weight and style
 * of the lettering. Works from the rendered page, so it doesn't matter where the
 * recognised text came from (Adobe Scan, a scanner, or our own OCR).
 */

export type Rgb = [number, number, number];

export interface ScanLook {
  /** The area to paint over (the visible word and the haze around it), in page coordinates. */
  cover: Box;
  /** The paper's colour over `cover`, fading out at the edges so no seam shows. */
  patch: { rgba: Uint8ClampedArray; width: number; height: number };
  /** The pixels of the word over `cover`, with the paper made transparent (for moving it). */
  word: { rgba: Uint8ClampedArray; width: number; height: number };
  background: Rgb;
  ink: Rgb;
  /** Font size in points. */
  size: number;
  bold: boolean;
  serif: boolean;
  /** Where the new text's baseline starts. */
  origin: [number, number];
}

interface Run {
  text: string;
  box: Box;
  size: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

export async function inspectScannedText(doc: PDFDocumentProxy, pageIndex: number, run: Run): Promise<ScanLook | null> {
  const page = await doc.getPage(pageIndex + 1);
  const h = Math.max(run.size, 2);
  const S = Math.min(6, Math.max(1.5, 48 / h));
  const vp = page.getViewport({ scale: S, rotation: 0 });
  const padX = Math.max(4 * h, run.box.x2 - run.box.x1);
  const toPx = (b: Box) => {
    const [ax, ay, bx, by] = vp.convertToViewportRectangle([b.x1, b.y1, b.x2, b.y2]);
    return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
  };
  const area = toPx({ x1: run.box.x1 - padX, y1: run.box.y1 - 1.5 * h, x2: run.box.x2 + padX, y2: run.box.y2 + 1.5 * h });
  const cx = Math.max(0, Math.floor(area.x1));
  const cy = Math.max(0, Math.floor(area.y1));
  const W = Math.min(Math.ceil(vp.width), Math.ceil(area.x2)) - cx;
  const H = Math.min(Math.ceil(vp.height), Math.ceil(area.y2)) - cy;
  if (W < 4 || H < 4) return null;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -cx, -cy], annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  const px = ctx.getImageData(0, 0, W, H).data;
  canvas.width = canvas.height = 0;

  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];

  // Paper: the most common brightness around the word.
  const hist = new Uint32Array(64);
  for (const l of lum) hist[Math.min(63, l >> 2)]++;
  const bgL = (hist.indexOf(Math.max(...hist)) << 2) + 2;
  const background = commonColour(px, lum, (l) => Math.abs(l - bgL) <= 10);
  let maxDiff = 0;
  for (const l of lum) maxDiff = Math.max(maxDiff, Math.abs(l - bgL));
  if (maxDiff < 48) return null; // nothing visible here
  const ink = meanColour(px, lum, (l) => Math.abs(l - bgL) > maxDiff * 0.75);
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = Math.abs(lum[i] - bgL) > maxDiff * 0.45 ? 1 : 0;

  const rowHas = (y: number, l: number, r: number) => {
    for (let x = l; x <= r; x++) if (mask[y * W + x]) return true;
    return false;
  };
  const colHas = (x: number, t: number, b: number) => {
    for (let y = t; y <= b; y++) if (mask[y * W + x]) return true;
    return false;
  };

  // Start from the ink under the recognised word…
  const seed = toPx(run.box);
  const sx1 = Math.max(0, Math.floor(seed.x1 - cx));
  const sx2 = Math.min(W - 1, Math.ceil(seed.x2 - cx));
  const sy1 = Math.max(0, Math.floor(seed.y1 - cy));
  const sy2 = Math.min(H - 1, Math.ceil(seed.y2 - cy));
  let [L, R, T, B] = [W, -1, H, -1];
  for (let y = sy1; y <= sy2; y++)
    for (let x = sx1; x <= sx2; x++)
      if (mask[y * W + x]) {
        L = Math.min(L, x);
        R = Math.max(R, x);
        T = Math.min(T, y);
        B = Math.max(B, y);
      }
  if (R < 0) return null;

  // …then grow it to the whole visible word: up and down to the line's gaps, sideways
  // across letter spacing but not across the space between words.
  for (let pass = 0; pass < 3; pass++) {
    while (T > 0 && rowHas(T - 1, L, R)) T--;
    while (B < H - 1 && rowHas(B + 1, L, R)) B++;
    const gap = Math.max(2, Math.round(0.22 * (B - T + 1)));
    for (let x = R + 1, empty = 0; x < W; x++) {
      if (colHas(x, T, B)) [R, empty] = [x, 0];
      else if (++empty > gap) break;
    }
    for (let x = L - 1, empty = 0; x >= 0; x--) {
      if (colHas(x, T, B)) [L, empty] = [x, 0];
      else if (++empty > gap) break;
    }
  }

  // Baseline: the lowest row that is still solidly inked (descenders are thin).
  const counts: number[] = [];
  for (let y = T; y <= B; y++) {
    let n = 0;
    for (let x = L; x <= R; x++) n += mask[y * W + x];
    counts.push(n);
  }
  const most = Math.max(...counts);
  let base = B;
  while (base > T && counts[base - T] < most * 0.35) base--;
  // Capitals and tall letters reach about 0.7 em above the baseline, small letters about 0.5 em.
  const tall = /[A-Z0-9bdfhklt]/.test(run.text) || !run.text.trim();
  const em = (base - T + 1) / (tall ? 0.7 : 0.5);

  // Stroke thickness says bold; wide feet at the baseline say serif.
  const runsIn = (y: number) => {
    const out: number[] = [];
    let n = 0;
    for (let x = L; x <= R + 1; x++) {
      if (x <= R && mask[y * W + x]) n++;
      else if (n) {
        out.push(n);
        n = 0;
      }
    }
    return out;
  };
  const strokes: number[] = [];
  for (let y = T; y <= base; y++) strokes.push(...runsIn(y));
  const stem = median(strokes);
  const bold = stem / em > 0.105;
  const foot = median(runsIn(Math.max(T, base - Math.max(1, Math.round(0.03 * em)))));
  const middle = median(runsIn(Math.max(T, base - Math.round(0.3 * em))));
  const serif = middle > 0 && foot > middle * 1.5;

  // Scans carry faint haze (JPEG noise) around letters, so the cover reaches past the ink
  // and fades out; it stops halfway to any neighbouring ink so other words stay untouched.
  const gapTo = (from: number, step: number, limit: number, has: (i: number) => boolean) => {
    for (let i = from, n = 0; i >= 0 && i < limit; i += step, n++) if (has(i)) return n;
    return Infinity;
  };
  const reach = 0.4 * em;
  const ext = {
    l: Math.min(reach, 0.5 * gapTo(L - 1, -1, W, (x) => colHas(x, T, B)), L),
    r: Math.min(reach, 0.5 * gapTo(R + 1, 1, W, (x) => colHas(x, T, B)), W - 1 - R),
    t: Math.min(reach * 0.75, 0.5 * gapTo(T - 1, -1, H, (y) => rowHas(y, L, R)), T),
    b: Math.min(reach * 0.75, 0.5 * gapTo(B + 1, 1, H, (y) => rowHas(y, L, R)), H - 1 - B),
  };
  const ox1 = L - ext.l;
  const oy1 = T - ext.t;
  const ow = R + 1 + ext.r - ox1;
  const oh = B + 1 + ext.b - oy1;
  const k = Math.min(1, 256 / Math.max(ow, oh));
  const pw = Math.max(2, Math.round(ow * k));
  const ph = Math.max(2, Math.round(oh * k));
  const rgba = new Uint8ClampedArray(pw * ph * 4);
  // Solid over the ink and the first part of the haze, then a fade to nothing.
  const fade = (d: number, e: number) => (e <= 0 ? 1 : Math.min(1, d / (e * 0.6)));
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const X = (x + 0.5) / k;
      const Y = (y + 0.5) / k;
      const a = Math.min(fade(X, ext.l), fade(ow - X, ext.r), fade(Y, ext.t), fade(oh - Y, ext.b));
      const i = (y * pw + x) * 4;
      [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]] = [background[0], background[1], background[2], Math.round(255 * a)];
    }
  // The word itself, lifted off the paper: ink keeps its colour, paper becomes transparent,
  // so a moved word sits cleanly on whatever is underneath.
  const inkL = 0.299 * ink[0] + 0.587 * ink[1] + 0.114 * ink[2];
  const k2 = Math.min(1, 1024 / Math.max(ow, oh));
  const ww = Math.max(2, Math.round(ow * k2));
  const wh = Math.max(2, Math.round(oh * k2));
  const word = new Uint8ClampedArray(ww * wh * 4);
  for (let y = 0; y < wh; y++)
    for (let x = 0; x < ww; x++) {
      const sx = Math.min(W - 1, Math.max(0, Math.floor(ox1 + (x + 0.5) / k2)));
      const sy = Math.min(H - 1, Math.max(0, Math.floor(oy1 + (y + 0.5) / k2)));
      const j = sy * W + sx;
      let a = (lum[j] - bgL) / (inkL - bgL || 1);
      a = a < 0.08 ? 0 : Math.min(1, a);
      const i = (y * ww + x) * 4;
      for (let ch = 0; ch < 3; ch++) word[i + ch] = a ? (px[j * 4 + ch] - (1 - a) * background[ch]) / a : ink[ch];
      word[i + 3] = Math.round(255 * a);
    }
  const [x1, y1] = vp.convertToPdfPoint(ox1 + cx, oy1 + oh + cy);
  const [x2, y2] = vp.convertToPdfPoint(ox1 + ow + cx, oy1 + cy);
  const [ox, oy] = vp.convertToPdfPoint(L + cx, base + 1 + cy);
  return {
    cover: { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) },
    patch: { rgba, width: pw, height: ph },
    word: { rgba: word, width: ww, height: wh },
    background,
    ink,
    size: em / S,
    bold,
    serif,
    origin: [ox, oy],
  };
}

/** The most common value of each channel: the paper itself, not pulled darker by noise near letters. */
function commonColour(px: Uint8ClampedArray, lum: Float32Array, pick: (l: number) => boolean): Rgb {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < lum.length; i++) if (pick(lum[i])) for (let ch = 0; ch < 3; ch++) hist[ch][px[i * 4 + ch]]++;
  return hist.map((h) => h.indexOf(Math.max(...h))) as Rgb;
}

function meanColour(px: Uint8ClampedArray, lum: Float32Array, pick: (l: number) => boolean): Rgb {
  let [r, g, b, n] = [0, 0, 0, 0];
  for (let i = 0; i < lum.length; i++)
    if (pick(lum[i])) {
      r += px[i * 4];
      g += px[i * 4 + 1];
      b += px[i * 4 + 2];
      n++;
    }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [255, 255, 255];
}

/** The standard PDF font for a look. */
export function scanFont(serif: boolean, bold: boolean): string {
  return serif ? (bold ? 'Times-Bold' : 'Times-Roman') : bold ? 'Helvetica-Bold' : 'Helvetica';
}
