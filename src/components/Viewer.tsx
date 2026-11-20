import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CSS_UNITS, rotatedSize, type PageSize, type PDFDocumentProxy } from '../lib/pdf';
import type { SearchHit } from '../lib/search';
import { clampScale, type LinkTarget, type Zoom } from '../lib/view';
import { PageView } from './PageView';

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
  const { doc, sizes, zoom, rotation, initialPage, night, hitsByPage, activeHit, apiRef } = props;
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

  const layoutRef = useRef(layout);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const currentRef = useRef(-1);
  // Where the reader is, as page + fraction, so zooming keeps the same spot in view.
  const anchor = useRef({ page: initialPage, fraction: 0, centerX: 0.5 });
  const ready = useRef(false);

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
    if (!ready.current) {
      ready.current = true;
      el.scrollTop = p === 0 ? 0 : layout.tops[p] - GAP / 2;
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

  // Pinch-to-zoom on trackpads and Ctrl/Cmd + mouse wheel.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = Math.max(-25, Math.min(25, e.deltaY));
      cb.current.onZoomBy(Math.exp(-delta * 0.01));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
      />,
    );
  }

  return (
    <div ref={scrollRef} className={`viewer${night ? ' night' : ''}`} onScroll={onScroll} tabIndex={0}>
      <div className="pages" style={{ height: layout.totalHeight, width: layout.contentWidth }}>
        {pages}
      </div>
    </div>
  );
}
