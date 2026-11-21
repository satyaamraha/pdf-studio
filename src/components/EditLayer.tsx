import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { X } from 'lucide-react';
import { normalizeBox } from '../lib/annotations';
import { apply, invert, transformBox, type Box, type Matrix, type Point } from '../lib/geometry';
import { getText, type PDFDocumentProxy } from '../lib/pdf';
import type { Mark, PageImage, ScanMove, ScanRewrite } from '../lib/pdfEdit';
import { inspectScannedText, scanFont, type ScanLook } from '../lib/scanText';

export type EditTool = 'text' | 'image' | 'add-image' | 'redact-area' | 'redact-text';

export interface EditApi {
  replaceText(page: number, box: Box, text: string, scan?: ScanRewrite): void;
  moveText(page: number, box: Box, dx: number, dy: number, scan?: ScanMove): void;
  /** Whether the text there is hidden, like the recognised text over a scan. */
  isHiddenText(page: number, box: Box): Promise<boolean>;
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
  const [editing, setEditingState] = useState<Editing | null>(null);
  // The latest edit, read when it finishes (Enter and the blur after it must not apply it twice).
  const editRef = useRef<Editing | null>(null);
  const setEditing = (next: Editing | null | ((e: Editing | null) => Editing | null)) => {
    editRef.current = typeof next === 'function' ? next(editRef.current) : next;
    setEditingState(editRef.current);
  };
  const [draft, setDraft] = useState<Box | null>(null);
  const [moving, setMoving] = useState<{ index: number; box: Box } | null>(null);
  // A line of text being dragged, and how far (page units).
  const [dragging, setDragging] = useState<{ run: TextRun; d: Point } | null>(null);
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

  useEffect(() => {
    setEditing(null);
    setDragging(null);
  }, [tool, p.doc]);
  // The moved line shows where it's going until the page is redrawn (or the move fails).
  useEffect(() => {
    if (!p.busy) setDragging(null);
  }, [p.busy]);

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

  const regionOf = (run: TextRun): Box => {
    const pad = run.size * 0.1;
    return { x1: run.box.x1 - pad, y1: run.box.y1 - pad, x2: run.box.x2 + pad, y2: run.box.y2 + pad };
  };

  const startEdit = (run: TextRun) => {
    // On a scan, the text you see is part of the picture: find out, and read its look.
    const look = api
      .isHiddenText(page, regionOf(run))
      .then((hidden) => (hidden ? inspectScannedText(p.doc, page, run) : null))
      .catch(() => null);
    setEditing({ run, value: run.text, original: run.text, look });
    void look.then((l) =>
      setEditing((e) => {
        if (!e || e.run !== run) return e;
        if (!l) return { ...e, scan: null };
        // The visible word can be longer than what was recognised: start from all the recognised text it covers.
        const covered = runs
          .filter((r) => {
            const cx = (r.box.x1 + r.box.x2) / 2;
            const cy = (r.box.y1 + r.box.y2) / 2;
            return cx >= l.cover.x1 && cx <= l.cover.x2 && cy >= l.cover.y1 && cy <= l.cover.y2;
          })
          .sort((a, b) => a.box.x1 - b.box.x1)
          .map((r) => r.text.trim())
          .join(' ');
        const original = covered || run.text;
        return { ...e, original, value: e.value === run.text ? original : e.value, scan: { look: l, serif: l.serif, bold: l.bold } };
      }),
    );
  };

