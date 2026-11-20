import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };
export type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

/** PDF points are 1/72 inch; CSS pixels are 1/96 inch. 100% zoom = real size. */
export const CSS_UNITS = 96 / 72;

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

export type PasswordReason = 'need' | 'incorrect';

/** Opens a PDF. Resolves to null if the user cancels the password prompt. */
export async function loadPdf(
  data: Uint8Array,
  askPassword: (reason: PasswordReason) => Promise<string | null>,
): Promise<PDFDocumentProxy | null> {
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
  });
  let cancelled = false;
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const why = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'need';
    void askPassword(why).then((password) => {
      if (password === null) {
        cancelled = true;
        void task.destroy();
      } else {
        update(password);
      }
    });
  };
  try {
    return await task.promise;
  } catch (err) {
    if (cancelled) return null;
    throw err;
  }
}

/** Page size in PDF points, including the page's own /Rotate. */
export interface PageSize {
  width: number;
  height: number;
}

export async function getPageSizes(doc: PDFDocumentProxy): Promise<PageSize[]> {
  const pages = await Promise.all(
    Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)),
  );
  return pages.map((page) => {
    const { width, height } = page.getViewport({ scale: 1 });
    return { width, height };
  });
}

export function rotatedSize(size: PageSize, rotation: number): PageSize {
  return rotation % 180 === 0 ? size : { width: size.height, height: size.width };
}

const textCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextContent>>>();

/** Text content of a page (0-based), cached per document. */
export function getText(doc: PDFDocumentProxy, index: number): Promise<TextContent> {
  let pages = textCache.get(doc);
  if (!pages) {
    pages = new Map();
    textCache.set(doc, pages);
  }
  let text = pages.get(index);
  if (!text) {
    text = doc.getPage(index + 1).then((page) => page.getTextContent());
    pages.set(index, text);
  }
  return text;
}

export interface OutlineNode {
  title: string;
  dest: unknown;
  url: string | null;
  items: OutlineNode[];
}

export async function getOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = await doc.getOutline();
  type RawNode = { title: string; dest: unknown; url: string | null; items: RawNode[] };
  const map = (nodes: RawNode[]): OutlineNode[] =>
    nodes.map((n) => ({ title: n.title, dest: n.dest, url: n.url ?? null, items: map(n.items ?? []) }));
  return map((raw ?? []) as RawNode[]);
}

export interface DestTarget {
  pageIndex: number;
  /** Vertical position on the page in PDF coordinates, if the destination gives one. */
  top: number | null;
}

/** Turns a named or explicit PDF destination into a page and position. */
export async function resolveDest(doc: PDFDocumentProxy, dest: unknown): Promise<DestTarget | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const [ref, mode, ...args] = explicit as [unknown, { name?: string } | undefined, ...unknown[]];
    let pageIndex: number;
    if (ref && typeof ref === 'object') {
      pageIndex = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
    } else if (Number.isInteger(ref)) {
      pageIndex = ref as number;
    } else {
      return null;
    }
    let top: unknown = null;
    switch (mode?.name) {
      case 'XYZ':
        top = args[1];
        break;
      case 'FitH':
      case 'FitBH':
        top = args[0];
        break;
      case 'FitR':
        top = args[3];
        break;
    }
    return { pageIndex, top: typeof top === 'number' ? top : null };
  } catch {
    return null;
  }
}
