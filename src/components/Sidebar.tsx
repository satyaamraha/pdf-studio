import { memo, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Annotation } from '../lib/annotations';
import { rotatedSize, type OutlineNode, type PageSize, type PDFDocumentProxy } from '../lib/pdf';
import { scrollIntoContainer } from '../lib/scroll';
import { CommentsPanel } from './CommentsPanel';

const THUMB_WIDTH = 132;

export type SidebarPanel = 'thumbs' | 'outline' | 'comments';

interface Props {
  doc: PDFDocumentProxy;
  sizes: PageSize[];
  rotation: number;
  outline: OutlineNode[];
  page: number;
  panel: SidebarPanel;
  annotations: Annotation[];
  selectedId: string | null;
  author: string;
  onAuthor: (name: string) => void;
  onPanelChange: (panel: SidebarPanel) => void;
  onGoToPage: (index: number) => void;
  onOutline: (node: OutlineNode) => void;
  onFocusAnnotation: (a: Annotation) => void;
  onComment: (a: Annotation, final: boolean) => void;
  onDeleteAnnotation: (id: string) => void;
}

export function Sidebar(props: Props) {
  const { panel, onPanelChange, outline } = props;
  return (
    <aside className="sidebar">
      <div className="segmented" role="tablist" aria-label="Sidebar view">
        <button role="tab" aria-selected={panel === 'thumbs'} onClick={() => onPanelChange('thumbs')}>
          Pages
        </button>
        <button role="tab" aria-selected={panel === 'outline'} onClick={() => onPanelChange('outline')}>
          Outline
        </button>
        <button role="tab" aria-selected={panel === 'comments'} onClick={() => onPanelChange('comments')}>
          Notes{props.annotations.length ? ` ${props.annotations.length}` : ''}
        </button>
      </div>
      {panel === 'thumbs' ? (
        <Thumbnails {...props} />
      ) : panel === 'comments' ? (
        <CommentsPanel
          items={props.annotations}
          selectedId={props.selectedId}
          author={props.author}
          onAuthor={props.onAuthor}
          onFocus={props.onFocusAnnotation}
          onComment={props.onComment}
          onDelete={props.onDeleteAnnotation}
        />
      ) : outline.length ? (
        <div className="outline">
          <OutlineTree nodes={outline} depth={0} onSelect={props.onOutline} />
        </div>
      ) : (
        <p className="sidebar-empty">This document has no outline.</p>
      )}
    </aside>
  );
}

function Thumbnails({ doc, sizes, rotation, page, onGoToPage }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => setRoot(rootRef.current), []);

  // Keep the current page's thumbnail in view as the reader scrolls.
  useEffect(() => {
    const root = rootRef.current;
    const thumb = root?.querySelector(`[data-thumb="${page}"]`);
    if (root && thumb) scrollIntoContainer(thumb, root, 'nearest');
  }, [page]);

  return (
    <div className="thumbs" ref={rootRef}>
      {root &&
        sizes.map((size, i) => (
          <Thumb
            key={i}
            doc={doc}
            index={i}
            size={size}
            rotation={rotation}
            active={i === page}
            root={root}
            onClick={onGoToPage}
          />
        ))}
    </div>
  );
}

interface ThumbProps {
  doc: PDFDocumentProxy;
  index: number;
  size: PageSize;
  rotation: number;
  active: boolean;
  root: HTMLElement;
  onClick: (index: number) => void;
}

const Thumb = memo(function Thumb({ doc, index, size, rotation, active, root, onClick }: ThumbProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const r = rotatedSize(size, rotation);
  const height = Math.round((THUMB_WIDTH * r.height) / r.width);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), {
      root,
      rootMargin: '300px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { promise: Promise<void>; cancel(): void } | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const totalRotation = (page.rotate + rotation) % 360;
        const base = page.getViewport({ scale: 1, rotation: totalRotation });
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * dpr, rotation: totalRotation });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
        if (!cancelled) hostRef.current?.replaceChildren(canvas);
      } catch {
        /* cancelled or failed: leave the blank placeholder */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, index, rotation]);

  return (
    <button
      ref={ref}
      className={`thumb${active ? ' active' : ''}`}
      data-thumb={index}
      onClick={() => onClick(index)}
      aria-label={`Page ${index + 1}`}
      aria-current={active ? 'page' : undefined}
    >
      <div ref={hostRef} className="thumb-canvas" style={{ width: THUMB_WIDTH, height }} />
      <span className="thumb-label">{index + 1}</span>
    </button>
  );
});

function OutlineTree({ nodes, depth, onSelect }: { nodes: OutlineNode[]; depth: number; onSelect: (n: OutlineNode) => void }) {
  return (
    <ul role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node, i) => (
        <OutlineItem key={i} node={node} depth={depth} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function OutlineItem({ node, depth, onSelect }: { node: OutlineNode; depth: number; onSelect: (n: OutlineNode) => void }) {
  const [open, setOpen] = useState(depth === 0 && node.items.length <= 12);
  const hasChildren = node.items.length > 0;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined}>
      <div className="outline-row" style={{ paddingLeft: 6 + depth * 14 }}>
        {hasChildren ? (
          <button className={`twisty${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
            <ChevronRight size={14} />
          </button>
        ) : (
          <span className="twisty-spacer" />
        )}
        <button className="outline-title" onClick={() => onSelect(node)} title={node.title}>
          {node.title}
        </button>
      </div>
      {hasChildren && open && <OutlineTree nodes={node.items} depth={depth + 1} onSelect={onSelect} />}
    </li>
  );
}
