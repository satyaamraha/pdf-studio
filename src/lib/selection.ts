import { apply, boxFromPoints, invert, type Box, type Matrix } from './geometry';

export interface PageSelection {
  page: number;
  quads: number[][];
  text: string;
}

/**
 * Reads the current text selection in the viewer and returns, per page, one quad per
 * line of selected text in PDF coordinates. Used to create highlights, underlines and
 * strikethroughs.
 */
export function readSelection(matrixFor: (page: number) => Matrix): PageSelection[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];

  const byPage = new Map<number, { boxes: Box[]; text: string; el: HTMLElement }>();
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const root = range.commonAncestorContainer;
    const nodes: Text[] = [];
    if (root.nodeType === Node.TEXT_NODE) nodes.push(root as Text);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (range.intersectsNode(node)) nodes.push(node as Text);
      }
    }

    for (const node of nodes) {
      const span = node.parentElement;
      const pageEl = span?.closest<HTMLElement>('.page');
      if (!span || !pageEl || !span.closest('.textLayer')) continue;
      const page = Number(pageEl.dataset.page) - 1;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (end <= start || !node.data.slice(start, end).trim()) continue;

      const sub = document.createRange();
      sub.setStart(node, start);
      sub.setEnd(node, end);
      const pageBox = pageEl.getBoundingClientRect();
      const inv = invert(matrixFor(page));
      let entry = byPage.get(page);
      if (!entry) {
        entry = { boxes: [], text: '', el: pageEl };
        byPage.set(page, entry);
      }
      for (const r of sub.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const x1 = r.left - pageBox.left;
        const y1 = r.top - pageBox.top;
        const x2 = x1 + r.width;
        const y2 = y1 + r.height;
        entry.boxes.push(boxFromPoints([apply(inv, x1, y1), apply(inv, x2, y1), apply(inv, x1, y2), apply(inv, x2, y2)]));
      }
      entry.text += (entry.text && /\S$/.test(entry.text) && span.previousElementSibling?.tagName === 'BR' ? ' ' : '') + node.data.slice(start, end);
    }
  }

  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, { boxes, text }]) => ({
      page,
      quads: mergeLines(boxes).map((b) => [b.x1, b.y2, b.x2, b.y2, b.x1, b.y1, b.x2, b.y1]),
      text: text.replace(/\s+/g, ' ').trim(),
    }));
}

/** Joins boxes that sit on the same line and touch, so each line becomes one quad. */
function mergeLines(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => b.y2 - a.y2 || a.x1 - b.x1);
  const out: Box[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const h = Math.min(last.y2 - last.y1, b.y2 - b.y1);
      const overlap = Math.min(last.y2, b.y2) - Math.max(last.y1, b.y1);
      const gap = b.x1 - last.x2;
      if (overlap > h * 0.5 && gap < h * 1.5 && gap > -h * 3) {
        out[out.length - 1] = {
          x1: Math.min(last.x1, b.x1),
          y1: Math.min(last.y1, b.y1),
          x2: Math.max(last.x2, b.x2),
          y2: Math.max(last.y2, b.y2),
        };
        continue;
      }
    }
    out.push(b);
  }
  return out;
}
