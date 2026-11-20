import type forge from 'node-forge';
import {
  FontNames,
} from '@pdf-lib/standard-fonts';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFontEmbedder,
  type PDFObject,
} from 'pdf-lib';
import { buildCms } from './cms';
import type { Box } from './geometry';
import { textWidth, toWinAnsi } from './textMetrics';

/** Room reserved for the signature (certificates included). 16 KB fits typical chains. */
const SIGNATURE_BYTES = 16384;
const BYTE_RANGE_PLACEHOLDER = '/ByteRange [0 9999999999 9999999999 9999999999]';

export interface SignOptions {
  key: forge.pki.rsa.PrivateKey;
  chain: forge.pki.Certificate[];
  signerName: string;
  reason?: string;
  location?: string;
  /** Page and box for a visible signature; null for an invisible one. */
  placement: { page: number; box: Box } | null;
  /** Fill this existing, empty signature field instead of adding a new one. */
  fieldName?: string;
  /** Handwritten signature to show in the box (PNG). */
  imagePng?: Uint8Array;
}

const enc = new TextEncoder();
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function pdfDate(d: Date): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}

/** Offset of the previous cross-reference section (the last `startxref`). */
function lastStartXref(bytes: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error("Couldn't find the end of the PDF's cross-reference table.");
  return Number(m[1]);
}

