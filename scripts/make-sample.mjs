// Generates public/samples/sample.pdf: a multi-page test document with an outline,
// internal and external links, and a landscape page. Run with `npm run sample`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFString, StandardFonts, rgb } from 'pdf-lib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'sample.pdf');

const chapters = [
  'Getting Started',
  'Reading Documents',
  'Searching Text',
  'Navigating with the Outline',
  'Zoom and Rotation',
  'Night Reading',
  'Keyboard Shortcuts',
  'Working with Large Files',
  'Annotations (coming soon)',
  'Signatures (coming soon)',
];

const lorem =
  'The quick brown fox jumps over the lazy dog. Portable documents keep their layout on every screen, ' +
  'which is why they remain the standard for contracts, invoices and reports. A good reader renders pages ' +
  'quickly, lets you select and copy text, and finds words in an instant. This paragraph repeats so that ' +
  'every page has enough text to exercise selection, search highlighting and line wrapping.';

const doc = await PDFDocument.create();
doc.setTitle('PDF Studio Sample');
doc.setAuthor('PDF Studio');
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

function wrap(text, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const ctx = doc.context;
const dest = (page, top) => ctx.obj([page.ref, PDFName.of('XYZ'), PDFNull, PDFNumber.of(top), PDFNull]);
const linkAnnot = (rect, action) =>
  ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], ...action }));

// Contents page first; links are added after the chapter pages exist.
const toc = doc.addPage([612, 792]);
toc.drawText('PDF Studio Sample', { x: 72, y: 700, size: 28, font: bold, color: rgb(0.2, 0.33, 0.88) });
toc.drawText('A test document for the viewer', { x: 72, y: 672, size: 13, font, color: rgb(0.4, 0.4, 0.45) });
toc.drawText('Contents', { x: 72, y: 620, size: 16, font: bold });

const pages = [];
chapters.forEach((title, i) => {
  const landscape = i === 4;
  const page = doc.addPage(landscape ? [792, 612] : [612, 792]);
  const { width, height } = page.getSize();
  page.drawText(`Chapter ${i + 1}`, { x: 72, y: height - 90, size: 12, font, color: rgb(0.45, 0.45, 0.5) });
  page.drawText(title, { x: 72, y: height - 120, size: 24, font: bold });
  let y = height - 170;
  for (let p = 0; p < (landscape ? 3 : 5); p++) {
    for (const line of wrap(lorem, 11, width - 144)) {
      page.drawText(line, { x: 72, y, size: 11, font, lineHeight: 15 });
      y -= 15;
    }
    y -= 12;
  }
  if (landscape) page.drawText('This page is landscape.', { x: 72, y: y - 10, size: 14, font: bold, color: rgb(0.8, 0.3, 0.2) });
  page.drawText(`${i + 2}`, { x: width / 2 - 4, y: 40, size: 10, font, color: rgb(0.5, 0.5, 0.55) });
  pages.push(page);
});

// Contents entries link to each chapter.
const tocAnnots = [];
chapters.forEach((title, i) => {
  const y = 590 - i * 24;
  toc.drawText(`${i + 1}.  ${title}`, { x: 84, y, size: 12, font, color: rgb(0.2, 0.33, 0.88) });
  toc.drawText(String(i + 2), { x: 520, y, size: 12, font });
  const page = pages[i];
  tocAnnots.push(linkAnnot([80, y - 5, 540, y + 14], { Dest: dest(page, page.getSize().height - 60) }));
});
const url = 'https://mozilla.github.io/pdf.js/';
toc.drawText('Rendering powered by PDF.js (external link)', { x: 72, y: 300, size: 12, font, color: rgb(0.2, 0.33, 0.88) });
tocAnnots.push(linkAnnot([70, 295, 330, 314], { A: ctx.obj({ S: 'URI', URI: PDFString.of(url) }) }));
toc.node.set(PDFName.of('Annots'), ctx.obj(tocAnnots));

// Outline (bookmarks), with two nested entries under chapter 1.
const outlinesRef = ctx.nextRef();
const itemRefs = chapters.map(() => ctx.nextRef());
const childRefs = [ctx.nextRef(), ctx.nextRef()];
chapters.forEach((title, i) => {
  const page = pages[i];
  const item = {
    Title: PDFHexString.fromText(`${i + 1}. ${title}`),
    Parent: outlinesRef,
    Dest: dest(page, page.getSize().height - 60),
  };
  if (i > 0) item.Prev = itemRefs[i - 1];
  if (i < chapters.length - 1) item.Next = itemRefs[i + 1];
  if (i === 0) Object.assign(item, { First: childRefs[0], Last: childRefs[1], Count: 2 });
  ctx.assign(itemRefs[i], ctx.obj(item));
});
['Installing', 'Opening a file'].forEach((title, j) => {
  const item = { Title: PDFHexString.fromText(title), Parent: itemRefs[0], Dest: dest(pages[0], 600 - j * 120) };
  if (j === 0) item.Next = childRefs[1];
  else item.Prev = childRefs[0];
  ctx.assign(childRefs[j], ctx.obj(item));
});
ctx.assign(
  outlinesRef,
  ctx.obj({ Type: 'Outlines', First: itemRefs[0], Last: itemRefs.at(-1), Count: chapters.length }),
);
doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await doc.save());
console.log(`Wrote ${out} (${doc.getPageCount()} pages)`);
