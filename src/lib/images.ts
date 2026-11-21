import { PDFDocument } from 'pdf-lib';
import { pdfjs } from './pdf';

/** Pages as pictures, and pictures as a PDF. */

export type ImageFormat = 'png' | 'jpeg';

export interface ExportedImage {
  name: string;
  bytes: Uint8Array;
}

/** Turns "1-3, 5" into 0-based page indexes (in range, no repeats). */
export function parsePageRange(text: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) if (p >= 1 && p <= count) out.add(p - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Renders pages of a finished PDF (annotations and form values included) as PNG or JPEG.
 * `dpi` 150 is good for screens, 300 for printing.
 */
export async function pagesToImages(
  pdf: Uint8Array,
  pages: number[],
  opts: { format: ImageFormat; dpi: number; stem: string },
  onProgress: (done: number, total: number) => void,
): Promise<ExportedImage[]> {
  const doc = await pdfjs.getDocument({ data: pdf.slice(), isEvalSupported: false }).promise;
  try {
    const out: ExportedImage[] = [];
    const digits = String(doc.numPages).length;
    for (let i = 0; i < pages.length; i++) {
      onProgress(i, pages.length);
      const page = await doc.getPage(pages[i] + 1);
      const unit = page.getViewport({ scale: 1 });
      // Keep within what browsers can draw.
      const scale = Math.min(opts.dpi / 72, Math.sqrt(40_000_000 / (unit.width * unit.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: opts.format === 'png' });
      if (!ctx) throw new Error('Drawing is not available.');
      if (opts.format === 'jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, `image/${opts.format}`, 0.92));
      if (!blob) throw new Error(`Couldn't create the image for page ${pages[i] + 1}.`);
      const num = String(pages[i] + 1).padStart(digits, '0');
      out.push({ name: `${opts.stem} - page ${num}.${opts.format === 'jpeg' ? 'jpg' : 'png'}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
      canvas.width = canvas.height = 0;
    }
    onProgress(pages.length, pages.length);
    return out;
  } finally {
    void doc.destroy();
  }
}

export type ImageLayout = 'a4' | 'letter' | 'image';

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

/**
 * One page per picture. With a paper size, each picture is fitted (with a margin) on a page
 * turned to match it; with 'image', each page is the picture's own size at 150 DPI.
 */
export async function imagesToPdf(files: File[], layout: ImageLayout): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const file of files) {
    const { bytes, kind, width, height } = await toEmbeddable(file);
    const img = kind === 'jpg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    if (layout === 'image') {
      const w = (width / 150) * 72;
      const h = (height / 150) * 72;
      pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      continue;
    }
    const [pw, ph] = SIZES[layout];
    const landscape = width > height;
    const W = landscape ? ph : pw;
    const H = landscape ? pw : ph;
    const margin = 28;
    const s = Math.min((W - margin * 2) / width, (H - margin * 2) / height);
    const w = width * s;
    const h = height * s;
    pdf.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  }
  pdf.setProducer('PDF Studio');
  return pdf.save({ useObjectStreams: true });
}

/** JPEG and PNG go in as they are; anything else the browser can read is converted to PNG (or JPEG for photos). */
async function toEmbeddable(file: File): Promise<{ bytes: Uint8Array; kind: 'jpg' | 'png'; width: number; height: number }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`“${file.name}” isn't a picture this browser can read.`);
  });
  const { width, height } = bitmap;
  const type = file.type || '';
  if (type === 'image/jpeg' || /\.jpe?g$/i.test(file.name)) {
    bitmap.close();
    return { bytes: new Uint8Array(await file.arrayBuffer()), kind: 'jpg', width, height };
  }
  if (type === 'image/png' || /\.png$/i.test(file.name)) {
    bitmap.close();
    return { bytes: new Uint8Array(await file.arrayBuffer()), kind: 'png', width, height };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const photo = /webp|heic|heif|avif/i.test(type) || /\.(webp|heic|heif|avif)$/i.test(file.name);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, photo ? 'image/jpeg' : 'image/png', 0.9));
  if (!blob) throw new Error(`Couldn't convert “${file.name}”.`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: photo ? 'jpg' : 'png', width, height };
}
