import {
  beginText,
  endText,
  PDFDocument,
  PDFHexString,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
  type PDFContext,
  type PDFRef,
} from 'pdf-lib';
import { getText, type PDFDocumentProxy } from './pdf';

/**
 * OCR with Tesseract.js (Apache-2.0): makes scanned pages searchable and selectable by
 * adding an invisible text layer exactly over the words in the page image.
 */

export const OCR_LANGUAGES: { code: string; name: string }[] = [
  { code: 'eng', name: 'English' },
  { code: 'hin', name: 'Hindi' },
  { code: 'ben', name: 'Bengali' },
  { code: 'tam', name: 'Tamil' },
  { code: 'tel', name: 'Telugu' },
  { code: 'mar', name: 'Marathi' },
  { code: 'urd', name: 'Urdu' },
  { code: 'spa', name: 'Spanish' },
  { code: 'fra', name: 'French' },
  { code: 'deu', name: 'German' },
  { code: 'por', name: 'Portuguese' },
  { code: 'ita', name: 'Italian' },
  { code: 'ara', name: 'Arabic' },
  { code: 'rus', name: 'Russian' },
  { code: 'chi_sim', name: 'Chinese (Simplified)' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' },
];

/** English ships with the app; other languages download from jsDelivr on first use (only the language is requested). */
function langPath(lang: string): string {
  return lang === 'eng' ? `${location.origin}${import.meta.env.BASE_URL}tesseract/lang` : `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1/4.0.0_best_int`;
}

export interface OcrProgress {
  page: number;
  done: number;
  total: number;
  /** 0–1 within the current page. */
  pageProgress: number;
  status: string;
}

interface Word {
  text: string;
  /** Baseline start and end, and height, in PDF coordinates. */
  start: [number, number];
  end: [number, number];
  height: number;
}

/** Pages with little or no real text, i.e. probably scanned. */
export async function pagesWithoutText(doc: PDFDocumentProxy): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const tc = await getText(doc, i);
    const chars = tc.items.reduce((n, it) => n + ('str' in it ? it.str.trim().length : 0), 0);
    if (chars < 20) out.push(i);
  }
  return out;
}

/** Recognises the words on the given pages and returns the document with an invisible text layer added. */
export async function ocrDocument(
  doc: PDFDocumentProxy,
  base: Uint8Array,
  pages: number[],
  lang: string,
  onProgress: (p: OcrProgress) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const { createWorker, OEM } = await import('tesseract.js');
  const root = `${location.origin}${import.meta.env.BASE_URL}tesseract`;
  let current = { page: pages[0] ?? 0, done: 0 };
  const worker = await createWorker(lang, OEM.LSTM_ONLY, {
    workerPath: `${root}/worker.min.js`,
    corePath: `${root}/core`,
    langPath: langPath(lang),
    gzip: true,
    logger: (m: { status: string; progress: number }) =>
      onProgress({ page: current.page, done: current.done, total: pages.length, pageProgress: m.status === 'recognizing text' ? m.progress : 0, status: m.status }),
  });
  try {
    const found = new Map<number, Word[]>();
    for (let i = 0; i < pages.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      current = { page: pages[i], done: i };
      onProgress({ page: pages[i], done: i, total: pages.length, pageProgress: 0, status: 'rendering page' });
      found.set(pages[i], await recognisePage(doc, pages[i], worker));
    }
    onProgress({ page: pages[pages.length - 1] ?? 0, done: pages.length, total: pages.length, pageProgress: 1, status: 'adding text' });
    return await addTextLayer(base, found);
  } finally {
    await worker.terminate();
  }
}

type TessWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

async function recognisePage(doc: PDFDocumentProxy, index: number, worker: TessWorker): Promise<Word[]> {
  const page = await doc.getPage(index + 1);
  // 300 DPI, capped so very large pages stay manageable.
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(300 / 72, 5000 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return [];
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
  const words: Word[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const w of line.words) {
          const text = w.text.trim();
          if (!text || w.confidence < 30) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          // Baseline from the line's baseline where available, else the box bottom.
          const bl = line.baseline;
          const yAt = (x: number) => (bl && bl.x1 !== bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0) : y1);
          const toPdf = (x: number, y: number) => viewport.convertToPdfPoint(x, y) as [number, number];
          const start = toPdf(x0, Math.min(y1, yAt(x0)));
          const end = toPdf(x1, Math.min(y1, yAt(x1)));
          const top = toPdf(x0, y0);
          // A space after each word (but the last on its line) so copied text keeps its word breaks.
          const last = w === line.words[line.words.length - 1];
          words.push({ text: last ? text : `${text} `, start, end, height: Math.hypot(top[0] - start[0], top[1] - start[1]) });
        }
      }
    }
  }
  return words;
}

