import type { PDFDocumentProxy, TextContent } from './pdf';
import { getText } from './pdf';

/** Part of a match inside one text item (one span of the text layer). */
export interface HitRange {
  item: number;
  from: number;
  to: number;
}

export interface SearchHit {
  /** Index in the overall result list. */
  id: number;
  page: number;
  ranges: HitRange[];
}

interface PageText {
  text: string;
  /** Offset in `text` where each text item starts. */
  starts: number[];
  lengths: number[];
}

function buildPageText(content: TextContent): PageText {
  let text = '';
  const starts: number[] = [];
  const lengths: number[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    starts.push(text.length);
    lengths.push(item.str.length);
    text += item.str;
    // Treat line breaks as spaces so phrases that wrap still match.
    if (item.hasEOL) text += ' ';
  }
  return { text, starts, lengths };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeMatcher(query: string, matchCase: boolean): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join('\\s+'), matchCase ? 'g' : 'gi');
}

function rangesFor(pt: PageText, start: number, end: number): HitRange[] {
  const ranges: HitRange[] = [];
  // Binary search for the first item that could contain `start`.
  let lo = 0;
  let hi = pt.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pt.starts[mid] <= start) lo = mid;
    else hi = mid - 1;
  }
  for (let i = lo; i < pt.starts.length && pt.starts[i] < end; i++) {
    const itemStart = pt.starts[i];
    const from = Math.max(start, itemStart) - itemStart;
    const to = Math.min(end, itemStart + pt.lengths[i]) - itemStart;
    if (to > from) ranges.push({ item: i, from, to });
  }
  return ranges;
}

/**
 * Searches every page in order, reporting results as they arrive.
 * Stops early when `signal` is aborted.
 */
export async function searchDocument(
  doc: PDFDocumentProxy,
  matcher: RegExp,
  signal: AbortSignal,
  onProgress: (hits: SearchHit[], pagesDone: number) => void,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  let lastReport = performance.now();
  for (let page = 0; page < doc.numPages; page++) {
    if (signal.aborted) return hits;
    const pt = buildPageText(await getText(doc, page));
    if (signal.aborted) return hits;
    matcher.lastIndex = 0;
    for (let m = matcher.exec(pt.text); m; m = matcher.exec(pt.text)) {
      if (m[0].length === 0) {
        matcher.lastIndex++;
        continue;
      }
      const ranges = rangesFor(pt, m.index, m.index + m[0].length);
      if (ranges.length) hits.push({ id: hits.length, page, ranges });
    }
    if (performance.now() - lastReport > 100) {
      lastReport = performance.now();
      onProgress(hits.slice(), page + 1);
    }
  }
  onProgress(hits.slice(), doc.numPages);
  return hits;
}