  // Dragging a line moves it; a click without moving edits it. Shift keeps it in line.
  const startRunDrag = (e: RPointerEvent, run: TextRun) => {
    if (e.button !== 0 || p.busy) return;
    e.preventDefault();
    e.stopPropagation();
    const start = toPdf(e);
    let d: Point | null = null;
    const move = (ev: PointerEvent) => {
      const [x, y] = toPdf(ev);
      let [dx, dy] = [x - start[0], y - start[1]];
      if (!d && Math.hypot(dx, dy) * scale < 4) return;
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      d = [dx, dy];
      setDragging({ run, d });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!d) return startEdit(run);
      const [dx, dy] = d;
      const region = regionOf(run);
      void api
        .isHiddenText(page, region)
        .then((hidden) => (hidden ? inspectScannedText(p.doc, page, run) : null))
        .catch(() => null)
        .then((look) => {
          if (!look) return api.moveText(page, region, dx, dy);
          const { cover, patch, word } = look;
          api.moveText(page, union(region, cover), dx, dy, { cover, patch, word });
        });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const finishEdit = (commit: boolean) => {
    const ed = editRef.current;
    setEditing(null);
    if (!commit || !ed || ed.value === ed.original) return;
    void ed.look.then((look) => {
      const region = regionOf(ed.run);
      if (!look) return api.replaceText(page, region, ed.value);
      const style = ed.scan ?? { serif: look.serif, bold: look.bold };
      api.replaceText(page, union(region, look.cover), ed.value, {
        cover: look.cover,
        patch: look.patch,
        ink: look.ink,
        font: scanFont(style.serif, style.bold),
        size: look.size,
        origin: look.origin,
      });
    });
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
            className={`edit-run${dragging?.run === r ? ' source' : ''}`}
            style={screen(r.box)}
            title="Click to change this text, drag to move it"
            onPointerDown={(e) => startRunDrag(e, r)}
          />
        ))}
      {dragging && (
        <div
          className="edit-run dragging"
          style={screen({ x1: dragging.run.box.x1 + dragging.d[0], y1: dragging.run.box.y1 + dragging.d[1], x2: dragging.run.box.x2 + dragging.d[0], y2: dragging.run.box.y2 + dragging.d[1] })}
        />
      )}

      {editing && (
        <EditInput
          editing={editing}
          scale={scale}
          screen={screen}
          width={transformBox(p.matrix, editing.scan?.look.cover ?? editing.run.box)}
          onChange={setEditing}
          onFinish={finishEdit}
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

const union = (a: Box, b: Box): Box => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) });

interface Editing {
  run: TextRun;
  value: string;
  /** The text as it was; leaving it unchanged changes nothing. */
  original: string;
  /** Resolves to the scan's look when the text is part of a scanned picture. */
  look: Promise<ScanLook | null>;
  /** Known once `look` resolves; the font can be changed while editing. */
  scan?: { look: ScanLook; serif: boolean; bold: boolean } | null;
}

const rgb = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function EditInput({
  editing,
  scale,
  screen,
  width,
  onChange,
  onFinish,
}: {
  editing: Editing;
  scale: number;
  screen: (b: Box) => CSSProperties;
  width: Box;
  onChange: (e: Editing) => void;
  onFinish: (commit: boolean) => void;
}) {
  const scan = editing.scan;
  const style: CSSProperties = scan
    ? {
        ...screen(scan.look.cover),
        fontSize: scan.look.size * scale,
        background: rgb(scan.look.background),
        color: rgb(scan.look.ink),
        fontFamily: scan.serif ? '"Times New Roman", Times, serif' : 'Helvetica, Arial, sans-serif',
        fontWeight: scan.bold ? 700 : 400,
      }
    : { ...screen(editing.run.box), fontSize: editing.run.size * scale * 0.95 };
  const set = (patch: Partial<{ serif: boolean; bold: boolean }>) => scan && onChange({ ...editing, scan: { ...scan, ...patch } });
  // Keeps focus in the text box while the font buttons are used.
  const keepFocus = (e: RPointerEvent | RMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <>
      <input
        className="edit-input"
        autoFocus
        value={editing.value}
        style={{ ...style, minWidth: width.x2 - width.x1 }}
        onChange={(e) => onChange({ ...editing, value: e.target.value })}
        onBlur={() => onFinish(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') onFinish(true);
          if (e.key === 'Escape') onFinish(false);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {scan && (
        <div
          className="scan-edit-bar"
          style={{ left: (style.left as number) ?? 0, top: ((style.top as number) ?? 0) + ((style.height as number) ?? 0) + 6 }}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
        >
          <span className="muted">Scanned text</span>
          <div className="segmented">
            <button aria-pressed={!scan.serif} onClick={() => set({ serif: false })}>
              Sans
            </button>
            <button aria-pressed={scan.serif} onClick={() => set({ serif: true })} style={{ fontFamily: 'Times, serif' }}>
              Serif
            </button>
          </div>
          <button className={`icon-btn small${scan.bold ? ' active' : ''}`} aria-pressed={scan.bold} onClick={() => set({ bold: !scan.bold })} title="Bold">
            <b>B</b>
          </button>
        </div>
      )}
    </>
  );
}

export const EditLayer = memo(EditLayerImpl);
