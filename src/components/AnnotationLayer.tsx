import { memo, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import {
  annotBox,
  arrowHead,
  isBoxKind,
  isMarkup,
  newId,
  normalizeBox,
  NOTE_SIZE,
  simplifyPoints,
  smoothPath,
  stampSize,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING,
  textLines,
  translate,
  type Annotation,
  type AnnotKind,
  type TextAnnot,
  type Tool,
} from '../lib/annotations';
import { apply, invert, transformBox, type Box, type Matrix, type Point } from '../lib/geometry';
import { todayText } from '../lib/signatures';
import { textWidth, wrapText } from '../lib/textMetrics';

export interface ToolStyle {
  color: string;
  opacity: number;
  width: number;
  fontSize: number;
  stamp: string;
  /** The signature or initials waiting to be placed (Signature tool). */
  image?: { src: string; width: number; height: number; role: 'signature' | 'initials' };
}

/** Callbacks from a page's annotation layer to the document. Kept stable across renders. */
export interface AnnotApi {
  create(a: Annotation): void;
  /** `final` false = live preview while dragging or typing; true = one undo step. */
  update(a: Annotation, final: boolean): void;
  remove(id: string): void;
  select(id: string | null): void;
  editText(id: string | null): void;
  openComment(id: string | null): void;
  /** A box was drawn with the digital-signature tool. */
  placeBox(page: number, box: Box): void;
}

/** Document-wide annotation state every page needs. */
export interface AnnotUi {
  tool: Tool;
  style: ToolStyle;
  author: string;
  selectedId: string | null;
  editingId: string | null;
  commentId: string | null;
  api: AnnotApi;
}

interface Props {
  page: number;
  items: Annotation[];
  matrix: Matrix;
  tool: Tool;
  style: ToolStyle;
  author: string;
  selectedId: string | null;
  editingId: string | null;
  commentId: string | null;
  api: AnnotApi;
}

const DRAW_TOOLS: Tool[] = ['ink', 'rect', 'ellipse', 'line', 'arrow', 'note', 'text', 'stamp', 'image', 'date', 'sigbox'];

/** Width a placed signature starts at, in points (drag to choose another). */
const SIGNATURE_WIDTH = { signature: 150, initials: 60 };

function makeAnnot(kind: AnnotKind, page: number, style: ToolStyle, author: string): Omit<Annotation, 'kind'> & { kind: AnnotKind } {
  const now = new Date().toISOString();
  return {
    id: newId(),
    kind,
    page,
    color: style.color,
    opacity: style.opacity,
    comment: '',
    author,
    created: now,
    modified: now,
  };
}

function AnnotationLayerImpl({ page, items, matrix, tool, style, author, selectedId, editingId, commentId, api }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const scale = Math.hypot(matrix[0], matrix[1]);
  const inv = invert(matrix);

  const toPdf = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    return apply(inv, e.clientX - r.left, e.clientY - r.top);
  };

  // ----- creating annotations by dragging on the page -----
  const drawing = DRAW_TOOLS.includes(tool);
  const onPointerDown = (e: RPointerEvent) => {
    if (!drawing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const start = toPdf(e);
    const base = makeAnnot((tool === 'date' ? 'text' : tool === 'sigbox' ? 'rect' : tool) as AnnotKind, page, style, author);
    const points: Point[] = [start];
    const minDrag = 4 / scale;

    const shapeFor = (end: Point, done: boolean): Annotation | null => {
      const dragged = Math.hypot(end[0] - start[0], end[1] - start[1]) > minDrag;
      switch (tool) {
        case 'ink':
          return points.length > 1 ? { ...base, kind: 'ink', paths: [done ? simplifyPoints(points, 1 / scale) : points], width: style.width } : null;
        case 'rect':
        case 'ellipse': {
          const box = dragged
            ? normalizeBox(start[0], start[1], end[0], end[1])
            : done
              ? { x1: start[0], y1: start[1] - 80, x2: start[0] + 120, y2: start[1] }
              : null;
          return box ? { ...base, kind: tool, box, width: style.width } : null;
        }
        case 'line':
        case 'arrow': {
          if (!dragged && !done) return null;
          const to: Point = dragged ? end : [start[0] + 100, start[1]];
          return { ...base, kind: tool, from: start, to, width: style.width };
        }
        case 'text': {
          const box = dragged
            ? normalizeBox(start[0], start[1], end[0], end[1])
            : done
              ? { x1: start[0], y1: start[1] - style.fontSize * TEXT_LINE_HEIGHT - TEXT_PADDING * 2, x2: start[0] + 200, y2: start[1] }
              : null;
          return box ? { ...base, kind: 'text', box, text: '', fontSize: style.fontSize, opacity: 1 } : null;
        }
        case 'note':
          return done ? { ...base, kind: 'note', x: start[0] - NOTE_SIZE / 2, y: start[1] + NOTE_SIZE / 2, opacity: 1 } : null;
        case 'image': {
          const img = style.image;
          if (!img) return null;
          const ratio = img.height / img.width;
          // Dragging sets the width; a click uses the usual size, centred where you clicked.
          if (dragged) {
            const w = Math.abs(end[0] - start[0]);
            const x1 = Math.min(start[0], end[0]);
            const y2 = Math.max(start[1], end[1]);
            return { ...base, kind: 'image', src: img.src, role: img.role, opacity: 1, box: { x1, y1: y2 - w * ratio, x2: x1 + w, y2 } };
          }
          if (!done) return null;
          const w = SIGNATURE_WIDTH[img.role];
          const h = w * ratio;
          return { ...base, kind: 'image', src: img.src, role: img.role, opacity: 1, box: { x1: start[0] - w / 2, y1: start[1] - h / 2, x2: start[0] + w / 2, y2: start[1] + h / 2 } };
        }
        case 'sigbox': {
          const box = dragged
            ? normalizeBox(start[0], start[1], end[0], end[1])
            : done
              ? { x1: start[0] - 100, y1: start[1] - 30, x2: start[0] + 100, y2: start[1] + 30 }
              : null;
          return box ? { ...base, kind: 'rect', box, width: 1, color: '#3355e0', opacity: 1 } : null;
        }
        case 'date': {
          if (!done) return null;
          const text = todayText();
          const fs = 12;
          const w = textWidth(text, fs) + TEXT_PADDING * 2 + 2;
          const h = fs * TEXT_LINE_HEIGHT + TEXT_PADDING * 2;
          return { ...base, kind: 'text', text, fontSize: fs, opacity: 1, color: '#111111', box: { x1: start[0], y1: start[1] - h / 2, x2: start[0] + w, y2: start[1] + h / 2 } };
        }
        case 'stamp': {
          if (!done) return null;
          const { width, height } = stampSize(style.stamp);
          return {
            ...base,
            kind: 'stamp',
            label: style.stamp,
            box: { x1: start[0] - width / 2, y1: start[1] - height / 2, x2: start[0] + width / 2, y2: start[1] + height / 2 },
          };
        }
      }
      return null;
    };

    const move = (ev: PointerEvent) => {
      const p = toPdf(ev);
      points.push(p);
      setDraft(shapeFor(p, false));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraft(null);
      const a = shapeFor(toPdf(ev), true);
      if (a && tool === 'sigbox' && 'box' in a) api.placeBox(page, a.box);
      else if (a) api.create(a);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ----- moving an existing annotation -----
  const startMove = (e: RPointerEvent, a: Annotation) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    api.select(a.id);
    const start = toPdf(e);
    let moved: Annotation | null = null;
    const move = (ev: PointerEvent) => {
      const [x, y] = toPdf(ev);
      if (!moved && Math.hypot(x - start[0], y - start[1]) < 2 / scale) return;
      moved = { ...translate(a, x - start[0], y - start[1]), modified: new Date().toISOString() };
      api.update(moved, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) api.update(moved, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ----- resizing (box shapes) and moving line ends -----
  const startHandle = (e: RPointerEvent, a: Annotation, handle: string, anchor: Point) => {
    e.preventDefault();
    e.stopPropagation();
    let changed: Annotation | null = null;
    const move = (ev: PointerEvent) => {
      const p = toPdf(ev);
      const modified = new Date().toISOString();
      if ((a.kind === 'line' || a.kind === 'arrow') && (handle === 'from' || handle === 'to')) {
        changed = { ...a, [handle]: p, modified };
      } else if (a.kind === 'image') {
        // Signatures keep their shape.
        const ratio = (a.box.y2 - a.box.y1) / (a.box.x2 - a.box.x1);
        const w = Math.max(12, Math.abs(p[0] - anchor[0]));
        const h = w * ratio;
        const x1 = p[0] < anchor[0] ? anchor[0] - w : anchor[0];
        const y1 = p[1] < anchor[1] ? anchor[1] - h : anchor[1];
        changed = { ...a, box: { x1, y1, x2: x1 + w, y2: y1 + h }, modified };
      } else if (isBoxKind(a.kind) && 'box' in a) {
        const box = normalizeBox(anchor[0], anchor[1], p[0], p[1]);
        if (box.x2 - box.x1 < 8 || box.y2 - box.y1 < 8) return;
        changed = { ...a, box, modified } as Annotation;
      }
      if (changed) api.update(changed, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (changed) api.update(changed, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const selected = items.find((a) => a.id === selectedId) ?? null;
  const editing = items.find((a): a is TextAnnot => a.id === editingId && a.kind === 'text') ?? null;
  const commenting = items.find((a) => a.id === commentId) ?? null;

  const mode = tool === 'select' ? 'select' : isMarkup(tool) ? 'markup' : 'draw';

  return (
    <div
      ref={rootRef}
      className={`annot-layer mode-${mode}`}
      data-tool={tool}
      onPointerDown={onPointerDown}
    >
      <svg className="annot-svg" width="100%" height="100%">
        <g transform={`matrix(${matrix.join(' ')})`}>
          {items.map((a) =>
            a.id === editingId ? null : (
              <AnnotShape
                key={a.id}
                a={a}
                scale={scale}
                onPointerDown={(e) => startMove(e, a)}
                onDoubleClick={() => {
                  if (a.kind === 'text') api.editText(a.id);
                  else api.openComment(a.id);
                }}
              />
            ),
          )}
          {draft && <AnnotShape a={draft} scale={scale} draft />}
        </g>
      </svg>

      {selected && tool === 'select' && (
        <SelectionFrame a={selected} matrix={matrix} inv={inv} onHandle={startHandle} onMove={startMove} />
      )}

      {editing && <TextEditor a={editing} matrix={matrix} scale={scale} api={api} />}

      {commenting && <CommentPopover a={commenting} matrix={matrix} api={api} />}
    </div>
  );
}

export const AnnotationLayer = memo(AnnotationLayerImpl);

// ----- drawing one annotation (in PDF coordinates) -----

function AnnotShape({
  a,
  scale,
  draft,
  onPointerDown,
  onDoubleClick,
}: {
  a: Annotation;
  scale: number;
  draft?: boolean;
  onPointerDown?: (e: RPointerEvent) => void;
  onDoubleClick?: () => void;
}) {
  const hit = draft ? undefined : 'annot-hit';
  const hitWidth = Math.max(8 / scale, 'width' in a ? a.width : 0);
  const common = { onPointerDown, onDoubleClick, 'data-annot': a.id } as const;

  switch (a.kind) {
    case 'highlight':
      return (
        <g {...common} className={hit} style={{ mixBlendMode: 'multiply' }}>
          {a.quads.map((q, i) => (
            <polygon key={i} points={`${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`} fill={a.color} fillOpacity={a.opacity} />
          ))}
        </g>
      );
    case 'underline':
    case 'strike': {
      const t = a.kind === 'underline' ? 0.08 : 0.42;
      return (
        <g {...common} className={hit}>
          {a.quads.map((q, i) => {
            const h = Math.abs(q[1] - q[5]);
            return (
              <g key={i}>
                <polygon points={`${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`} fill="transparent" />
                <line
                  x1={q[4]}
                  y1={q[5] + (q[1] - q[5]) * t}
                  x2={q[6]}
                  y2={q[7] + (q[3] - q[7]) * t}
                  stroke={a.color}
                  strokeOpacity={a.opacity}
                  strokeWidth={Math.max(0.75, h * 0.07)}
                />
              </g>
            );
          })}
        </g>
      );
    }
    case 'note': {
      const { x, y } = a;
      const s = NOTE_SIZE;
      return (
        <g {...common} className={hit}>
          <path
            d={`M${x + 4} ${y - 1} H${x + s - 4} Q${x + s - 1} ${y - 1} ${x + s - 1} ${y - 4} V${y - s * 0.78 + 3} Q${x + s - 1} ${y - s * 0.78} ${x + s - 4} ${y - s * 0.78} H${x + s * 0.5} L${x + s * 0.22} ${y - s + 1} L${x + s * 0.25} ${y - s * 0.78} H${x + 4} Q${x + 1} ${y - s * 0.78} ${x + 1} ${y - s * 0.78 + 3} V${y - 4} Q${x + 1} ${y - 1} ${x + 4} ${y - 1} Z`}
            fill={a.color}
            stroke="#404040"
            strokeWidth={0.8}
          />
          <line x1={x + 5} y1={y - 6} x2={x + s - 5} y2={y - 6} stroke="#fff" strokeWidth={1.2} />
          <line x1={x + 5} y1={y - 10} x2={x + s - 5} y2={y - 10} stroke="#fff" strokeWidth={1.2} />
        </g>
      );
    }
    case 'ink': {
      const d = a.paths
        .map((p) => {
          const { start, curves } = smoothPath(p);
          return `M${start[0]} ${start[1]} ` + curves.map(([c1, c2, e]) => `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${e[0]} ${e[1]}`).join(' ');
        })
        .join(' ');
      return (
        <g {...common} className={hit}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={hitWidth} strokeLinecap="round" />
          <path d={d} fill="none" stroke={a.color} strokeOpacity={a.opacity} strokeWidth={a.width} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    }
    case 'rect':
    case 'ellipse': {
      const { x1, y1, x2, y2 } = a.box;
      const w = a.width;
      const props = { fill: 'none', stroke: a.color, strokeOpacity: a.opacity, strokeWidth: w };
      const hitProps = { fill: 'none', stroke: 'transparent', strokeWidth: hitWidth };
      const shape = (p: object) =>
        a.kind === 'rect' ? (
          <rect x={x1 + w / 2} y={y1 + w / 2} width={Math.max(0, x2 - x1 - w)} height={Math.max(0, y2 - y1 - w)} {...p} />
        ) : (
          <ellipse cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} rx={Math.max(0, (x2 - x1 - w) / 2)} ry={Math.max(0, (y2 - y1 - w) / 2)} {...p} />
        );
      return (
        <g {...common} className={hit}>
          {shape(hitProps)}
          {shape(props)}
        </g>
      );
    }
    case 'line':
    case 'arrow': {
      const head = a.kind === 'arrow' ? arrowHead(a.from, a.to, a.width) : null;
      return (
        <g {...common} className={hit} strokeLinecap="round" strokeLinejoin="round">
          <line x1={a.from[0]} y1={a.from[1]} x2={a.to[0]} y2={a.to[1]} stroke="transparent" strokeWidth={hitWidth} />
          <line x1={a.from[0]} y1={a.from[1]} x2={a.to[0]} y2={a.to[1]} stroke={a.color} strokeOpacity={a.opacity} strokeWidth={a.width} />
          {head && (
            <polyline
              points={`${head[0][0]},${head[0][1]} ${a.to[0]},${a.to[1]} ${head[1][0]},${head[1][1]}`}
              fill="none"
              stroke={a.color}
              strokeOpacity={a.opacity}
              strokeWidth={a.width}
            />
          )}
        </g>
      );
    }
    case 'text': {
      const { x1, y1, x2, y2 } = a.box;
      const fs = a.fontSize;
      const lines = textLines(a);
      return (
        <g {...common} className={hit}>
          <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="transparent" stroke={draft ? '#3355e0' : 'none'} strokeDasharray="4 3" strokeWidth={1 / scale} />
          {lines.map((l, i) => (
            <text
              key={i}
              transform={`matrix(1 0 0 -1 ${x1 + TEXT_PADDING} ${y2 - TEXT_PADDING - fs * 0.78 - i * fs * TEXT_LINE_HEIGHT})`}
              fontSize={fs}
              fontFamily="Helvetica, Arial, sans-serif"
              fill={a.color}
              fillOpacity={a.opacity}
              style={{ whiteSpace: 'pre' }}
            >
              {l}
            </text>
          ))}
        </g>
      );
    }
    case 'image': {
      const { x1, y1, x2, y2 } = a.box;
      return (
        <g {...common} className={hit} opacity={a.opacity}>
          <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="transparent" />
          <image href={a.src} transform={`matrix(1 0 0 -1 ${x1} ${y2})`} width={x2 - x1} height={y2 - y1} preserveAspectRatio="none" />
        </g>
      );
    }
    case 'stamp': {
      const { x1, y1, x2, y2 } = a.box;
      const w = x2 - x1;
      const h = y2 - y1;
      const fs = Math.max(4, Math.min(h * 0.46, (w - 16) / Math.max(1, textWidth(a.label, 1, true))));
      const tw = textWidth(a.label, fs, true);
      return (
        <g {...common} className={hit} opacity={a.opacity}>
          <rect x={x1 + 1.5} y={y1 + 1.5} width={w - 3} height={h - 3} rx={Math.min(6, h / 4)} fill={a.color} fillOpacity={0.06} stroke={a.color} strokeWidth={2.5} />
          <text
            transform={`matrix(1 0 0 -1 ${x1 + (w - tw) / 2} ${y1 + h / 2 - fs * 0.36})`}
            fontSize={fs}
            fontWeight={700}
            fontFamily="Helvetica, Arial, sans-serif"
            fill={a.color}
          >
            {a.label}
          </text>
        </g>
      );
    }
  }
}

// ----- selection frame with handles (screen coordinates) -----

function SelectionFrame({
  a,
  matrix,
  inv,
  onHandle,
  onMove,
}: {
  a: Annotation;
  matrix: Matrix;
  inv: Matrix;
  onHandle: (e: RPointerEvent, a: Annotation, handle: string, anchor: Point) => void;
  onMove: (e: RPointerEvent, a: Annotation) => void;
}) {
  const b = transformBox(matrix, annotBox(a));
  const frame: CSSProperties = { left: b.x1 - 3, top: b.y1 - 3, width: b.x2 - b.x1 + 6, height: b.y2 - b.y1 + 6 };

  const handles: { key: string; x: number; y: number; anchor: Point }[] = [];
  if (a.kind === 'line' || a.kind === 'arrow') {
    for (const key of ['from', 'to'] as const) {
      const [x, y] = apply(matrix, a[key][0], a[key][1]);
      handles.push({ key, x, y, anchor: [0, 0] });
    }
  } else if (isBoxKind(a.kind)) {
    const corners: [string, number, number, number, number][] = [
      ['nw', b.x1, b.y1, b.x2, b.y2],
      ['ne', b.x2, b.y1, b.x1, b.y2],
      ['sw', b.x1, b.y2, b.x2, b.y1],
      ['se', b.x2, b.y2, b.x1, b.y1],
    ];
    for (const [key, x, y, ox, oy] of corners) handles.push({ key, x, y, anchor: apply(inv, ox, oy) });
  }

  return (
    <>
      <div
        className={`annot-frame${a.kind === 'line' || a.kind === 'arrow' ? ' thin' : ''}`}
        style={frame}
        onPointerDown={(e) => onMove(e, a)}
      />
      {handles.map((h) => (
        <div
          key={h.key}
          className={`annot-handle h-${h.key}`}
          style={{ left: h.x - 5, top: h.y - 5 }}
          onPointerDown={(e) => onHandle(e, a, h.key, h.anchor)}
        />
      ))}
    </>
  );
}

// ----- editing a text box -----

function TextEditor({ a, matrix, scale, api }: { a: TextAnnot; matrix: Matrix; scale: number; api: AnnotApi }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const current = useRef(a);
  current.current = a;
  const b = transformBox(matrix, a.box);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = () => {
    const latest = current.current;
    if (!latest.text.trim()) api.remove(latest.id);
    else api.update(latest, true);
    api.editText(null);
  };

  return (
    <textarea
      ref={ref}
      className="annot-textarea"
      value={a.text}
      placeholder="Type here"
      spellCheck
      style={{
        left: b.x1,
        top: b.y1,
        width: b.x2 - b.x1,
        height: b.y2 - b.y1,
        fontSize: a.fontSize * scale,
        lineHeight: TEXT_LINE_HEIGHT,
        padding: TEXT_PADDING * scale,
        color: a.color,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const text = e.target.value;
        // Grow the box downwards so the text always fits.
        const lines = wrapText(text, a.fontSize, a.box.x2 - a.box.x1 - TEXT_PADDING * 2).length;
        const needed = lines * a.fontSize * TEXT_LINE_HEIGHT + TEXT_PADDING * 2;
        const box = a.box.y2 - a.box.y1 < needed ? { ...a.box, y1: a.box.y2 - needed } : a.box;
        api.update({ ...a, text, box, modified: new Date().toISOString() }, false);
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          ref.current?.blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

// ----- comment popover next to an annotation -----

function CommentPopover({ a, matrix, api }: { a: Annotation; matrix: Matrix; api: AnnotApi }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const current = useRef(a);
  current.current = a;
  const b = transformBox(matrix, annotBox(a));
  useEffect(() => ref.current?.focus(), []);

  const close = () => {
    api.update(current.current, true);
    api.openComment(null);
  };

  return (
    <div className="comment-pop" style={{ left: b.x1, top: b.y2 + 8 }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={a.comment}
        placeholder="Add a comment…"
        rows={3}
        onChange={(e) => api.update({ ...a, comment: e.target.value, modified: new Date().toISOString() }, false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            close();
          }
          e.stopPropagation();
        }}
      />
      <div className="comment-pop-actions">
        {a.author && <span className="comment-author">{a.author}</span>}
        <button className="primary small" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}
