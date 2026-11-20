/** Saved signatures and initials, kept on this device only (browser storage). */

export type SignatureRole = 'signature' | 'initials';

export interface SavedSignature {
  id: string;
  role: SignatureRole;
  /** PNG with a transparent background, as a data: URL. */
  src: string;
  /** Pixel size of the image, for its shape. */
  width: number;
  height: number;
}

const KEY = 'pdf-studio:signatures';

export function loadSignatures(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedSignature[]) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s.src === 'string' && s.src.startsWith('data:image/png')) : [];
  } catch {
    return [];
  }
}

export function storeSignatures(list: SavedSignature[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Handwriting-style fonts that ship with common systems; typed signatures use whichever exist. */
export const SCRIPT_FONTS = [
  'Snell Roundhand',
  'Apple Chancery',
  'Segoe Script',
  'Brush Script MT',
  'Lucida Handwriting',
  'Bradley Hand',
  'Savoye LET',
  'Zapfino',
];

export function availableScriptFonts(): string[] {
  const found = SCRIPT_FONTS.filter((f) => {
    try {
      return document.fonts.check(`32px "${f}"`) && isInstalled(f);
    } catch {
      return false;
    }
  });
  return found.length ? found.slice(0, 4) : ['cursive'];
}

/** `document.fonts.check` says yes for missing fonts too; compare against a fallback's width. */
function isInstalled(font: string): boolean {
  const c = document.createElement('canvas').getContext('2d');
  if (!c) return false;
  const sample = 'Signature Qwxyz 123';
  c.font = '40px monospace';
  const fallback = c.measureText(sample).width;
  c.font = `40px "${font}", monospace`;
  return Math.abs(c.measureText(sample).width - fallback) > 1;
}

/**
 * Crops a canvas to its drawn pixels and returns a PNG (transparent background),
 * scaled down so the longer side is at most `maxSide` pixels.
 */
export function trimToPng(canvas: HTMLCanvasElement, maxSide = 900): { src: string; width: number; height: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return null;
  const pad = 4;
  x1 = Math.max(0, x1 - pad);
  y1 = Math.max(0, y1 - pad);
  x2 = Math.min(width - 1, x2 + pad);
  y2 = Math.min(height - 1, y2 + pad);
  const w = x2 - x1 + 1;
  const h = y2 - y1 + 1;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const o = out.getContext('2d');
  if (!o) return null;
  o.drawImage(canvas, x1, y1, w, h, 0, 0, out.width, out.height);
  return { src: out.toDataURL('image/png'), width: out.width, height: out.height };
}

/** Turns a photo or scan of a signature into ink on a transparent background. */
export async function imageToSignature(file: File, color: string | null): Promise<{ src: string; width: number; height: number } | null> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  // Light paper becomes transparent; darker strokes keep an opacity that follows their darkness.
  const ink = color ? hexRgb(color) : null;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const alpha = d[i + 3] === 0 ? 0 : Math.max(0, Math.min(255, (205 - lum) * 2.2));
    d[i + 3] = alpha;
    if (ink) [d[i], d[i + 1], d[i + 2]] = ink;
  }
  ctx.putImageData(img, 0, 0);
  return trimToPng(canvas);
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function dataUrlToBytes(src: string): Uint8Array {
  const b64 = src.slice(src.indexOf(',') + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function todayText(): string {
  return new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
