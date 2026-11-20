import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import type { Box } from './geometry';
import { collectGarbage } from './pdfPages';
import { getPdfium, Mem, type Pdfium } from './pdfium';

/**
 * Editing page content with PDFium: true redaction, replacing text and editing images.
 * Every operation takes the document's bytes and returns new bytes. Afterwards pdf-lib
 * drops objects nothing uses any more: PDFium keeps a page's old content in the file
 * after rewriting it, and redacted text must not survive there.
 */

const PATH = 2;
const IMAGE = 3;
const SHADING = 4;
const FORM = 5;

type Matrix6 = [number, number, number, number, number, number];
const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0];

/** m1 then m2 (PDF row-vector convention). */
function compose(m1: Matrix6, m2: Matrix6): Matrix6 {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function apply(m: Matrix6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function boxOf(m: Matrix6, b: Box): Box {
  const pts = [apply(m, b.x1, b.y1), apply(m, b.x2, b.y1), apply(m, b.x1, b.y2), apply(m, b.x2, b.y2)];
  return {
    x1: Math.min(...pts.map((p) => p[0])),
    y1: Math.min(...pts.map((p) => p[1])),
    x2: Math.max(...pts.map((p) => p[0])),
    y2: Math.max(...pts.map((p) => p[1])),
  };
}

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const inside = (a: Box, b: Box, slack = 0.5) => a.x1 >= b.x1 - slack && a.x2 <= b.x2 + slack && a.y1 >= b.y1 - slack && a.y2 <= b.y2 + slack;
const containsPoint = (b: Box, x: number, y: number) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;

interface Ctx {
  m: Pdfium;
  mem: Mem;
  doc: number;
}

/** Opens bytes in PDFium, runs `fn`, and (if `save`) returns the saved result. */
async function withDoc<T>(bytes: Uint8Array, fn: (c: Ctx) => T, save: boolean): Promise<{ result: T; bytes: Uint8Array | null }> {
  const m = await getPdfium();
  const mem = new Mem(m);
  const buf = mem.bytes(bytes);
  const doc = m.FPDF_LoadMemDocument(buf, bytes.length, '');
  if (!doc) {
    mem.free();
    throw new Error(`The editing engine couldn't open this document (error ${m.FPDF_GetLastError()}).`);
  }
  try {
    const result = fn({ m, mem, doc });
    let out: Uint8Array | null = null;
    if (save) {
      const w = m.PDFiumExt_OpenFileWriter();
      try {
        if (!m.PDFiumExt_SaveAsCopy(doc, w)) throw new Error("The editing engine couldn't save the document.");
        const size = m.PDFiumExt_GetFileWriterSize(w);
        const p = mem.alloc(size);
        m.PDFiumExt_GetFileWriterData(w, p, size);
        out = mem.read(p, size);
      } finally {
        m.PDFiumExt_CloseFileWriter(w);
      }
    }
    return { result, bytes: out };
  } finally {
    m.FPDF_CloseDocument(doc);
    mem.free();
  }
}

function getMatrix({ m, mem }: Ctx, obj: number): Matrix6 {
  const p = mem.alloc(24);
  if (!m.FPDFPageObj_GetMatrix(obj, p)) return IDENTITY;
  return [0, 1, 2, 3, 4, 5].map((i) => mem.f32(p, i)) as Matrix6;
}

function setMatrix({ m, mem }: Ctx, obj: number, mx: Matrix6): void {
  const p = mem.alloc(24);
  mx.forEach((v, i) => mem.setF32(p, i, v));
  m.FPDFPageObj_SetMatrix(obj, p);
}

function getBounds({ m, mem }: Ctx, obj: number): Box | null {
  const p = mem.alloc(16);
  if (!m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12)) return null;
  return { x1: mem.f32(p, 0), y1: mem.f32(p, 1), x2: mem.f32(p, 2), y2: mem.f32(p, 3) };
}

interface PageObject {
  obj: number;
  type: number;
  /** Form XObject holding it, or 0 for the page itself. */
  parent: number;
  /** Matrix from the object's own space (its parent's space) to the page. */
  toPage: Matrix6;
  /** Bounds on the page. */
  box: Box | null;
}

/** Every object on the page, including those inside Form XObjects. */
function walk(c: Ctx, page: number): PageObject[] {
  const out: PageObject[] = [];
  const visit = (parent: number, toPage: Matrix6, depth: number) => {
    const count = parent ? c.m.FPDFFormObj_CountObjects(parent) : c.m.FPDFPage_CountObjects(page);
    for (let i = 0; i < count; i++) {
      const obj = parent ? c.m.FPDFFormObj_GetObject(parent, i) : c.m.FPDFPage_GetObject(page, i);
      if (!obj) continue;
      const type = c.m.FPDFPageObj_GetType(obj);
      const raw = getBounds(c, obj);
      out.push({ obj, type, parent, toPage, box: raw && parent ? boxOf(toPage, raw) : raw });
      if (type === FORM && depth < 8) visit(obj, compose(getMatrix(c, obj), toPage), depth + 1);
    }
  };
  visit(0, IDENTITY, 0);
  return out;
}

function removeObject(c: Ctx, page: number, o: PageObject): void {
  const ok = o.parent ? c.m.FPDFFormObj_RemoveObject(o.parent, o.obj) : c.m.FPDFPage_RemoveObject(page, o.obj);
  if (ok) c.m.FPDFPageObj_Destroy(o.obj);
}

interface CharInfo {
  index: number;
  unicode: number;
  box: Box;
  origin: [number, number];
  obj: number;
}

function readChars(c: Ctx, page: number): CharInfo[] {
  const tp = c.m.FPDFText_LoadPage(page);
  if (!tp) return [];
  const out: CharInfo[] = [];
  try {
    const n = c.m.FPDFText_CountChars(tp);
    const p = c.mem.alloc(32);
    for (let i = 0; i < n; i++) {
      const obj = c.m.FPDFText_GetTextObject(tp, i);
      if (!obj) continue; // spaces and line breaks the text reader adds itself
      c.m.FPDFText_GetCharBox(tp, i, p, p + 8, p + 16, p + 24);
      const [l, r, b, t] = [c.mem.f64(p, 0), c.mem.f64(p, 1), c.mem.f64(p, 2), c.mem.f64(p, 3)];
      c.m.FPDFText_GetCharOrigin(tp, i, p, p + 8);
      out.push({
        index: i,
        unicode: c.m.FPDFText_GetUnicode(tp, i),
        box: { x1: Math.min(l, r), y1: Math.min(b, t), x2: Math.max(l, r), y2: Math.max(b, t) },
        origin: [c.mem.f64(p, 0), c.mem.f64(p, 1)],
        obj,
      });
    }
  } finally {
    c.m.FPDFText_ClosePage(tp);
  }
  return out;
}

interface TextStyle {
  font: number;
  size: number;
  matrix: Matrix6;
  fill: [number, number, number, number];
  renderMode: number;
}

function textStyle(c: Ctx, o: PageObject): TextStyle {
  const p = c.mem.alloc(16);
  c.m.FPDFTextObj_GetFontSize(o.obj, p);
  const size = c.mem.f32(p);
  c.m.FPDFPageObj_GetFillColor(o.obj, p, p + 4, p + 8, p + 12);
  const fill: [number, number, number, number] = [c.mem.u32(p, 0), c.mem.u32(p, 1), c.mem.u32(p, 2), c.mem.u32(p, 3)];
  return {
    font: c.m.FPDFTextObj_GetFont(o.obj),
    size: size || 12,
    matrix: compose(getMatrix(c, o.obj), o.toPage),
    fill,
    renderMode: c.m.FPDFTextObj_GetTextRenderMode(o.obj),
  };
}

/** Where `obj` sits in the page's drawing order, or -1 (e.g. it's inside a Form XObject). */
function pageIndexOf(c: Ctx, page: number, obj: number): number {
  const n = c.m.FPDFPage_CountObjects(page);
  for (let i = 0; i < n; i++) if (c.m.FPDFPage_GetObject(page, i) === obj) return i;
  return -1;
}

/**
 * Adds a text object showing `text` with its first character's baseline origin at `origin`.
 * With `before`, it goes just before that object in drawing order, which keeps the
 * document's reading order (copying text, screen readers) the same as before.
 */
function addText(c: Ctx, page: number, text: string, origin: [number, number], style: TextStyle, font = style.font, before = 0): boolean {
  const t = c.m.FPDFPageObj_CreateTextObj(c.doc, font, style.size);
  if (!t) return false;
  if (!c.m.FPDFText_SetText(t, c.mem.wide(text))) {
    c.m.FPDFPageObj_Destroy(t);
    return false;
  }
  const [a, b, cc, d] = style.matrix;
  setMatrix(c, t, [a, b, cc, d, origin[0], origin[1]]);
  c.m.FPDFPageObj_SetFillColor(t, ...style.fill);
  if (style.renderMode >= 0) c.m.FPDFTextObj_SetTextRenderMode(t, style.renderMode);
  const at = before ? pageIndexOf(c, page, before) : -1;
  if (at < 0 || !c.m.FPDFPage_InsertObjectAtIndex(page, t, at)) c.m.FPDFPage_InsertObject(page, t);
  return true;
}

/**
 * Removes the characters chosen by `remove`. Text objects that lose only some of their
 * characters are rebuilt from the rest, word by word at their original positions.
 * Returns the removed characters, grouped by the object they came from.
 */
function removeChars(c: Ctx, page: number, objects: PageObject[], chars: CharInfo[], remove: (ch: CharInfo) => boolean) {
  const byObj = new Map<number, CharInfo[]>();
  for (const ch of chars) {
    const list = byObj.get(ch.obj);
    if (list) list.push(ch);
    else byObj.set(ch.obj, [ch]);
  }
  const objIndex = new Map(objects.map((o) => [o.obj, o]));
  const removed: { o: PageObject; style: TextStyle; chars: CharInfo[] }[] = [];
  for (const [obj, list] of byObj) {
    const gone = list.filter(remove);
    if (!gone.length) continue;
    const o = objIndex.get(obj);
    if (!o) continue;
    const style = textStyle(c, o);
    removed.push({ o, style, chars: gone });
    // Words that stay: runs of kept, non-space characters.
    const keep: CharInfo[][] = [];
    let run: CharInfo[] = [];
    for (const ch of list) {
      const space = ch.unicode === 32 || ch.unicode === 0xa0;
      if (gone.includes(ch) || space) {
        if (run.length) keep.push(run);
        run = [];
      } else run.push(ch);
    }
    if (run.length) keep.push(run);
    for (const word of keep) addText(c, page, String.fromCodePoint(...word.map((ch) => ch.unicode)), word[0].origin, style, style.font, o.parent ? 0 : o.obj);
    removeObject(c, page, o);
  }
  return removed;
}

export interface Mark {
  page: number;
  box: Box;
}

/**
 * True redaction: removes text, images, drawings and annotations under the marked areas,
 * then covers each area with a black box. Nothing under a mark stays in the file.
 */
export async function redact(bytes: Uint8Array, marks: Mark[], opts: { scrubMetadata?: boolean } = {}): Promise<Uint8Array> {
  const pages = [...new Set(marks.map((mk) => mk.page))];
  const { bytes: out } = await withDoc(
    bytes,
    (c) => {
      for (const pageIndex of pages) {
        const boxes = marks.filter((mk) => mk.page === pageIndex).map((mk) => mk.box);
        const page = c.m.FPDF_LoadPage(c.doc, pageIndex);
        if (!page) continue;
        try {
          const objects = walk(c, page);
          const chars = readChars(c, page);
          const hit = (ch: CharInfo) => {
            const cx = (ch.box.x1 + ch.box.x2) / 2;
            const cy = (ch.box.y1 + ch.box.y2) / 2;
            return boxes.some((b) => containsPoint(b, cx, cy) || containsPoint(b, ch.origin[0], ch.origin[1] + 0.1));
          };
          removeChars(c, page, objects, chars, hit);

          for (const o of walk(c, page)) {
            if (!o.box || !boxes.some((b) => overlaps(o.box!, b))) continue;
            if (o.type === IMAGE) {
              if (boxes.some((b) => inside(o.box!, b))) removeObject(c, page, o);
              else blackOutImage(c, o, boxes);
            } else if ((o.type === PATH || o.type === SHADING) && boxes.some((b) => inside(o.box!, b))) {
              removeObject(c, page, o);
            }
          }

          // Annotations (comments, links, form fields) in the area go too.
          const rect = c.mem.alloc(16);
          for (let i = c.m.FPDFPage_GetAnnotCount(page) - 1; i >= 0; i--) {
            const annot = c.m.FPDFPage_GetAnnot(page, i);
            if (!annot) continue;
            const got = c.m.FPDFAnnot_GetRect(annot, rect);
            c.m.FPDFPage_CloseAnnot(annot);
            if (!got) continue;
            // FS_RECTF is left, top, right, bottom.
            const [l, t, r, b] = [c.mem.f32(rect, 0), c.mem.f32(rect, 1), c.mem.f32(rect, 2), c.mem.f32(rect, 3)];
            const ab = { x1: Math.min(l, r), y1: Math.min(t, b), x2: Math.max(l, r), y2: Math.max(t, b) };
            if (boxes.some((bx) => overlaps(ab, bx))) c.m.FPDFPage_RemoveAnnot(page, i);
          }

          for (const b of boxes) {
            const r = c.m.FPDFPageObj_CreateNewRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
            c.m.FPDFPageObj_SetFillColor(r, 0, 0, 0, 255);
            c.m.FPDFPath_SetDrawMode(r, 1, false);
            c.m.FPDFPage_InsertObject(page, r);
          }
          if (!c.m.FPDFPage_GenerateContent(page)) throw new Error(`Couldn't rewrite page ${pageIndex + 1}.`);
        } finally {
          c.m.FPDF_ClosePage(page);
        }
      }
    },
    true,
  );
  return cleanUp(out!, { marks, scrubMetadata: opts.scrubMetadata });
}

/** Paints the covered pixels of an image black, inside the image data itself. */
function blackOutImage(c: Ctx, o: PageObject, boxes: Box[]): void {
  const bmp = c.m.FPDFImageObj_GetBitmap(o.obj);
  if (!bmp) return;
  try {
    const w = c.m.FPDFBitmap_GetWidth(bmp);
    const h = c.m.FPDFBitmap_GetHeight(bmp);
    const format = c.m.FPDFBitmap_GetFormat(bmp); // 1 gray, 2 BGR, 3 BGRx, 4 BGRA
    const bpp = format === 1 ? 1 : format === 2 ? 3 : 4;
    const stride = c.m.FPDFBitmap_GetStride(bmp);
    const buf = c.m.FPDFBitmap_GetBuffer(bmp);
    // Image space: the unit square, mapped onto the page by the object's matrix.
    const mx = compose(getMatrix(c, o.obj), o.toPage);
    const det = mx[0] * mx[3] - mx[1] * mx[2];
    if (!det) return;
    const inv: Matrix6 = [mx[3] / det, -mx[1] / det, -mx[2] / det, mx[0] / det, (mx[2] * mx[5] - mx[3] * mx[4]) / det, (mx[1] * mx[4] - mx[0] * mx[5]) / det];
    for (const b of boxes) {
      const u = boxOf(inv, b); // in unit-square coordinates
      const x0 = Math.max(0, Math.floor(u.x1 * w));
      const x1 = Math.min(w, Math.ceil(u.x2 * w));
      const y0 = Math.max(0, Math.floor((1 - u.y2) * h));
      const y1 = Math.min(h, Math.ceil((1 - u.y1) * h));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = buf + y * stride + x * bpp;
          for (let k = 0; k < Math.min(bpp, 3); k++) c.m.pdfium.setValue(p + k, 0, 'i8');
          if (bpp === 4) c.m.pdfium.setValue(p + 3, -1, 'i8');
        }
      }
    }
    c.m.FPDFImageObj_SetBitmap(0, 0, o.obj, bmp);
  } finally {
    c.m.FPDFBitmap_Destroy(bmp);
  }
}

