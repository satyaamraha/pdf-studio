import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CSS_UNITS, rotatedSize, type PageSize, type PDFDocumentProxy } from '../lib/pdf';
import type { SearchHit } from '../lib/search';
import type { Annotation } from '../lib/annotations';
import { pageMatrix } from '../lib/geometry';
import { clampScale, type LinkTarget, type Zoom } from '../lib/view';
import type { Widget } from '../lib/forms';
import type { AnnotUi } from './AnnotationLayer';
import type { FormUi } from './FormLayer';
import { PageView } from './PageView';

const NO_ANNOTS: Annotation[] = [];
const NO_WIDGETS: Widget[] = [];

const GAP = 14; // space between pages
const PAD_Y = 18; // space above the first and below the last page
const PAD_X = 24; // minimum space either side of a page

export interface ViewerApi {
  /** Scrolls to a page (0-based), optionally to a vertical position given in PDF coordinates. */
  goTo(index: number, pdfTop?: number | null): void;
  /** True if the page is currently on screen or just off it (and therefore drawn). */
  isMounted(index: number): boolean;
}

interface Props {
  doc: PDFDocumentProxy;
  sizes: PageSize[];
  zoom: Zoom;
  rotation: number;
  initialPage: number;
  night: boolean;
  hitsByPage: Map<number, SearchHit[]>;
  activeHit: number;
  apiRef: RefObject<ViewerApi | null>;
  annotsByPage: Map<number, Annotation[]>;
  annotUi: AnnotUi;
  placedByPage: Map<number, Widget[]>;
  formUi: FormUi;
  onPageChange: (page: number) => void;
  onScaleChange: (scale: number) => void;
  onZoomBy: (factor: number) => void;
  onLink: (link: LinkTarget) => void;
}

