import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { X } from 'lucide-react';
import { normalizeBox } from '../lib/annotations';
import { apply, invert, transformBox, type Box, type Matrix, type Point } from '../lib/geometry';
import { getText, type PDFDocumentProxy } from '../lib/pdf';
import type { Mark, PageImage } from '../lib/pdfEdit';

export type EditTool = 'text' | 'image' | 'add-image' | 'redact-area' | 'redact-text';

export interface EditApi {
  replaceText(page: number, box: Box, text: string): void;
  addMark(mark: Mark): void;
  removeMark(index: number): void;
  requestImages(page: number): void;
  selectImage(sel: { page: number; index: number } | null): void;
  editImage(page: number, index: number, box: Box | null): void;
  placeImage(page: number, box: Box): void;
}

/** Document-wide editing state every page needs. */
export interface EditUi {
  tool: EditTool | null;
  doc: PDFDocumentProxy;
  marks: Mark[];
  images: Map<number, PageImage[]>;
  selectedImage: { page: number; index: number } | null;
  /** Shape of the picture waiting to be placed (Add image). */
  pending: { width: number; height: number } | null;
  busy: boolean;
  api: EditApi;
}

interface Props extends EditUi {
  page: number;
  matrix: Matrix;
}

interface TextRun {
  text: string;
  box: Box;
  size: number;
}