/**
 * pdf-lib pass after PDFium: drop unreferenced objects (old page content), remove form
 * fields that sat under a redaction (their values would otherwise stay in the file) and
 * optionally the document's descriptive metadata.
 */
async function cleanUp(bytes: Uint8Array, o: { marks?: Mark[]; scrubMetadata?: boolean } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (o.marks?.length) {
    const pages = pdf.getPages();
    const acro = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (acro && fields) {
      const keep = fields.asArray().filter((entry) => {
        const field = pdf.context.lookup(entry);
        if (!(field instanceof PDFDict)) return true;
        const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
        const widgets = kids ? kids.asArray().map((k) => pdf.context.lookup(k)) : [field];
        return !widgets.some((w) => {
          if (!(w instanceof PDFDict)) return false;
          const rect = w.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map((n) => (n as PDFNumber).asNumber());
          const p = w.get(PDFName.of('P'));
          const pageIndex = pages.findIndex((pg) => p instanceof PDFRef && pg.ref.toString() === p.toString());
          if (!rect || pageIndex < 0) return false;
          const wb = { x1: Math.min(rect[0], rect[2]), y1: Math.min(rect[1], rect[3]), x2: Math.max(rect[0], rect[2]), y2: Math.max(rect[1], rect[3]) };
          return o.marks!.some((mk) => mk.page === pageIndex && overlaps(mk.box, wb));
        });
      });
      if (keep.length !== fields.size()) acro.set(PDFName.of('Fields'), pdf.context.obj(keep));
    }
  }
  if (o.scrubMetadata) {
    for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
      const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
      if (info instanceof PDFDict) info.delete(PDFName.of(key));
    }
    pdf.catalog.delete(PDFName.of('Metadata'));
  }
  collectGarbage(pdf);
  return pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
}