/**
 * A tiny TrueType font whose glyphs are empty and 500 units wide, made with
 * scripts/make-glyphless-font.py (fontTools). Embedding it, rather than naming a font
 * that isn't there, stops readers substituting another font, which would shift the
 * invisible words, break word spacing in copied text, and show "font not found" warnings.
 */
const GLYPHLESS_TTF = 'AAEAAAAKAIAAAwAgT1MvMkT8Q7AAAAEoAAAAYGNtYXAADABzAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZC1iqJQAAACsAAAANmhoZWEDIgEuAAAA5AAAACRobXR4AfQAAAAAAYgAAAAGbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lGZ8ZNAAAAdAAAABycG9zdAAHAAAAAAJEAAAAJgABAAAAAQAAg0SOxl8PPPUAAwPoAAAAAOcmM9oAAAAA5yYz2gAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAAH0AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwH0AZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAIAMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAIP//AAAAIP///+EAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQANAAAAAQAAAAAAAgAHAA0AAwABBAkAAQAaABQAAwABBAkAAgAOAC5HbHlwaExlc3NGb250UmVndWxhcgBHAGwAeQBwAGgATABlAHMAcwBGAG8AbgB0AFIAZQBnAHUAbABhAHIAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAADAAA=';

function glyphlessTrueType(): Uint8Array {
  return Uint8Array.from(atob(GLYPHLESS_TTF), (c) => c.charCodeAt(0));
}

/** A font that draws nothing but carries Unicode text: each character is one 2-byte code, mapped to itself. */
function glyphlessFont(context: PDFContext): PDFRef {
  const toUnicode = context.register(
    context.flateStream(
      [
        '/CIDInit /ProcSet findresource begin',
        '12 dict begin',
        'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /Adobe-Identity-UCS def',
        '/CMapType 2 def',
        '1 begincodespacerange',
        '<0000> <FFFF>',
        'endcodespacerange',
        '1 beginbfrange',
        '<0000> <FFFF> <0000>',
        'endbfrange',
        'endcmap',
        'CMapName currentdict /CMap defineresource pop',
        'end',
        'end',
      ].join('\n'),
    ),
  );
  const ttf = glyphlessTrueType();
  const fontFile = context.register(context.flateStream(ttf, { Length1: ttf.length }));
  // Every character code draws glyph 1 (empty).
  const toGid = new Uint8Array(65536 * 2);
  for (let i = 1; i < toGid.length; i += 2) toGid[i] = 1;
  const cidToGid = context.register(context.flateStream(toGid));
  const descriptor = context.register(
    context.obj({ Type: 'FontDescriptor', FontName: 'GlyphLessFont', Flags: 5, FontBBox: [0, -200, 500, 800], ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 800, StemV: 80, FontFile2: fontFile }),
  );
  const cidFont = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'GlyphLessFont',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 500,
      CIDToGIDMap: cidToGid,
    }),
  );
  return context.register(
    context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'GlyphLessFont', Encoding: 'Identity-H', DescendantFonts: [cidFont], ToUnicode: toUnicode }),
  );
}

function utf16Hex(text: string): string {
  let hex = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) continue; // outside the basic plane: skipped
    hex += cp.toString(16).padStart(4, '0');
  }
  return hex;
}

async function addTextLayer(base: Uint8Array, found: Map<number, Word[]>): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(base, { updateMetadata: false });
  const font = glyphlessFont(pdf.context);
  const pages = pdf.getPages();
  for (const [index, words] of found) {
    const page = pages[index];
    if (!page || !words.length) continue;
    const key = page.node.newFontDictionary('OCR', font);
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of words) {
      const hex = utf16Hex(w.text);
      if (!hex) continue;
      // Fit the word itself (not its trailing space) over its image.
      const n = utf16Hex(w.text.trimEnd()).length / 4 || 1;
      const size = Math.max(1, w.height);
      const dx = w.end[0] - w.start[0];
      const dy = w.end[1] - w.start[1];
      const width = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      // Each glyph is half an em wide; squeeze or stretch the word to cover its image exactly.
      const squeeze = Math.max(1, Math.min(1000, (width / (n * 0.5 * size)) * 100));
      ops.push(
        setFontAndSize(key, size),
        setCharacterSqueeze(squeeze),
        setTextMatrix(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), w.start[0], w.start[1]),
        showText(PDFHexString.of(hex)),
      );
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }
  return pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
}
