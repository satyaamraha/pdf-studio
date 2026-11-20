import { FontNames } from '@pdf-lib/standard-fonts';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  StandardFontEmbedder,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import {
  annotBox,
  arrowHead,
  hexToRgb,
  NOTE_SIZE,
  smoothPath,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING,
  textLines,
  type Annotation,
} from './annotations';
import type { Box, Point } from './geometry';
import type { FieldDef, FieldValues } from './forms';
import { extractStudioFields, writeForm } from './pdfForms';
import { collectGarbage } from './pdfPages';
import { hasStudioMarker, STUDIO_KEY } from './pdfBytes';
import { textWidth, toWinAnsi } from './textMetrics';

/**
 * Every annotation PDF Studio writes carries the `/PDFStudio` key with its own data as
 * JSON, so reopening the file gives back editable annotations rather than flat drawings.
 */

/**
 * Pulls PDF Studio's own annotations out of a file. Returns the file without them
 * (what the viewer displays) and the annotations as editable objects.
 */
export interface Extracted {
  base: Uint8Array;
  items: Annotation[];
  defs: FieldDef[];
  fields: FieldValues;
}

export async function extractStudioAnnotations(bytes: Uint8Array): Promise<Extracted> {
  // Our appearance streams carry the marker in their (never compressed) dictionary,
  // so a byte scan tells cheaply whether there is anything to extract.
  if (!hasStudioMarker(bytes)) return { base: bytes, items: [], defs: [], fields: {} };
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const items: Annotation[] = [];
  pdf.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const keep: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const dict = pdf.context.lookup(entry);
      const data = dict instanceof PDFDict ? dict.get(PDFName.of(STUDIO_KEY)) : undefined;
      if (dict instanceof PDFDict && (data instanceof PDFHexString || data instanceof PDFString)) {
        try {
          const parsed = JSON.parse(data.decodeText()) as Annotation;
          items.push({ ...parsed, page: index });
          // Drop the old appearance stream along with the annotation.
          const ap = dict.lookup(PDFName.of('AP'));
          const normal = ap instanceof PDFDict ? ap.get(PDFName.of('N')) : undefined;
          if (normal instanceof PDFRef) pdf.context.delete(normal);
          if (entry instanceof PDFRef) pdf.context.delete(entry);
          continue;
        } catch {
          /* not ours after all: keep it */
        }
      }
      keep.push(entry);
    }
    if (keep.length !== annots.size()) page.node.set(PDFName.of('Annots'), pdf.context.obj(keep));
  });
  const { defs, fields } = extractStudioFields(pdf);
  if (!items.length && !defs.length) return { base: bytes, items, defs, fields };
  collectGarbage(pdf);
  const base = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
  return { base, items, defs, fields };
}

/** Writes annotations, placed fields and form values into a copy of `base` and returns the new file. */
export async function buildPdf(
  base: Uint8Array,
  items: Annotation[],
  defs: FieldDef[] = [],
  fields: FieldValues = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(base, { updateMetadata: false });
  await writeForm(pdf, defs, fields);
  const pages = pdf.getPages();
  for (const a of items) {
    const page = pages[a.page];
    if (!page) continue;
    const ref = pdf.context.register(annotationDict(pdf.context, page.ref, a));
    let annots = page.node.Annots();
    if (!annots) {
      annots = pdf.context.obj([]) as PDFArray;
      page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);
  }
  return pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
}

// ----- Building annotation dictionaries -----

type Literal = Parameters<PDFContext['obj']>[0];

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const rgb = (hex: string) => hexToRgb(hex).map(n).join(' ');

