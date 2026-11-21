import { strToU8, zipSync } from 'fflate';
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from './pdf';

/**
 * Export to Word (.docx). PDFs don't store paragraphs, only positioned text, so the text is
 * regrouped into lines and paragraphs; headings, bold/italic, fonts, sizes and pictures are
 * kept. Simple documents come out well; columns, tables and complex layouts approximately.
 */

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  font: string;
  size: number;
}

interface Line {
  y: number; // baseline, PDF coordinates (higher = nearer the top)
  x1: number;
  x2: number;
  size: number;
  runs: Run[];
}

type Block =
  | { kind: 'para'; top: number; lines: Line[]; size: number; align: 'left' | 'center' }
  | { kind: 'image'; top: number; png: Uint8Array; width: number; height: number };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// XML 1.0 can't hold most control characters.
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

interface FontInfo {
  bold: boolean;
  italic: boolean;
  family: string;
}

function fontInfo(page: PDFPageProxy, id: string, fallbackFamily: string): FontInfo {
  let name = '';
  let bold = false;
  let italic = false;
  try {
    const f = page.commonObjs.get(id) as { name?: string; bold?: boolean; italic?: boolean; black?: boolean } | undefined;
    name = f?.name ?? '';
    bold = !!(f?.bold || f?.black);
    italic = !!f?.italic;
  } catch {
    /* font not loaded */
  }
  const plain = name.replace(/^[A-Z]{6}\+/, '');
  if (/bold|black|heavy|semibold|demi/i.test(plain)) bold = true;
  if (/italic|oblique/i.test(plain)) italic = true;
  let family = plain.replace(/[-,](Bold|Italic|Oblique|Regular|Roman|BoldItalic|BoldOblique|Black|Medium|Light|Semibold|MT|PS).*$/i, '').replace(/(MT|PS)$/, '');
  if (!family || /^(F\d+|T\d+|TT\d+|g_d\d+)/i.test(family)) family = fallbackFamily === 'serif' ? 'Times New Roman' : fallbackFamily === 'monospace' ? 'Courier New' : 'Arial';
  return { bold, italic, family };
}

async function imageToPng(page: PDFPageProxy, id: string): Promise<Uint8Array | null> {
  const img = await new Promise<{ width: number; height: number; data?: Uint8ClampedArray; kind?: number; bitmap?: ImageBitmap } | null>((resolve) => {
    try {
      page.objs.get(id, resolve);
    } catch {
      resolve(null);
    }
    setTimeout(() => resolve(null), 4000);
  });
  if (!img || !img.width || !img.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const out = ctx.createImageData(img.width, img.height);
    const n = img.width * img.height;
    const src = img.data;
    // kind: 1 = 1-bit grey, 2 = RGB, 3 = RGBA
    if (img.kind === 3) out.data.set(src.subarray(0, n * 4));
    else if (img.kind === 2) for (let i = 0; i < n; i++) out.data.set([src[i * 3], src[i * 3 + 1], src[i * 3 + 2], 255], i * 4);
    else {
      const rowBytes = (img.width + 7) >> 3;
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const v = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          out.data.set([v, v, v, 255], (y * img.width + x) * 4);
        }
    }
    ctx.putImageData(out, 0, 0);
  } else return null;
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

