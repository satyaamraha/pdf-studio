import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { CSS_UNITS, getText, pdfjs, type PDFDocumentProxy } from '../lib/pdf';
import { scrollIntoContainer } from '../lib/scroll';
import type { SearchHit } from '../lib/search';
import type { Annotation } from '../lib/annotations';
import type { Matrix } from '../lib/geometry';
import type { LinkTarget } from '../lib/view';
import { widgetFromAnnotation, type Widget } from '../lib/forms';
import { AnnotationLayer, type AnnotUi } from './AnnotationLayer';
import { FormLayer, type FormUi } from './FormLayer';

/** Positions are percentages of the page box so they survive zoom without recomputing. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface LinkBox extends Box, LinkTarget {}
interface HighlightBox extends Box {
  hit: number;
}

// Browsers refuse canvases much larger than this (Safari's limit is the strictest).
const MAX_CANVAS_PIXELS = 16_777_216;

interface Props {
  doc: PDFDocumentProxy;
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  hits: SearchHit[] | undefined;
  activeHit: number;
  onLink: (link: LinkTarget) => void;
  matrix: Matrix;
  annots: Annotation[];
  ui: AnnotUi;
  /** Form fields placed in PDF Studio on this page. */
  placed: Widget[];
  formUi: FormUi;
}

function PageViewImpl({ doc, index, top, left, width, height, scale, rotation, hits, activeHit, onLink, matrix, annots, ui, placed, formUi }: Props) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const textDivsRef = useRef<HTMLElement[]>([]);
  const [textVersion, setTextVersion] = useState(0);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [highlights, setHighlights] = useState<HighlightBox[]>([]);
  const [rendered, setRendered] = useState(false);

  // Draw the page, then its selectable text layer and clickable links.
  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel(): void } | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    // On zoom the old drawing stays (stretched) briefly so rapid zooming doesn't redraw every step.
    const redraw = !!canvasHostRef.current?.firstChild;

    const timer = window.setTimeout(async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: scale * CSS_UNITS, rotation: (page.rotate + rotation) % 360 });

        let outputScale = window.devicePixelRatio || 1;
        const area = viewport.width * viewport.height;
        if (area * outputScale * outputScale > MAX_CANVAS_PIXELS) outputScale = Math.sqrt(MAX_CANVAS_PIXELS / area);
        const canvas = document.createElement('canvas');
        canvas.className = 'page-canvas';
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;
        renderTask = page.render({
          canvasContext: ctx,
          viewport,
          // Fillable fields are drawn as live inputs on top, not baked into the page image.
          annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (cancelled) return;
        canvasHostRef.current?.replaceChildren(canvas);
        setRendered(true);

        const text = await getText(doc, index);
        const container = textRef.current;
        if (cancelled || !container) return;
        container.replaceChildren();
        textLayer = new pdfjs.TextLayer({ textContentSource: text, container, viewport });
        await textLayer.render();
        if (cancelled) return;
        const end = document.createElement('div');
        end.className = 'endOfContent';
        container.append(end);
        textDivsRef.current = textLayer.textDivs;
        setTextVersion((v) => v + 1);

        const annotations = await page.getAnnotations({ intent: 'display' });
        if (cancelled) return;
        const boxes: LinkBox[] = [];
        const found: Widget[] = [];
        for (const a of annotations) {
          const w = widgetFromAnnotation(a);
          if (w) found.push(w);
          if (a.subtype !== 'Link' || (!a.url && !a.dest)) continue;
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
          boxes.push({
            left: (Math.min(x1, x2) / viewport.width) * 100,
            top: (Math.min(y1, y2) / viewport.height) * 100,
            width: (Math.abs(x2 - x1) / viewport.width) * 100,
            height: (Math.abs(y2 - y1) / viewport.height) * 100,
            url: a.url ?? null,
            dest: a.dest ?? null,
          });
        }
        setLinks(boxes);
        setWidgets(found);
      } catch (err) {
        if (!cancelled && !(err instanceof pdfjs.RenderingCancelledException)) console.error(err);
      }
    }, redraw ? 150 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, index, scale, rotation]);

  // Search highlights: measure the matched characters inside the text layer.
  useLayoutEffect(() => {
    const divs = textDivsRef.current;
    const pageEl = pageRef.current;
    if (!hits?.length || !divs.length || !pageEl) {
      setHighlights([]);
      return;
    }
    const pageBox = pageEl.getBoundingClientRect();
    const range = document.createRange();
    const boxes: HighlightBox[] = [];
    for (const hit of hits) {
      for (const r of hit.ranges) {
        const node = divs[r.item]?.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const len = node.textContent?.length ?? 0;
        range.setStart(node, Math.min(r.from, len));
        range.setEnd(node, Math.min(r.to, len));
        for (const rect of range.getClientRects()) {
          boxes.push({
            hit: hit.id,
            left: ((rect.left - pageBox.left) / pageBox.width) * 100,
            top: ((rect.top - pageBox.top) / pageBox.height) * 100,
            width: (rect.width / pageBox.width) * 100,
            height: (rect.height / pageBox.height) * 100,
          });
        }
      }
    }
    setHighlights(boxes);
  }, [hits, textVersion]);

  // Bring the current search result into view once its highlight exists.
  const scrolledTo = useRef(-1);
  useEffect(() => {
    if (!highlights.some((h) => h.hit === activeHit)) {
      scrolledTo.current = -1;
      return;
    }
    if (scrolledTo.current === activeHit) return;
    const el = pageRef.current?.querySelector('.highlight.active');
    const viewer = pageRef.current?.closest<HTMLElement>('.viewer');
    if (el && viewer) scrollIntoContainer(el, viewer, 'center');
    scrolledTo.current = activeHit;
  }, [highlights, activeHit]);

  const pct = (b: Box): CSSProperties => ({
    left: `${b.left}%`,
    top: `${b.top}%`,
    width: `${b.width}%`,
    height: `${b.height}%`,
  });

  return (
    <div
      ref={pageRef}
      className={`page${rendered ? '' : ' loading'}`}
      data-page={index + 1}
      style={{ top, left, width, height, '--scale-factor': scale * CSS_UNITS } as CSSProperties}
      aria-label={`Page ${index + 1}`}
    >
      <div ref={canvasHostRef} className="canvas-host" />
      <div className="highlight-layer" aria-hidden>
        {highlights.map((h, i) => (
          <div key={i} className={`highlight${h.hit === activeHit ? ' active' : ''}`} style={pct(h)} />
        ))}
      </div>
      <div ref={textRef} className="textLayer" />
      <AnnotationLayer page={index} items={annots} matrix={matrix} {...ui} />
      {(widgets.length > 0 || placed.length > 0 || formUi.designing) && (
        <FormLayer page={index} widgets={widgets} placed={placed} matrix={matrix} {...formUi} />
      )}
      <div className="link-layer">
        {links.map((l, i) => (
          <a
            key={i}
            href={l.url ?? '#'}
            title={l.url ?? undefined}
            style={pct(l)}
            onClick={(e) => {
              e.preventDefault();
              onLink(l);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export const PageView = memo(PageViewImpl);