/** Index of the last page whose top is at or above `y`. */
function pageAt(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function Viewer(props: Props) {
  const { doc, sizes, zoom, rotation, initialPage, night, hitsByPage, activeHit, apiRef, annotsByPage, annotUi, placedByPage, formUi } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // Keep the latest callbacks without re-running effects when they change.
  const cb = useRef(props);
  cb.current = props;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (typeof zoom === 'number') return clampScale(zoom);
    if (!box.width) return 1;
    const first = rotatedSize(sizes[0], rotation);
    const fitWidth = (box.width - PAD_X * 2) / (first.width * CSS_UNITS);
    if (zoom === 'page-width') return clampScale(fitWidth);
    const fitHeight = (box.height - PAD_Y * 2) / (first.height * CSS_UNITS);
    return clampScale(Math.min(fitWidth, fitHeight));
  }, [zoom, box, sizes, rotation]);

  useEffect(() => cb.current.onScaleChange(scale), [scale]);

  const layout = useMemo(() => {
    const tops: number[] = [];
    const dims: { width: number; height: number }[] = [];
    let y = PAD_Y;
    let maxWidth = 0;
    for (const size of sizes) {
      const r = rotatedSize(size, rotation);
      const width = r.width * CSS_UNITS * scale;
      const height = r.height * CSS_UNITS * scale;
      tops.push(y);
      dims.push({ width, height });
      y += height + GAP;
      maxWidth = Math.max(maxWidth, width);
    }
    const contentWidth = Math.max(box.width, maxWidth + PAD_X * 2);
    return { tops, dims, totalHeight: y - GAP + PAD_Y, contentWidth };
  }, [sizes, rotation, scale, box.width]);

  // PDF space -> on-screen pixels, per page, for annotations.
  const matrices = useMemo(
    () => sizes.map((s) => pageMatrix(s.view, (s.rotate + rotation) % 360, scale * CSS_UNITS)),
    [sizes, rotation, scale],
  );

  const layoutRef = useRef(layout);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const currentRef = useRef(-1);
  // Where the reader is, as page + fraction, so zooming keeps the same spot in view.
  const anchor = useRef({ page: initialPage, fraction: 0, centerX: 0.5 });
  const ready = useRef(false);
  /**
   * When zooming with the pointer or fingers, the spot under them should stay put.
   * Stored as page + fraction (vertical) and fraction of content width (horizontal),
   * plus where on screen it was.
   */
  const focus = useRef<{ page: number; fy: number; fx: number; sx: number; sy: number } | null>(null);
  /** Scale the zoom is heading to while several wheel/pinch steps arrive before a re-render. */
  const pendingScale = useRef<number | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const captureFocus = useCallback((clientX: number, clientY: number) => {
    const el = scrollRef.current;
    const { tops, dims, contentWidth } = layoutRef.current;
    if (!el || !tops.length) return;
    const r = el.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const y = el.scrollTop + sy;
    const page = pageAt(tops, y);
    focus.current = {
      page,
      fy: (y - tops[page]) / (dims[page].height + GAP),
      fx: (el.scrollLeft + sx) / contentWidth,
      sx,
      sy,
    };
  }, []);

  /** Zooms by `factor`, keeping the point at (clientX, clientY) under the pointer. */
  const zoomAt = useCallback(
    (factor: number, clientX: number, clientY: number) => {
      if (!focus.current) captureFocus(clientX, clientY);
      const base = pendingScale.current ?? scaleRef.current;
      const next = clampScale(base * factor);
      if (Math.abs(next - base) < 0.001) {
        // Already at the zoom limit: nothing will re-layout, so don't keep the focus point.
        if (pendingScale.current === null) focus.current = null;
        return;
      }
      pendingScale.current = next;
      cb.current.onZoomBy(next / scaleRef.current);
    },
    [captureFocus],
  );

  const update = useCallback(() => {
    const el = scrollRef.current;
    const { tops, dims, totalHeight } = layoutRef.current;
    if (!el || !tops.length) return;
    const top = el.scrollTop;
    const view = el.clientHeight;
    const first = pageAt(tops, top);
    const last = pageAt(tops, top + view);
    // Draw one page beyond each edge so scrolling doesn't reveal blank pages.
    const from = Math.max(0, first - 1);
    const to = Math.min(tops.length - 1, last + 1);
    setRange((r) => (r[0] === from && r[1] === to ? r : [from, to]));

    const atBottom = top + view >= totalHeight - 2;
    const current = atBottom ? last : pageAt(tops, top + view * 0.35);
    if (current !== currentRef.current) {
      currentRef.current = current;
      cb.current.onPageChange(current);
    }
    anchor.current = {
      page: first,
      fraction: (top - tops[first]) / (dims[first].height + GAP),
      centerX: el.scrollWidth ? (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth : 0.5,
    };
  }, []);

  // Re-apply the reading position whenever the layout changes (zoom, rotate, resize).
  useLayoutEffect(() => {
    layoutRef.current = layout;
    const el = scrollRef.current;
    if (!el || !box.width) return;
    const { page, fraction, centerX } = anchor.current;
    const p = Math.min(page, layout.tops.length - 1);
    pendingScale.current = null;
    const f = focus.current;
    if (!ready.current) {
      ready.current = true;
      el.scrollTop = p === 0 ? 0 : layout.tops[p] - GAP / 2;
    } else if (f && f.page < layout.tops.length) {
      focus.current = null;
      el.scrollTop = layout.tops[f.page] + f.fy * (layout.dims[f.page].height + GAP) - f.sy;
      el.scrollLeft = f.fx * layout.contentWidth - f.sx;
    } else {
      el.scrollTop = layout.tops[p] + fraction * (layout.dims[p].height + GAP);
      el.scrollLeft = centerX * el.scrollWidth - el.clientWidth / 2;
    }
    update();
  }, [layout, box.width, update]);

  useEffect(() => {
    apiRef.current = {
      goTo(index, pdfTop) {
        const el = scrollRef.current;
        const { tops } = layoutRef.current;
        if (!el || index < 0 || index >= tops.length) return;
        if (pdfTop == null) {
          el.scrollTop = index === 0 ? 0 : tops[index] - GAP / 2;
          return;
        }
        void doc.getPage(index + 1).then((page) => {
          const vp = page.getViewport({ scale: scale * CSS_UNITS, rotation: (page.rotate + rotation) % 360 });
          const [, y] = vp.convertToViewportPoint(0, pdfTop);
          el.scrollTop = tops[index] + Math.max(0, y) - 8;
        });
      },
      isMounted(index) {
        return index >= range[0] && index <= range[1];
      },
    };
  }, [apiRef, doc, scale, rotation, range]);

  // Trackpad pinch and Ctrl/Cmd + mouse wheel: zoom towards the pointer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = Math.max(-25, Math.min(25, e.deltaY));
      zoomAt(Math.exp(-delta * 0.01), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Two-finger pinch on touch screens. While pinching, the pages are stretched with a CSS
  // transform (instant); when the fingers lift, the real zoom is applied and pages redraw sharp.
  const pagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let start: { dist: number; cx: number; cy: number } | null = null;
    let ratio = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      start = { dist: dist(e.touches), cx, cy };
      ratio = 1;
      const r = el.getBoundingClientRect();
      if (pagesRef.current) pagesRef.current.style.transformOrigin = `${el.scrollLeft + cx - r.left}px ${el.scrollTop + cy - r.top}px`;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const s = scaleRef.current;
      ratio = clampScale(s * (dist(e.touches) / start.dist)) / s;
      if (pagesRef.current) pagesRef.current.style.transform = `scale(${ratio})`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || e.touches.length >= 2) return;
      if (pagesRef.current) pagesRef.current.style.transform = '';
      if (Math.abs(ratio - 1) > 0.02) {
        focus.current = null;
        captureFocus(start.cx, start.cy);
        zoomAt(ratio, start.cx, start.cy);
      }
      start = null;
    };
    // Safari's own pinch gesture would zoom the whole app instead.
    const stopGesture = (e: Event) => e.preventDefault();
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('gesturestart', stopGesture);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('gesturestart', stopGesture);
    };
  }, [captureFocus, zoomAt]);

  const onScroll = useCallback(() => update(), [update]);
  const onLink = useCallback((l: LinkTarget) => cb.current.onLink(l), []);

  const pages = [];
  for (let i = range[0]; i <= range[1] && i < layout.tops.length; i++) {
    const { width, height } = layout.dims[i];
    pages.push(
      <PageView
        key={i}
        doc={doc}
        index={i}
        top={layout.tops[i]}
        left={(layout.contentWidth - width) / 2}
        width={width}
        height={height}
        scale={scale}
        rotation={rotation}
        hits={hitsByPage.get(i)}
        activeHit={hitsByPage.has(i) ? activeHit : -1}
        onLink={onLink}
        matrix={matrices[i]}
        annots={annotsByPage.get(i) ?? NO_ANNOTS}
        ui={annotUi}
        placed={placedByPage.get(i) ?? NO_WIDGETS}
        formUi={formUi}
      />,
    );
  }

  return (
    <div ref={scrollRef} className={`viewer${night ? ' night' : ''} tool-${annotUi.tool}`} onScroll={onScroll} tabIndex={0}>
      <div ref={pagesRef} className="pages" style={{ height: layout.totalHeight, width: layout.contentWidth }}>
        {pages}
      </div>
    </div>
  );
}
