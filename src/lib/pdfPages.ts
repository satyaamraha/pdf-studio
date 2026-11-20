import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFObject, type PDFPage } from 'pdf-lib';
import { remapAnnotations, type PageSlot } from './pagePlan';

export type { PageSlot };
export { remapAnnotations };

const SAVE_OPTIONS = { useObjectStreams: true, updateFieldAppearances: false } as const;

/**
 * Deletes objects nothing points to any more (pages that were removed, old image
 * data…). pdf-lib otherwise writes every object it ever loaded, so files never shrink.
 */
export function collectGarbage(pdf: PDFDocument): number {
  const ctx = pdf.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const root of [t.Root, t.Info, t.Encrypt, t.ID]) if (root) stack.push(root);
  while (stack.length) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

/**
 * Replaces every reference to the given (removed) objects with null. Bookmarks, links
 * and form fields that pointed at deleted pages would otherwise keep those pages, and
 * everything on them, in the file.
 */
function scrubReferences(pdf: PDFDocument, removed: Set<string>): void {
  if (removed.size === 0) return;
  const visit = (obj: PDFObject | undefined) => {
    if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        if (value instanceof PDFRef && removed.has(value.toString())) obj.set(key, PDFNull);
        else visit(value);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const value = obj.get(i);
        if (value instanceof PDFRef && removed.has(value.toString())) obj.set(i, PDFNull);
        else visit(value);
      }
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!removed.has(ref.toString())) visit(obj);
  }
}

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/**
 * Builds a new version of `base` whose pages follow `plan`. Document-level data
 * (bookmarks, metadata, form fields) is kept. `extra` holds the bytes of other
 * files that pages are taken from.
 */
export async function applyPagePlan(base: Uint8Array, plan: PageSlot[], extra: Uint8Array[] = []): Promise<Uint8Array> {
  if (plan.length === 0) throw new Error('A PDF needs at least one page.');
  const pdf = await PDFDocument.load(base, { updateMetadata: false });
  const extraDocs = await Promise.all(extra.map((b) => PDFDocument.load(b, { updateMetadata: false })));
  const original = pdf.getPages();

  // Gather the page objects first, while every original page is still in place.
  const usedOriginal = new Set<number>();
  const pages: (PDFPage | null)[] = [];
  for (const slot of plan) {
    if (slot.blank) {
      pages.push(null);
    } else if (slot.source === 0) {
      if (!original[slot.index]) throw new Error(`Page ${slot.index + 1} doesn't exist.`);
      if (usedOriginal.has(slot.index)) {
        const [copy] = await pdf.copyPages(pdf, [slot.index]);
        pages.push(copy);
      } else {
        usedOriginal.add(slot.index);
        pages.push(original[slot.index]);
      }
    } else {
      const src = extraDocs[slot.source - 1];
      if (!src) throw new Error('Missing source document.');
      const [copy] = await pdf.copyPages(src, [slot.index]);
      pages.push(copy);
    }
  }

  for (let i = pdf.getPageCount() - 1; i >= 0; i--) pdf.removePage(i);
  const removed = new Set(original.filter((_, i) => !usedOriginal.has(i)).map((p) => p.ref.toString()));
  scrubReferences(pdf, removed);

  plan.forEach((slot, i) => {
    const page = slot.blank ? pdf.addPage([slot.blank.width, slot.blank.height]) : pdf.addPage(pages[i]!);
    if (slot.rotate) page.setRotation(degrees(normalizeAngle(page.getRotation().angle + slot.rotate)));
  });

  collectGarbage(pdf);
  return pdf.save(SAVE_OPTIONS);
}

// ----- Compression -----

export interface CompressLevel {
  label: string;
  /** Longest side of a picture after compression, in pixels. */
  maxSide: number;
  /** JPEG quality, 0–1. */
  quality: number;
}

export const COMPRESS_LEVELS: CompressLevel[] = [
  { label: 'High quality', maxSide: 2400, quality: 0.85 },
  { label: 'Balanced', maxSide: 1600, quality: 0.72 },
  { label: 'Smallest file', maxSide: 1000, quality: 0.55 },
];

export interface CompressResult {
  bytes: Uint8Array;
  images: number;
  recompressed: number;
}

const N = (name: string) => PDFName.of(name);

function isJpeg(dict: PDFDict): boolean {
  const filter = dict.lookup(N('Filter'));
  if (filter === N('DCTDecode')) return true;
  return filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === N('DCTDecode');
}

/** RGB and greyscale JPEGs can be redrawn by the browser; CMYK and inverted ones are left alone. */
function canRecompress(dict: PDFDict): boolean {
  if (dict.has(N('Decode')) || dict.has(N('Mask')) || dict.lookup(N('ImageMask'))) return false;
  const cs = dict.lookup(N('ColorSpace'));
  if (cs === N('DeviceRGB') || cs === N('DeviceGray')) return true;
  if (cs instanceof PDFArray && cs.lookup(0) === N('ICCBased')) {
    const profile = cs.lookup(1);
    const n = profile instanceof PDFStream ? profile.dict.lookup(N('N')) : undefined;
    return n instanceof PDFNumber && (n.asNumber() === 1 || n.asNumber() === 3);
  }
  return false;
}

async function recompressJpeg(data: Uint8Array, level: CompressLevel): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'none' });
  } catch {
    return null;
  }
  const scale = Math.min(1, level.maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', level.quality));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/**
 * Makes a PDF smaller: re-encodes photos (JPEG images) at a lower resolution and
 * quality, drops unused objects, and packs the rest into compressed object streams.
 */
export async function compressPdf(
  base: Uint8Array,
  level: CompressLevel,
  onProgress?: (done: number, total: number) => void,
): Promise<CompressResult> {
  const pdf = await PDFDocument.load(base, { updateMetadata: false });
  collectGarbage(pdf);
  const ctx = pdf.context;
  const images: [PDFRef, PDFRawStream][] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(N('Subtype')) === N('Image') && isJpeg(obj.dict)) {
      images.push([ref, obj]);
    }
  }

  let recompressed = 0;
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i, images.length);
    const [ref, stream] = images[i];
    if (!canRecompress(stream.dict)) continue;
    const result = await recompressJpeg(stream.contents, level);
    // Only keep the new version when it is clearly smaller.
    if (!result || result.bytes.length > stream.contents.length * 0.9) continue;
    const dict = PDFDict.withContext(ctx);
    for (const [key, value] of stream.dict.entries()) {
      if (['Length', 'Filter', 'DecodeParms', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent'].includes(key.decodeText())) continue;
      dict.set(key, value);
    }
    dict.set(N('Width'), PDFNumber.of(result.width));
    dict.set(N('Height'), PDFNumber.of(result.height));
    dict.set(N('ColorSpace'), N('DeviceRGB'));
    dict.set(N('BitsPerComponent'), PDFNumber.of(8));
    dict.set(N('Filter'), N('DCTDecode'));
    ctx.assign(ref, PDFRawStream.of(dict, result.bytes));
    recompressed++;
  }
  onProgress?.(images.length, images.length);

  collectGarbage(pdf);
  const bytes = await pdf.save(SAVE_OPTIONS);
  return { bytes, images: images.length, recompressed };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