// ----- Editing text -----

const STANDARD = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** The standard font closest to a font name like "ABCDEF+Arial-BoldMT". */
function closestStandard(name: string): string {
  const n = name.toLowerCase();
  const family = /courier|mono|consol|menlo/.test(n) ? STANDARD.mono : /times|serif|georgia|garamond|roman|cambria|minion|book/.test(n) && !/sans/.test(n) ? STANDARD.serif : STANDARD.sans;
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  return family[(bold ? 1 : 0) + (italic ? 2 : 0)];
}

function fontName(c: Ctx, font: number): string {
  const p = c.mem.alloc(256);
  const len = c.m.FPDFFont_GetBaseFontName(font, p, 256);
  return len > 1 ? new TextDecoder().decode(c.mem.read(p, len - 1)) : '';
}

/**
 * Replaces the text in `region` with `text`, in the same position, size and colour.
 * The original font is kept when it has every character needed; otherwise the closest
 * standard font (Helvetica, Times or Courier) is used.
 */
export async function replaceText(bytes: Uint8Array, pageIndex: number, region: Box, text: string): Promise<{ bytes: Uint8Array; fontKept: boolean }> {
  let fontKept = true;
  const { bytes: out } = await withDoc(
    bytes,
    (c) => {
      const page = c.m.FPDF_LoadPage(c.doc, pageIndex);
      if (!page) throw new Error('Page not found.');
      try {
        const objects = walk(c, page);
        const chars = readChars(c, page);
        const inRegion = (ch: CharInfo) => containsPoint(region, (ch.box.x1 + ch.box.x2) / 2, (ch.box.y1 + ch.box.y2) / 2);
        const target = chars.filter(inRegion);
        if (!target.length) throw new Error('No text found there.');
        const firstObj = objects.find((o) => o.obj === target[0].obj);
        if (!firstObj) throw new Error('No text found there.');
        const style = textStyle(c, firstObj);
        const origin = target[0].origin;
        // Characters this font is known to have: everything drawn with it on the page.
        const available = new Set(chars.filter((ch) => c.m.FPDFTextObj_GetFont(ch.obj) === style.font).map((ch) => ch.unicode));
        const needed = [...text].filter((ch) => ch.trim()).map((ch) => ch.codePointAt(0)!);
        fontKept = needed.every((u) => available.has(u));
        // Put the new text where the old text was in reading order: before the first object that follows it.
        const anchorIndex = firstObj.parent ? -1 : pageIndexOf(c, page, firstObj.obj);
        removeChars(c, page, objects, chars, inRegion);
        const anchor = anchorIndex >= 0 && anchorIndex < c.m.FPDFPage_CountObjects(page) ? c.m.FPDFPage_GetObject(page, anchorIndex) : 0;
        if (text.trim()) {
          const font = fontKept ? style.font : c.m.FPDFText_LoadStandardFont(c.doc, closestStandard(fontName(c, style.font)));
          if (!addText(c, page, text, origin, style, font, anchor)) {
            fontKept = false;
            addText(c, page, text, origin, style, c.m.FPDFText_LoadStandardFont(c.doc, 'Helvetica'), anchor);
          }
        }
        if (!c.m.FPDFPage_GenerateContent(page)) throw new Error("Couldn't rewrite the page.");
      } finally {
        c.m.FPDF_ClosePage(page);
      }
    },
    true,
  );
  return { bytes: await cleanUp(out!), fontKept };
}