function pdfDate(iso: string): string {
  const d = new Date(iso);
  const p = (v: number) => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const embedders = new Map<boolean, StandardFontEmbedder>();
function encodeHelvetica(text: string, isBold = false): string {
  let e = embedders.get(isBold);
  if (!e) {
    e = StandardFontEmbedder.for(isBold ? FontNames.HelveticaBold : FontNames.Helvetica);
    embedders.set(isBold, e);
  }
  return e.encodeText(toWinAnsi(text)).toString();
}

const HELVETICA = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' };
const HELVETICA_BOLD = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold', Encoding: 'WinAnsiEncoding' };

function ellipsePath(b: Box): string {
  const k = 0.5523;
  const cx = (b.x1 + b.x2) / 2;
  const cy = (b.y1 + b.y2) / 2;
  const rx = (b.x2 - b.x1) / 2;
  const ry = (b.y2 - b.y1) / 2;
  return [
    `${n(cx + rx)} ${n(cy)} m`,
    `${n(cx + rx)} ${n(cy + ry * k)} ${n(cx + rx * k)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
    `${n(cx - rx * k)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ry * k)} ${n(cx - rx)} ${n(cy)} c`,
    `${n(cx - rx)} ${n(cy - ry * k)} ${n(cx - rx * k)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
    `${n(cx + rx * k)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ry * k)} ${n(cx + rx)} ${n(cy)} c`,
  ].join('\n');
}

function roundedRect(b: Box, r: number): string {
  const { x1, y1, x2, y2 } = b;
  const k = r * 0.4477;
  return [
    `${n(x1 + r)} ${n(y1)} m`,
    `${n(x2 - r)} ${n(y1)} l`,
    `${n(x2 - k)} ${n(y1)} ${n(x2)} ${n(y1 + k)} ${n(x2)} ${n(y1 + r)} c`,
    `${n(x2)} ${n(y2 - r)} l`,
    `${n(x2)} ${n(y2 - k)} ${n(x2 - k)} ${n(y2)} ${n(x2 - r)} ${n(y2)} c`,
    `${n(x1 + r)} ${n(y2)} l`,
    `${n(x1 + k)} ${n(y2)} ${n(x1)} ${n(y2 - k)} ${n(x1)} ${n(y2 - r)} c`,
    `${n(x1)} ${n(y1 + r)} l`,
    `${n(x1)} ${n(y1 + k)} ${n(x1 + k)} ${n(y1)} ${n(x1 + r)} ${n(y1)} c`,
    'h',
  ].join('\n');
}

function line(from: Point, to: Point): string {
  return `${n(from[0])} ${n(from[1])} m ${n(to[0])} ${n(to[1])} l`;
}

interface Built {
  subtype: string;
  rect: Box;
  content: string;
  resources?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contents: string;
}

function build(a: Annotation): Built {
  const color = rgb(a.color);
  const box = annotBox(a);
  const multiply = { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: a.opacity, ca: a.opacity } } };
  const alpha = { ExtGState: { GS0: { Type: 'ExtGState', CA: a.opacity, ca: a.opacity } } };

  switch (a.kind) {
    case 'highlight': {
      const paths = a.quads
        .map((q) => `${n(q[0])} ${n(q[1])} m ${n(q[2])} ${n(q[3])} l ${n(q[6])} ${n(q[7])} l ${n(q[4])} ${n(q[5])} l h`)
        .join('\n');
      return {
        subtype: 'Highlight',
        rect: box,
        content: `/GS0 gs ${color} rg\n${paths}\nf`,
        resources: multiply,
        extra: { QuadPoints: a.quads.flat() },
        contents: a.comment,
      };
    }
    case 'underline':
    case 'strike': {
      const strokes = a.quads
        .map((q) => {
          const h = Math.abs(q[1] - q[5]);
          const w = Math.max(0.75, h * 0.07);
          // Bottom edge for underline, middle for strikethrough.
          const t = a.kind === 'underline' ? 0.08 : 0.42;
          const y1 = q[5] + (q[1] - q[5]) * t;
          const y2 = q[7] + (q[3] - q[7]) * t;
          return `${n(w)} w ${n(q[4])} ${n(y1)} m ${n(q[6])} ${n(y2)} l S`;
        })
        .join('\n');
      return {
        subtype: a.kind === 'underline' ? 'Underline' : 'StrikeOut',
        rect: box,
        content: `/GS0 gs ${color} RG\n${strokes}`,
        resources: alpha,
        extra: { QuadPoints: a.quads.flat() },
        contents: a.comment,
      };
    }
    case 'note': {
      const { x, y } = a;
      const s = NOTE_SIZE;
      const body: Box = { x1: x + 1, y1: y - s * 0.78, x2: x + s - 1, y2: y - 1 };
      const content = [
        `/GS0 gs ${color} rg 0.25 0.25 0.25 RG 0.8 w`,
        roundedRect(body, 3),
        `${n(x + s * 0.25)} ${n(body.y1)} m ${n(x + s * 0.22)} ${n(y - s + 1)} l ${n(x + s * 0.5)} ${n(body.y1)} l`,
        'B',
        `1 1 1 RG 1.2 w`,
        line([x + 5, y - 6], [x + s - 5, y - 6]) + ' S',
        line([x + 5, y - 10], [x + s - 5, y - 10]) + ' S',
      ].join('\n');
      return {
        subtype: 'Text',
        rect: box,
        content,
        resources: alpha,
        extra: { Name: 'Comment', Open: false },
        contents: a.comment,
      };
    }
    case 'ink': {
      const paths = a.paths
        .map((p) => {
          const { start, curves } = smoothPath(p);
          return [
            `${n(start[0])} ${n(start[1])} m`,
            ...curves.map(([c1, c2, e]) => `${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(e[0])} ${n(e[1])} c`),
          ].join('\n');
        })
        .join('\n');
      return {
        subtype: 'Ink',
        rect: box,
        content: `/GS0 gs ${color} RG ${n(a.width)} w 1 J 1 j\n${paths}\nS`,
        resources: alpha,
        extra: { InkList: a.paths.map((p) => p.flat()), BS: { W: a.width, S: 'S' } },
        contents: a.comment,
      };
    }
    case 'rect':
    case 'ellipse': {
      const w = a.width;
      const inner: Box = { x1: a.box.x1 + w / 2, y1: a.box.y1 + w / 2, x2: a.box.x2 - w / 2, y2: a.box.y2 - w / 2 };
      const shape =
        a.kind === 'rect'
          ? `${n(inner.x1)} ${n(inner.y1)} ${n(inner.x2 - inner.x1)} ${n(inner.y2 - inner.y1)} re`
          : ellipsePath(inner);
      return {
        subtype: a.kind === 'rect' ? 'Square' : 'Circle',
        rect: a.box,
        content: `/GS0 gs ${color} RG ${n(w)} w\n${shape}\nS`,
        resources: alpha,
        extra: { BS: { W: w, S: 'S' } },
        contents: a.comment,
      };
    }
    case 'line':
    case 'arrow': {
      let content = `/GS0 gs ${color} RG ${n(a.width)} w 1 J 1 j\n${line(a.from, a.to)} S`;
      if (a.kind === 'arrow') {
        const [l, r] = arrowHead(a.from, a.to, a.width);
        content += `\n${n(l[0])} ${n(l[1])} m ${n(a.to[0])} ${n(a.to[1])} l ${n(r[0])} ${n(r[1])} l S`;
      }
      return {
        subtype: 'Line',
        rect: box,
        content,
        resources: alpha,
        extra: {
          L: [...a.from, ...a.to],
          LE: ['None', a.kind === 'arrow' ? 'OpenArrow' : 'None'],
          BS: { W: a.width, S: 'S' },
        },
        contents: a.comment,
      };
    }
    case 'text': {
      const fs = a.fontSize;
      const lines = textLines(a);
      let y = a.box.y2 - TEXT_PADDING - fs * 0.78;
      const ops = lines.map((l) => {
        const op = `1 0 0 1 ${n(a.box.x1 + TEXT_PADDING)} ${n(y)} Tm ${encodeHelvetica(l)} Tj`;
        y -= fs * TEXT_LINE_HEIGHT;
        return op;
      });
      return {
        subtype: 'FreeText',
        rect: a.box,
        content: `/GS0 gs BT /Helv ${n(fs)} Tf ${color} rg\n${ops.join('\n')}\nET`,
        resources: { ...alpha, Font: { Helv: HELVETICA } },
        extra: { DA: PDFString.of(`/Helv ${n(fs)} Tf ${color} rg`), BS: { W: 0 } },
        contents: a.text,
      };
    }
    case 'stamp': {
      const b = a.box;
      const w = b.x2 - b.x1;
      const h = b.y2 - b.y1;
      const fs = Math.max(4, Math.min(h * 0.46, (w - 16) / Math.max(1, textWidth(a.label, 1, true))));
      const tw = textWidth(a.label, fs, true);
      const inset: Box = { x1: b.x1 + 1.5, y1: b.y1 + 1.5, x2: b.x2 - 1.5, y2: b.y2 - 1.5 };
      const content = [
        `/GS0 gs ${color} RG ${color} rg 2.5 w`,
        roundedRect(inset, Math.min(6, h / 4)),
        'S',
        `BT /HelvB ${n(fs)} Tf 1 0 0 1 ${n(b.x1 + (w - tw) / 2)} ${n(b.y1 + h / 2 - fs * 0.36)} Tm ${encodeHelvetica(a.label, true)} Tj ET`,
      ].join('\n');
      return {
        subtype: 'Stamp',
        rect: b,
        content,
        resources: { ...alpha, Font: { HelvB: HELVETICA_BOLD } },
        extra: { Name: a.label.replace(/[^A-Za-z]/g, '') || 'Draft' },
        contents: a.comment,
      };
    }
  }
}