function serialize(ref: PDFRef, obj: PDFObject): Uint8Array {
  const head = `${ref.objectNumber} ${ref.generationNumber} obj\n`;
  if (obj instanceof PDFStream) {
    const contents = obj.getContents();
    obj.dict.set(PDFName.of('Length'), PDFNumber.of(contents.length));
    const parts = [latin1(head + obj.dict.toString() + '\nstream\n'), contents, latin1('\nendstream\nendobj\n')];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  return latin1(`${head}${obj.toString()}\nendobj\n`);
}

/** Text for the visible signature box. */
function appearanceLines(o: SignOptions, when: Date): string[] {
  const lines = [`Digitally signed by ${o.signerName}`, `Date: ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`];
  if (o.reason) lines.push(`Reason: ${o.reason}`);
  if (o.location) lines.push(`Location: ${o.location}`);
  return lines;
}

/**
 * Signs a PDF by appending an incremental update: the original bytes stay exactly as
 * they are (so earlier signatures stay valid), followed by the signature field, its
 * appearance, the signature dictionary and a new cross-reference section.
 */
export async function signPdf(original: Uint8Array, o: SignOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  const ctx = pdf.context;
  const firstNew = ctx.largestObjectNumber + 1;
  const changed = new Map<string, PDFRef>();
  const touch = (ref: PDFRef) => changed.set(ref.toString(), ref);
  const when = new Date();

  // ----- the field (new or existing) -----
  const acroRefOrDict = pdf.catalog.get(PDFName.of('AcroForm'));
  let acro: PDFDict;
  if (acroRefOrDict instanceof PDFRef) {
    acro = ctx.lookup(acroRefOrDict, PDFDict);
    touch(acroRefOrDict);
  } else if (acroRefOrDict instanceof PDFDict) {
    acro = acroRefOrDict;
    touch(ctx.trailerInfo.Root as PDFRef);
  } else {
    acro = ctx.obj({ Fields: [] }) as PDFDict;
    const ref = ctx.register(acro);
    pdf.catalog.set(PDFName.of('AcroForm'), ref);
    touch(ctx.trailerInfo.Root as PDFRef);
  }
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) {
    fields = ctx.obj([]) as PDFArray;
    acro.set(PDFName.of('Fields'), fields);
  } else {
    const raw = acro.get(PDFName.of('Fields'));
    if (raw instanceof PDFRef) touch(raw);
  }

  const sigRef = ctx.nextRef();
  let widget: PDFDict;
  let widgetRef: PDFRef;
  let page = o.placement ? pdf.getPages()[o.placement.page] : pdf.getPages()[0];
  let box = o.placement?.box ?? { x1: 0, y1: 0, x2: 0, y2: 0 };

  const existing = o.fieldName ? findField(pdf, o.fieldName) : null;
  if (existing) {
    ({ widget, widgetRef } = existing);
    const fieldDict = existing.field;
    fieldDict.set(PDFName.of('V'), sigRef);
    touch(existing.fieldRef);
    touch(widgetRef);
    const rect = widget.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    box = { x1: Math.min(rect[0], rect[2]), y1: Math.min(rect[1], rect[3]), x2: Math.max(rect[0], rect[2]), y2: Math.max(rect[1], rect[3]) };
    const p = widget.get(PDFName.of('P'));
    const found = pdf.getPages().find((pg) => p instanceof PDFRef && pg.ref.toString() === p.toString());
    if (found) page = found;
  } else {
    const taken = new Set(pdf.getForm().getFields().map((f) => f.getName()));
    let name = 'Signature1';
    for (let i = 2; taken.has(name); i++) name = `Signature${i}`;
    widget = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFHexString.fromText(name),
      V: sigRef,
      F: 132, // print + locked
      Rect: [box.x1, box.y1, box.x2, box.y2],
      P: page.ref,
    }) as PDFDict;
    widgetRef = ctx.register(widget);
    fields.push(widgetRef);
    // Add the widget to the page's annotations.
    const annotsRaw = page.node.get(PDFName.of('Annots'));
    if (annotsRaw instanceof PDFRef) {
      ctx.lookup(annotsRaw, PDFArray).push(widgetRef);
      touch(annotsRaw);
    } else if (annotsRaw instanceof PDFArray) {
      annotsRaw.push(widgetRef);
      touch(page.ref);
    } else {
      page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
      touch(page.ref);
    }
  }

  // ----- the visible appearance -----
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  if (w > 1 && h > 1) {
    const font = StandardFontEmbedder.for(FontNames.Helvetica);
    const resources: Record<string, unknown> = { Font: { Helv: ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }) } };
    let ops = '';
    let textX = 3;
    let textW = w - 6;
    if (o.imagePng) {
      const image = await pdf.embedPng(o.imagePng);
      await image.embed();
      resources.XObject = { Im0: image.ref };
      const areaW = w * 0.45;
      const s = Math.min((areaW - 6) / image.width, (h - 6) / image.height);
      const iw = image.width * s;
      const ih = image.height * s;
      ops += `q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${(3 + (areaW - 6 - iw) / 2).toFixed(2)} ${((h - ih) / 2).toFixed(2)} cm /Im0 Do Q\n`;
      textX = areaW + 2;
      textW = w - areaW - 5;
    }
    const lines = appearanceLines(o, when);
    let fs = Math.min(10, (h - 6) / (lines.length * 1.25));
    const widest = Math.max(...lines.map((l) => textWidth(l, 1)));
    fs = Math.max(3, Math.min(fs, textW / widest));
    let y = h / 2 + (lines.length * fs * 1.25) / 2 - fs;
    ops += `BT /Helv ${fs.toFixed(2)} Tf 0.1 0.1 0.12 rg\n`;
    for (const l of lines) {
      ops += `1 0 0 1 ${textX.toFixed(2)} ${y.toFixed(2)} Tm ${font.encodeText(toWinAnsi(l)).toString()} Tj\n`;
      y -= fs * 1.25;
    }
    ops += 'ET';
    const ap = ctx.register(ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: ctx.obj(resources as never) }));
    widget.set(PDFName.of('AP'), ctx.obj({ N: ap }));
  }

  // ----- write the update -----
  const prev = lastStartXref(original);
  const prevIsTable = new TextDecoder('latin1').decode(original.subarray(prev, prev + 4)) === 'xref';
  const chunks: Uint8Array[] = [];
  let offset = original.length;
  const push = (b: Uint8Array) => {
    chunks.push(b);
    offset += b.length;
  };
  const offsets = new Map<number, number>();
  if (original[original.length - 1] !== 0x0a) push(latin1('\n'));

  // The signature dictionary, with placeholders filled in once everything else is written.
  const placeholder = '0'.repeat(SIGNATURE_BYTES * 2);
  const meta = [
    `/M ${PDFString.of(pdfDate(when)).toString()}`,
    `/Name ${PDFHexString.fromText(o.signerName).toString()}`,
    o.reason ? `/Reason ${PDFHexString.fromText(o.reason).toString()}` : '',
    o.location ? `/Location ${PDFHexString.fromText(o.location).toString()}` : '',
  ].join(' ');
  const sigText = `${sigRef.objectNumber} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached ${BYTE_RANGE_PLACEHOLDER} /Contents <${placeholder}> ${meta} >>\nendobj\n`;
  offsets.set(sigRef.objectNumber, offset);
  const sigStart = offset;
  push(latin1(sigText));

  const refs: PDFRef[] = [...changed.values()];
  for (const [ref] of ctx.enumerateIndirectObjects()) if (ref.objectNumber >= firstNew && ref.objectNumber !== sigRef.objectNumber) refs.push(ref);
  for (const ref of refs) {
    const obj = ctx.lookup(ref);
    if (!obj) continue;
    offsets.set(ref.objectNumber, offset);
    push(serialize(ref, obj));
  }

  const t = ctx.trailerInfo;
  const trailerExtras = [
    `/Root ${t.Root!.toString()}`,
    t.Info ? `/Info ${t.Info.toString()}` : '',
    t.ID ? `/ID ${t.ID.toString()}` : '',
    `/Prev ${prev}`,
  ].join(' ');
  if (prevIsTable) {
    const xrefAt = offset;
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    let table = 'xref\n';
    for (const n of nums) table += `${n} 1\n${String(offsets.get(n)).padStart(10, '0')} 00000 n\r\n`;
    push(latin1(`${table}trailer\n<< /Size ${ctx.largestObjectNumber + 1} ${trailerExtras} >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else {
    // The file uses a cross-reference stream; continue with one.
    const xrefNum = ctx.largestObjectNumber + 1;
    const xrefAt = offset;
    offsets.set(xrefNum, xrefAt);
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const rows = new Uint8Array(nums.length * 7);
    nums.forEach((n, i) => {
      const off = offsets.get(n)!;
      rows.set([1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, 0, 0], i * 7);
    });
    const index = nums.map((n) => `${n} 1`).join(' ');
    const dict = `<< /Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Index [${index}] ${trailerExtras} /Length ${rows.length} >>`;
    push(latin1(`${xrefNum} 0 obj\n${dict}\nstream\n`));
    push(rows);
    push(latin1(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }

  // ----- join, fill in the byte range, sign -----
  const total = offset;
  const out = new Uint8Array(total);
  out.set(original, 0);
  let o2 = original.length;
  for (const c of chunks) {
    out.set(c, o2);
    o2 += c.length;
  }
  const contentsStart = sigStart + sigText.indexOf('/Contents <') + '/Contents '.length;
  const contentsEnd = contentsStart + placeholder.length + 2;
  const range = [0, contentsStart, contentsEnd, total - contentsEnd];
  const brText = `/ByteRange [${range.join(' ')}]`.padEnd(BYTE_RANGE_PLACEHOLDER.length, ' ');
  out.set(latin1(brText), sigStart + sigText.indexOf('/ByteRange'));

  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(out.subarray(0, range[1]), 0);
  signed.set(out.subarray(range[2]), range[1]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', signed));
  const cms = buildCms(digest, o.key, o.chain);
  if (cms.length > SIGNATURE_BYTES) throw new Error('The certificate chain is too large to fit in the signature.');
  let hex = '';
  for (const b of cms) hex += b.toString(16).padStart(2, '0');
  out.set(enc.encode(hex), contentsStart + 1);
  return out;
}

function findField(pdf: PDFDocument, name: string): { field: PDFDict; fieldRef: PDFRef; widget: PDFDict; widgetRef: PDFRef } | null {
  const f = pdf.getForm().getFieldMaybe(name);
  if (!f) return null;
  const field = f.acroField.dict;
  const fieldRef = f.ref;
  const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids && kids.size()) {
    const widgetRef = kids.get(0) as PDFRef;
    return { field, fieldRef, widget: pdf.context.lookup(widgetRef, PDFDict), widgetRef };
  }
  return { field, fieldRef, widget: field, widgetRef: fieldRef };
}