async function pageBlocks(page: PDFPageProxy): Promise<{ blocks: Block[]; width: number; height: number; bodySizes: number[] }> {
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList(); // also loads the fonts used
  const tc = await page.getTextContent();
  const blocks: Block[] = [];
  const bodySizes: number[] = [];

  // Text items → lines.
  const items = tc.items
    .filter((i): i is typeof i & { str: string; transform: number[]; width: number; fontName: string } => 'str' in i && !!i.str)
    .map((i) => {
      const [a, b, c, d, e, f] = i.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b);
      const fi = fontInfo(page, i.fontName, tc.styles[i.fontName]?.fontFamily ?? 'sans-serif');
      return { str: i.str, x: e, y: f, w: i.width, size, ...fi };
    })
    .filter((i) => i.size > 0.5);
  items.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: Line[] = [];
  for (const it of items) {
    let line = lines.find((l) => Math.abs(l.y - it.y) < Math.max(l.size, it.size) * 0.35);
    if (!line) {
      line = { y: it.y, x1: it.x, x2: it.x + it.w, size: it.size, runs: [] };
      lines.push(line);
    }
    line.runs.push({ text: it.str, bold: it.bold, italic: it.italic, font: it.family, size: it.size, x: it.x, w: it.w } as Run & { x: number; w: number });
    line.x1 = Math.min(line.x1, it.x);
    line.x2 = Math.max(line.x2, it.x + it.w);
    line.size = Math.max(line.size, it.size);
    for (let k = 0; k < it.str.length; k++) bodySizes.push(it.size);
  }
  for (const l of lines) {
    // Order the pieces left to right and add spaces where there are gaps.
    const runs = (l.runs as (Run & { x: number; w: number })[]).sort((p, q) => p.x - q.x);
    const merged: Run[] = [];
    let prevEnd = -Infinity;
    for (const r of runs) {
      const gap = r.x - prevEnd;
      let text = r.text;
      const last = merged[merged.length - 1];
      if (last && gap > r.size * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(text)) text = ' ' + text;
      if (last && last.bold === r.bold && last.italic === r.italic && last.font === r.font && Math.abs(last.size - r.size) < 0.5) last.text += text;
      else merged.push({ text, bold: r.bold, italic: r.italic, font: r.font, size: r.size });
      prevEnd = r.x + r.w;
    }
    l.runs = merged;
  }
  lines.sort((p, q) => q.y - p.y);

  // Lines → paragraphs.
  let para: Line[] = [];
  const flush = () => {
    if (!para.length) return;
    const centred = para.every((l) => {
      const left = l.x1;
      const right = vp.width - l.x2;
      return Math.abs(left - right) < vp.width * 0.06 && l.x2 - l.x1 < vp.width * 0.8;
    });
    blocks.push({ kind: 'para', top: para[0].y + para[0].size, lines: para, size: Math.max(...para.map((l) => l.size)), align: centred ? 'center' : 'left' });
    para = [];
  };
  for (const l of lines) {
    const prev = para[para.length - 1];
    if (prev) {
      const gap = prev.y - l.y;
      const sameSize = Math.abs(prev.size - l.size) / prev.size < 0.15;
      const indentJump = Math.abs(l.x1 - para[0].x1) > l.size * 4;
      if (!sameSize || gap > prev.size * 1.75 || indentJump) flush();
    }
    para.push(l);
  }
  flush();

  // Pictures, with where they sit on the page.
  const { fnArray, argsArray } = ops;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === pdfjs.OPS.save) stack.push(ctm);
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === pdfjs.OPS.transform) ctm = mul(argsArray[i] as M, ctm);
    else if (fn === pdfjs.OPS.paintImageXObject) {
      const [id] = argsArray[i] as [string];
      const corners = [
        [ctm[4], ctm[5]],
        [ctm[0] + ctm[4], ctm[1] + ctm[5]],
        [ctm[2] + ctm[4], ctm[3] + ctm[5]],
        [ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]],
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      if (width < 8 || height < 8) continue; // decorations
      const png = await imageToPng(page, id);
      if (png) blocks.push({ kind: 'image', top: Math.max(...ys), png, width, height });
    }
  }
  blocks.sort((p, q) => q.top - p.top);
  return { blocks, width: vp.width, height: vp.height, bodySizes };
}