// ----- Images -----

export interface PageImage {
  /** Position among the page's top-level objects (valid for these exact bytes). */
  index: number;
  box: Box;
}

/** Images placed directly on each page (not inside reusable Form XObjects). */
export async function listImages(bytes: Uint8Array, pageIndex: number): Promise<PageImage[]> {
  const { result } = await withDoc(
    bytes,
    (c) => {
      const page = c.m.FPDF_LoadPage(c.doc, pageIndex);
      if (!page) return [];
      try {
        const out: PageImage[] = [];
        const n = c.m.FPDFPage_CountObjects(page);
        for (let i = 0; i < n; i++) {
          const obj = c.m.FPDFPage_GetObject(page, i);
          if (c.m.FPDFPageObj_GetType(obj) !== IMAGE) continue;
          const box = getBounds(c, obj);
          if (box && box.x2 - box.x1 > 2 && box.y2 - box.y1 > 2) out.push({ index: i, box });
        }
        return out;
      } finally {
        c.m.FPDF_ClosePage(page);
      }
    },
    false,
  );
  return result;
}

/** Moves/resizes an image (new box) or deletes it (box null). */
export async function editImage(bytes: Uint8Array, pageIndex: number, index: number, box: Box | null): Promise<Uint8Array> {
  const { bytes: out } = await withDoc(
    bytes,
    (c) => {
      const page = c.m.FPDF_LoadPage(c.doc, pageIndex);
      if (!page) throw new Error('Page not found.');
      try {
        const obj = c.m.FPDFPage_GetObject(page, index);
        if (!obj || c.m.FPDFPageObj_GetType(obj) !== IMAGE) throw new Error('That image is no longer there.');
        if (!box) {
          if (c.m.FPDFPage_RemoveObject(page, obj)) c.m.FPDFPageObj_Destroy(obj);
        } else {
          const old = getBounds(c, obj);
          if (!old) throw new Error('That image has no size.');
          const sx = (box.x2 - box.x1) / (old.x2 - old.x1);
          const sy = (box.y2 - box.y1) / (old.y2 - old.y1);
          c.m.FPDFPageObj_Transform(obj, sx, 0, 0, sy, box.x1 - sx * old.x1, box.y1 - sy * old.y1);
        }
        if (!c.m.FPDFPage_GenerateContent(page)) throw new Error("Couldn't rewrite the page.");
      } finally {
        c.m.FPDF_ClosePage(page);
      }
    },
    true,
  );
  return cleanUp(out!);
}