function EditLayerImpl(p: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [runs, setRuns] = useState<TextRun[]>([]);
  const [editing, setEditing] = useState<{ run: TextRun; value: string } | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [moving, setMoving] = useState<{ index: number; box: Box } | null>(null);
  const scale = Math.hypot(p.matrix[0], p.matrix[1]);
  const inv = useMemo(() => invert(p.matrix), [p.matrix]);
  const { tool, page, api } = p;

  // Lines of text on the page (from the text layer data), for "Edit text".
  useEffect(() => {
    if (tool !== 'text') return;
    let cancelled = false;
    void getText(p.doc, page).then((tc) => {
      if (cancelled) return;
      const out: TextRun[] = [];
      for (const item of tc.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [a, b, , , e, f] = item.transform as number[];
        if (Math.abs(b) > 0.01 * Math.abs(a)) continue; // rotated text isn't editable yet
        const h = item.height || Math.hypot(a, b);
        out.push({ text: item.str, size: h, box: { x1: e, y1: f - h * 0.25, x2: e + item.width, y2: f + h * 0.85 } });
      }
      setRuns(out);
    });
    return () => {
      cancelled = true;
    };
  }, [tool, p.doc, page]);

  // Ask for the page's pictures whenever they're not known (first time, or after an edit).
  const known = p.images.has(page);
  useEffect(() => {
    if (tool === 'image' && !known) api.requestImages(page);
  }, [tool, page, api, known]);

  useEffect(() => setEditing(null), [tool, p.doc]);

  const toPdf = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    return apply(inv, e.clientX - r.left, e.clientY - r.top);
  };
  const screen = (b: Box): CSSProperties => {
    const s = transformBox(p.matrix, b);
    return { left: s.x1, top: s.y1, width: s.x2 - s.x1, height: s.y2 - s.y1 };
  };

  // Dragging out a box: redaction areas and placing a new picture.
  const drawing = !p.busy && (tool === 'redact-area' || (tool === 'add-image' && !!p.pending));
  const onPointerDown = (e: RPointerEvent) => {
    if (!drawing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = toPdf(e);
    let box: Box | null = null;
    const move = (ev: PointerEvent) => {
      const q = toPdf(ev);
      if (Math.hypot(q[0] - start[0], q[1] - start[1]) * scale < 4) return;
      box = normalizeBox(start[0], start[1], q[0], q[1]);
      if (tool === 'add-image' && p.pending) {
        const ratio = p.pending.height / p.pending.width;
        const w = box.x2 - box.x1;
        box = { x1: box.x1, y1: box.y2 - w * ratio, x2: box.x2, y2: box.y2 };
      }
      setDraft(box);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraft(null);
      if (tool === 'redact-area') {
        if (box) api.addMark({ page, box });
      } else if (p.pending) {
        let b = box;
        if (!b) {
          // A click places the picture at a comfortable size, centred.
          const w = Math.min(200, p.pending.width);
          const h = (w * p.pending.height) / p.pending.width;
          b = { x1: start[0] - w / 2, y1: start[1] - h / 2, x2: start[0] + w / 2, y2: start[1] + h / 2 };
        }
        api.placeImage(page, b);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Moving and resizing an image.
  const startImageDrag = (e: RPointerEvent, img: PageImage, corner: Point | null) => {
    if (e.button !== 0 || p.busy) return;
    e.preventDefault();
    e.stopPropagation();
    api.selectImage({ page, index: img.index });
    const start = toPdf(e);
    let next: Box | null = null;
    const ratio = (img.box.y2 - img.box.y1) / (img.box.x2 - img.box.x1);
    const move = (ev: PointerEvent) => {
      const [x, y] = toPdf(ev);
      if (corner) {
        // Pictures keep their shape.
        const w = Math.max(10, Math.abs(x - corner[0]));
        const h = w * ratio;
        const x1 = x < corner[0] ? corner[0] - w : corner[0];
        const y1 = y < corner[1] ? corner[1] - h : corner[1];
        next = { x1, y1, x2: x1 + w, y2: y1 + h };
      } else {
        const dx = x - start[0];
        const dy = y - start[1];
        if (!next && Math.hypot(dx, dy) * scale < 3) return;
        next = { x1: img.box.x1 + dx, y1: img.box.y1 + dy, x2: img.box.x2 + dx, y2: img.box.y2 + dy };
      }
      setMoving({ index: img.index, box: next });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (next) api.editImage(page, img.index, next);
      else setMoving(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Keep the moved preview until the edited page arrives.
  useEffect(() => setMoving(null), [p.images]);

  const finishEdit = (commit: boolean) => {
    const ed = editing;
    setEditing(null);
    if (commit && ed && ed.value !== ed.run.text) {
      const pad = ed.run.size * 0.1;
      const b = ed.run.box;
      api.replaceText(page, { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad }, ed.value);
    }
  };

  const marks = p.marks.map((m, i) => ({ m, i })).filter(({ m }) => m.page === page);
  const images = p.images.get(page) ?? [];

  if (!tool && !marks.length) return null;

  return (
    <div
      ref={rootRef}
      className={`edit-layer tool-${tool ?? 'none'}${drawing ? ' drawing' : ''}${p.busy ? ' busy' : ''}`}
      onPointerDown={onPointerDown}
    >
      {tool === 'text' &&
        !p.busy &&
        runs.map((r, i) => (
          <div
            key={i}
            className="edit-run"
            style={screen(r.box)}
            title="Click to edit this text"
            onClick={() => setEditing({ run: r, value: r.text })}
          />
        ))}

      {editing && (
        <input
          className="edit-input"
          autoFocus
          value={editing.value}
          style={{ ...screen(editing.run.box), fontSize: editing.run.size * scale * 0.95, minWidth: (transformBox(p.matrix, editing.run.box).x2 - transformBox(p.matrix, editing.run.box).x1) }}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={() => finishEdit(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finishEdit(true);
            if (e.key === 'Escape') finishEdit(false);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}

      {tool === 'image' &&
        images.map((img) => {
          const box = moving?.index === img.index ? moving.box : img.box;
          const selected = p.selectedImage?.page === page && p.selectedImage.index === img.index;
          const s = transformBox(p.matrix, box);
          const corners: [string, number, number, number, number][] = [
            ['nw', s.x1, s.y1, s.x2, s.y2],
            ['ne', s.x2, s.y1, s.x1, s.y2],
            ['sw', s.x1, s.y2, s.x2, s.y1],
            ['se', s.x2, s.y2, s.x1, s.y1],
          ];
          return (
            <div key={img.index}>
              <div
                className={`image-frame${selected ? ' selected' : ''}`}
                style={screen(box)}
                onPointerDown={(e) => startImageDrag(e, img, null)}
                title="Drag to move. Delete key removes it."
              />
              {selected &&
                corners.map(([key, x, y, ox, oy]) => (
                  <div
                    key={key}
                    className={`annot-handle h-${key}`}
                    style={{ left: x - 5, top: y - 5 }}
                    onPointerDown={(e) => startImageDrag(e, { ...img, box }, apply(inv, ox, oy))}
                  />
                ))}
            </div>
          );
        })}

      {marks.map(({ m, i }) => (
        <div key={i} className="redact-mark" style={screen(m.box)}>
          {tool && (tool === 'redact-area' || tool === 'redact-text') && (
            <button
              className="redact-remove"
              title="Remove this mark"
              aria-label="Remove this mark"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => api.removeMark(i)}
            >
              <X size={11} />
            </button>
          )}
        </div>
      ))}

      {draft && <div className={tool === 'redact-area' ? 'redact-mark draft' : 'image-frame draft'} style={screen(draft)} />}
    </div>
  );
}

export const EditLayer = memo(EditLayerImpl);