function median(values: number[]): number {
  if (!values.length) return 11;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Converts a finished PDF to a .docx file. */
export async function pdfToDocx(pdf: Uint8Array, onProgress: (done: number, total: number) => void): Promise<Uint8Array> {
  const doc: PDFDocumentProxy = await pdfjs.getDocument({ data: pdf.slice(), isEvalSupported: false }).promise;
  try {
    const pages: Awaited<ReturnType<typeof pageBlocks>>[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress(i - 1, doc.numPages);
      pages.push(await pageBlocks(await doc.getPage(i)));
    }
    onProgress(doc.numPages, doc.numPages);
    const body = median(pages.flatMap((p) => p.bodySizes));
    const media: { name: string; png: Uint8Array }[] = [];
    const pageW = pages[0]?.width ?? 612;
    const pageH = pages[0]?.height ?? 792;
    const margin = 54; // 0.75 inch
    const textWidth = pageW - margin * 2;
    const xml: string[] = [];
    let drawingId = 1;

    pages.forEach((p, pi) => {
      for (const b of p.blocks) {
        if (b.kind === 'image') {
          media.push({ name: `image${media.length + 1}.png`, png: b.png });
          const rid = `rIdImg${media.length}`;
          const scale = Math.min(1, textWidth / b.width);
          const cx = Math.round(b.width * scale * 12700);
          const cy = Math.round(b.height * scale * 12700);
          const id = drawingId++;
          xml.push(
            `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
              `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
              `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${media[media.length - 1].name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
              `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
              `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
          );
          continue;
        }
        const ratio = b.size / body;
        const style = ratio >= 1.8 ? 'Heading1' : ratio >= 1.3 ? 'Heading2' : null;
        // Join the paragraph's lines; words split with a hyphen at a line end are rejoined.
        const runs: Run[] = [];
        b.lines.forEach((l, li) => {
          l.runs.forEach((r, ri) => {
            let text = r.text;
            if (ri === 0 && li > 0) {
              const last = runs[runs.length - 1];
              if (last && /[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(text.trimStart())) last.text = last.text.slice(0, -1);
              else if (last && !/\s$/.test(last.text)) text = ' ' + text.trimStart();
            }
            const prev = runs[runs.length - 1];
            if (prev && prev.bold === r.bold && prev.italic === r.italic && prev.font === r.font && Math.abs(prev.size - r.size) < 0.5) prev.text += text;
            else runs.push({ ...r, text });
          });
        });
        const pPr = `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${b.align === 'center' ? '<w:jc w:val="center"/>' : ''}</w:pPr>`;
        const rs = runs
          .filter((r) => clean(r.text))
          .map((r) => {
            const rPr = `<w:rPr><w:rFonts w:ascii="${esc(r.font)}" w:hAnsi="${esc(r.font)}" w:cs="${esc(r.font)}"/>${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}<w:sz w:val="${Math.max(2, Math.round(r.size * 2))}"/></w:rPr>`;
            return `<w:r>${rPr}<w:t xml:space="preserve">${esc(clean(r.text))}</w:t></w:r>`;
          })
          .join('');
        xml.push(`<w:p>${pPr}${rs}</w:p>`);
      }
      if (pi < pages.length - 1) xml.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    });

    const twips = (pt: number) => Math.round(pt * 20);
    const document =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
      `<w:body>${xml.join('')}<w:sectPr><w:pgSz w:w="${twips(pageW)}" w:h="${twips(pageH)}"/><w:pgMar w:top="${twips(margin)}" w:right="${twips(margin)}" w:bottom="${twips(margin)}" w:left="${twips(margin)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

    const styles =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="${Math.round(body * 2)}"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>` +
      `</w:styles>`;

    const rels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      media.map((m, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('') +
      `</Relationships>`;

    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
          `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
      ),
      '_rels/.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
      ),
      'docProps/core.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
          `<dc:creator>PDF Studio</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`,
      ),
      'word/document.xml': strToU8(document),
      'word/styles.xml': strToU8(styles),
      'word/_rels/document.xml.rels': strToU8(rels),
    };
    for (const m of media) files[`word/media/${m.name}`] = m.png;
    return zipSync(files, { level: 6 });
  } finally {
    void doc.destroy();
  }
}