/** Adds a picture (RGBA pixels) to a page at `box`. */
export async function addImage(bytes: Uint8Array, pageIndex: number, box: Box, rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const { bytes: out } = await withDoc(
    bytes,
    (c) => {
      const page = c.m.FPDF_LoadPage(c.doc, pageIndex);
      if (!page) throw new Error('Page not found.');
      try {
        const opaque = rgba.every((v, i) => i % 4 !== 3 || v === 255);
        const bmp = c.m.FPDFBitmap_Create(width, height, opaque ? 0 : 1);
        try {
          const buf = c.m.FPDFBitmap_GetBuffer(bmp);
          const stride = c.m.FPDFBitmap_GetStride(bmp);
          // PDFium bitmaps are BGRA.
          const row = new Uint8Array(stride);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const s = (y * width + x) * 4;
              row[x * 4] = rgba[s + 2];
              row[x * 4 + 1] = rgba[s + 1];
              row[x * 4 + 2] = rgba[s];
              row[x * 4 + 3] = rgba[s + 3];
            }
            const heap = (c.m.pdfium as unknown as { HEAPU8?: Uint8Array }).HEAPU8;
            if (heap) heap.set(row, buf + y * stride);
            else row.forEach((v, i) => c.m.pdfium.setValue(buf + y * stride + i, v, 'i8'));
          }
          const img = c.m.FPDFPageObj_NewImageObj(c.doc);
          c.m.FPDFImageObj_SetBitmap(0, 0, img, bmp);
          setMatrix(c, img, [box.x2 - box.x1, 0, 0, box.y2 - box.y1, box.x1, box.y1]);
          c.m.FPDFPage_InsertObject(page, img);
        } finally {
          c.m.FPDFBitmap_Destroy(bmp);
        }
        if (!c.m.FPDFPage_GenerateContent(page)) throw new Error("Couldn't rewrite the page.");
      } finally {
        c.m.FPDF_ClosePage(page);
      }
    },
    true,
  );
  return cleanUp(out!);
}