function annotationDict(context: PDFContext, pageRef: PDFRef, a: Annotation): PDFDict {
  const built = build(a);
  const r = built.rect;
  const rect = [r.x1, r.y1, r.x2, r.y2].map((v) => Math.round(v * 1000) / 1000);
  const appearance = context.register(
    context.stream(built.content, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: rect,
      Resources: (built.resources ?? {}) as Literal,
      // Streams are never packed into object streams, so this marker stays visible to `extractStudioAnnotations`.
      [STUDIO_KEY]: true,
    }),
  );
  const { page: _page, ...data } = a;
  void _page;
  const dict: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: built.subtype,
    Rect: rect,
    F: 4,
    P: pageRef,
    NM: PDFHexString.fromText(`pdfstudio-${a.id}`),
    M: PDFString.of(pdfDate(a.modified)),
    CreationDate: PDFString.of(pdfDate(a.created)),
    C: hexToRgb(a.color),
    CA: a.opacity,
    AP: { N: appearance },
    [STUDIO_KEY]: PDFHexString.fromText(JSON.stringify(data)),
    ...built.extra,
  };
  if (a.author) dict.T = PDFHexString.fromText(a.author);
  if (built.contents) dict.Contents = PDFHexString.fromText(built.contents);
  return context.obj(dict as Literal) as unknown as PDFDict;
}
