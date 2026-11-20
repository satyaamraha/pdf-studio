import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as RPointerEvent, type RefObject } from 'react';
import {
  Copy,
  FileOutput,
  FilePlus2,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareDashed,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { Annotation } from '../lib/annotations';
import type { FieldDef, FieldValues } from '../lib/forms';
import { remapByPage } from '../lib/pagePlan';
import { getPageSizes, loadPdf, rotatedSize, type PageSize, type PDFDocumentProxy } from '../lib/pdf';
import { isEncrypted } from '../lib/pdfBytes';
import { applyPagePlan, remapAnnotations, type PageSlot } from '../lib/pdfPages';
import { buildPdf, extractStudioAnnotations } from '../lib/pdfWrite';
import { pickPdfFiles } from '../lib/platform';
import { renderThumbnail } from '../lib/thumbnail';

/** A file pages come from: the document itself (0) or a file being inserted. */
interface Source {
  name: string;
  doc: PDFDocumentProxy;
  base: Uint8Array;
  items: Annotation[];
  defs: FieldDef[];
  fields: FieldValues;
  sizes: PageSize[];
}

interface Card extends PageSlot {
  key: string;
}

export interface OrganizeApi {
  undo(): void;
  redo(): void;
}

export interface OutputPart {
  name: string;
  bytes: Uint8Array;
}

interface Props {
  name: string;
  doc: PDFDocumentProxy;
  base: Uint8Array;
  items: Annotation[];
  defs: FieldDef[];
  fields: FieldValues;
  sizes: PageSize[];
  apiRef: RefObject<OrganizeApi | null>;
  onApply: (base: Uint8Array, items: Annotation[], defs: FieldDef[], fields: FieldValues) => void;
  onClose: () => void;
  onOpenNew: (name: string, base: Uint8Array, items: Annotation[], defs: FieldDef[], fields: FieldValues) => void;
  /** Asks where to save, then calls `makeParts` and writes the result. */
  onSaveParts: (makeParts: () => Promise<OutputPart[]>) => Promise<void>;
  onError: (message: string) => void;
}

let keyCounter = 0;
const nextKey = () => `c${++keyCounter}`;

function stem(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

function describePages(numbers: number[]): string {
  if (numbers.length === 1) return `page ${numbers[0]}`;
  const sorted = [...numbers].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return contiguous ? `pages ${sorted[0]}-${sorted[sorted.length - 1]}` : `${numbers.length} pages`;
}

export function OrganizeView(props: Props) {
  const { apiRef } = props;
  const initialCards = useMemo<Card[]>(
    () => props.sizes.map((_, i) => ({ key: nextKey(), source: 0, index: i, rotate: 0 })),
    // Only when organizing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [sources, setSources] = useState<Source[]>(() => [
    { name: props.name, doc: props.doc, base: props.base, items: props.items, defs: props.defs, fields: props.fields, sizes: props.sizes },
  ]);
  const [history, setHistory] = useState<{ cards: Card[]; past: Card[][]; future: Card[][] }>({
    cards: initialCards,
    past: [],
    future: [],
  });
  const { cards, past, future } = history;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [thumbWidth, setThumbWidth] = useState(150);
  const [busy, setBusy] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);

  // Inserted files are owned here; release them when organizing ends.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  useEffect(() => () => sourcesRef.current.slice(1).forEach((s) => void s.doc.destroy()), []);

  const change = useCallback((next: Card[]) => {
    setHistory((h) => ({ cards: next, past: [...h.past.slice(-99), h.cards], future: [] }));
  }, []);

  const undo = useCallback(() => {
    setHistory((h) =>
      h.past.length ? { cards: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.cards, ...h.future] } : h,
    );
  }, []);
  const redo = useCallback(() => {
    setHistory((h) => (h.future.length ? { cards: h.future[0], past: [...h.past, h.cards], future: h.future.slice(1) } : h));
  }, []);

  useEffect(() => {
    apiRef.current = { undo, redo };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, undo, redo]);

  const changed = useMemo(() => {
    if (cards.length !== initialCards.length) return true;
    return cards.some((c, i) => c.source !== 0 || c.index !== i || c.rotate % 360 !== 0 || c.blank);
  }, [cards, initialCards]);

  const selectedCards = cards.filter((c) => selected.has(c.key));
  const hasSelection = selectedCards.length > 0;

  // ----- selection -----
  const onCardClick = (e: MouseEvent, key: string) => {
    // The click that ends a drag isn't a selection change.
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    const next = new Set(selected);
    if (e.shiftKey && anchor.current) {
      const a = cards.findIndex((c) => c.key === anchor.current);
      const b = cards.findIndex((c) => c.key === key);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        for (let i = from; i <= to; i++) next.add(cards[i].key);
        setSelected(next);
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      if (next.has(key)) next.delete(key);
      else next.add(key);
    } else {
      next.clear();
      next.add(key);
    }
    anchor.current = key;
    setSelected(next);
  };

  // ----- page operations -----
  const rotate = (delta: number) =>
    change(cards.map((c) => (selected.has(c.key) ? { ...c, rotate: (((c.rotate + delta) % 360) + 360) % 360 } : c)));

  const remove = () => {
    if (!hasSelection) return;
    if (selectedCards.length === cards.length) {
      props.onError('A PDF needs at least one page. Keep at least one.');
      return;
    }
    change(cards.filter((c) => !selected.has(c.key)));
    setSelected(new Set());
  };

  const duplicate = () => {
    const out: Card[] = [];
    const copies = new Set<string>();
    for (const c of cards) {
      out.push(c);
      if (selected.has(c.key)) {
        const copy = { ...c, key: nextKey() };
        copies.add(copy.key);
        out.push(copy);
      }
    }
    change(out);
    setSelected(copies);
  };

  /** Where new pages go: after the last selected page, or at the end. */
  const insertionIndex = () => {
    let last = -1;
    cards.forEach((c, i) => selected.has(c.key) && (last = i));
    return last >= 0 ? last + 1 : cards.length;
  };

  const sizeOf = (c: Card) => (c.blank ? { width: c.blank.width, height: c.blank.height } : sources[c.source].sizes[c.index]);

  const insertBlank = () => {
    const at = insertionIndex();
    const near = cards[Math.max(0, at - 1)];
    const size = near ? rotatedSize(sizeOf(near), near.rotate) : { width: 612, height: 792 };
    const card: Card = { key: nextKey(), source: 0, index: 0, rotate: 0, blank: { width: size.width, height: size.height } };
    change([...cards.slice(0, at), card, ...cards.slice(at)]);
    setSelected(new Set([card.key]));
  };

  const insertFiles = async () => {
    const files = await pickPdfFiles();
    if (!files.length) return;
    setBusy('Adding pages…');
    try {
      const at = insertionIndex();
      const added: Source[] = [];
      for (const file of files) {
        if (isEncrypted(file.data)) {
          props.onError(`“${file.name}” is encrypted, so its pages can't be added yet.`);
          continue;
        }
        const { base, items, defs, fields } = await extractStudioAnnotations(file.data);
        const doc = await loadPdf(base.slice(), async () => null);
        if (!doc) continue;
        added.push({ name: file.name, doc, base, items, defs, fields, sizes: await getPageSizes(doc) });
      }
      if (!added.length) return;
      const first = sourcesRef.current.length;
      const newCards = added.flatMap((s, n) =>
        s.sizes.map((_, i) => ({ key: nextKey(), source: first + n, index: i, rotate: 0 })),
      );
      setSources((prev) => [...prev, ...added]);
      change([...cards.slice(0, at), ...newCards, ...cards.slice(at)]);
      setSelected(new Set(newCards.map((c) => c.key)));
    } catch (err) {
      props.onError(`Couldn't add pages. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Turns a set of cards into a finished file's bytes and annotations. */
  const build = async (list: Card[]) => {
    const plan: PageSlot[] = list.map(({ source, index, rotate, blank }) => ({ source, index, rotate, blank }));
    const base = await applyPagePlan(sources[0].base, plan, sources.slice(1).map((s) => s.base));
    const items = remapAnnotations(plan, sources.map((s) => s.items));
    const defs = remapByPage(plan, sources.map((s) => s.defs));
    // Values of fields from every file involved (later files don't override earlier ones).
    const fields = Object.assign({}, ...[...sources].reverse().map((s) => s.fields)) as FieldValues;
    return { base, items, defs, fields };
  };

  const apply = async () => {
    setBusy('Applying changes…');
    try {
      const { base, items, defs, fields } = await build(cards);
      props.onApply(base, items, defs, fields);
    } catch (err) {
      props.onError(`Couldn't change the pages. ${err instanceof Error ? err.message : String(err)}`);
      setBusy(null);
    }
  };

  const extract = async () => {
    if (!hasSelection) return;
    setBusy('Extracting pages…');
    try {
      const { base, items, defs, fields } = await build(selectedCards);
      const numbers = selectedCards.map((c) => cards.indexOf(c) + 1);
      props.onOpenNew(`${stem(props.name)} (${describePages(numbers)}).pdf`, base, items, defs, fields);
    } catch (err) {
      props.onError(`Couldn't extract the pages. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const split = async (groups: Card[][]) => {
    setSplitOpen(false);
    try {
      await props.onSaveParts(async () => {
        setBusy('Splitting…');
        const parts: OutputPart[] = [];
        for (let i = 0; i < groups.length; i++) {
          const { base, items, defs, fields } = await build(groups[i]);
          const first = cards.indexOf(groups[i][0]) + 1;
          const last = cards.indexOf(groups[i][groups[i].length - 1]) + 1;
          const range = first === last ? `p${first}` : `p${first}-${last}`;
          parts.push({ name: `${stem(props.name)} (${range}).pdf`, bytes: await buildPdf(base, items, defs, fields) });
        }
        return parts;
      });
    } catch (err) {
      props.onError(`Couldn't split the document. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  // ----- drag to reorder -----
  // Pointer events rather than HTML drag-and-drop: the latter is unreliable inside the
  // desktop app (Tauri's file-drop handling swallows it on Windows).
  const [drag, setDrag] = useState<{ keys: Set<string>; target: number; x: number; y: number } | null>(null);
  const justDragged = useRef(false);

  /** Index the dragged pages would land at, for a pointer position. */
  const targetAt = (x: number, y: number): number => {
    const els = gridRef.current?.querySelectorAll<HTMLElement>('[data-card-index]') ?? [];
    let best = -1;
    let bestDist = Infinity;
    let after = false;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      // Only cards on the pointer's row.
      if (y < r.top - 12 || y > r.bottom + 12) continue;
      const cx = r.left + r.width / 2;
      const d = Math.abs(x - cx);
      if (d < bestDist) {
        bestDist = d;
        best = Number(el.dataset.cardIndex);
        after = x > cx;
      }
    }
    if (best < 0) return cardsLatest.current.length;
    return after ? best + 1 : best;
  };
  const cardsLatest = useRef(cards);
  cardsLatest.current = cards;
  const selectedLatest = useRef(selected);
  selectedLatest.current = selected;

  const startDrag = (e: RPointerEvent, key: string) => {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let keys: Set<string> | null = null;
    let target = -1;
    const move = (ev: PointerEvent) => {
      if (!keys) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        const sel = selectedLatest.current;
        keys = sel.has(key) ? new Set(sel) : new Set([key]);
        if (!sel.has(key)) setSelected(keys);
      }
      target = targetAt(ev.clientX, ev.clientY);
      setDrag({ keys, target, x: ev.clientX, y: ev.clientY });
      // Scroll when dragging near the top or bottom edge.
      const grid = gridRef.current;
      if (grid) {
        const r = grid.getBoundingClientRect();
        if (ev.clientY < r.top + 50) grid.scrollTop -= 14;
        else if (ev.clientY > r.bottom - 50) grid.scrollTop += 14;
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!keys) return;
      justDragged.current = true;
      setDrag(null);
      const list = cardsLatest.current;
      const moving = list.filter((c) => keys!.has(c.key));
      const before = list.slice(0, target).filter((c) => !keys!.has(c.key));
      const after = list.slice(target).filter((c) => !keys!.has(c.key));
      const next = [...before, ...moving, ...after];
      if (next.some((c, i) => c !== list[i])) change(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ----- keyboard -----
  const keys = useRef({ remove, selectAll: () => setSelected(new Set(cards.map((c) => c.key))) });
  keys.current = { remove, selectAll: () => setSelected(new Set(cards.map((c) => c.key))) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        keys.current.remove();
      } else if (e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        keys.current.selectAll();
      } else if (e.key === 'Escape') {
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const gridRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => setRoot(gridRef.current), []);

  return (
    <div className="organize">
      <div className="organizebar" role="toolbar" aria-label="Organize pages">
        <div className="tool-group">
          <button className="icon-btn wide" onClick={() => void insertFiles()} title="Insert pages from other PDFs">
            <FilePlus2 size={17} /> <span>Insert</span>
          </button>
          <button className="icon-btn" onClick={insertBlank} title="Insert a blank page">
            <SquareDashed size={17} />
          </button>
        </div>
        <div className="tool-group">
          <button className="icon-btn" onClick={() => rotate(-90)} disabled={!hasSelection} title="Rotate left">
            <RotateCcw size={17} />
          </button>
          <button className="icon-btn" onClick={() => rotate(90)} disabled={!hasSelection} title="Rotate right">
            <RotateCw size={17} />
          </button>
          <button className="icon-btn" onClick={duplicate} disabled={!hasSelection} title="Duplicate">
            <Copy size={17} />
          </button>
          <button className="icon-btn" onClick={remove} disabled={!hasSelection} title="Delete (Delete key)">
            <Trash2 size={17} />
          </button>
        </div>
        <div className="tool-group">
          <button
            className="icon-btn wide"
            onClick={() => void extract()}
            disabled={!hasSelection}
            title="Make a new document from the selected pages"
          >
            <FileOutput size={17} /> <span>Extract</span>
          </button>
          <button className="icon-btn wide" onClick={() => setSplitOpen(true)} disabled={cards.length < 2} title="Split into several files">
            <Scissors size={17} /> <span>Split</span>
          </button>
        </div>
        <button className="icon-btn" onClick={undo} disabled={!past.length} title="Undo">
          <Undo2 size={17} />
        </button>
        <button className="icon-btn" onClick={redo} disabled={!future.length} title="Redo">
          <Redo2 size={17} />
        </button>
        <input
          className="size-slider"
          type="range"
          min={90}
          max={280}
          value={thumbWidth}
          onChange={(e) => setThumbWidth(Number(e.target.value))}
          aria-label="Thumbnail size"
        />
        <div className="spacer" />
        <span className="bar-note">
          {selected.size ? `${selected.size} of ${cards.length} selected` : `${cards.length} pages`}
        </span>
        <button className="plain-btn" onClick={props.onClose}>
          {changed ? 'Cancel' : 'Done'}
        </button>
        <button className="primary small" onClick={() => void apply()} disabled={!changed || !!busy}>
          Apply changes
        </button>
      </div>

      <div
        className={`organize-grid${drag ? ' is-dragging' : ''}`}
        ref={gridRef}
        onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
      >
        {root &&
          cards.map((c, i) => (
            <PageCard
              key={c.key}
              card={c}
              position={i}
              number={i + 1}
              source={c.blank ? null : sources[c.source]}
              size={sizeOf(c)}
              width={thumbWidth}
              selected={selected.has(c.key)}
              dropBefore={!!drag && drag.target === i}
              dropAfter={!!drag && drag.target === i + 1 && i === cards.length - 1}
              dragging={!!drag && drag.keys.has(c.key)}
              root={root}
              onClick={onCardClick}
              onPointerDown={startDrag}
            />
          ))}
      </div>

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          {drag.keys.size === 1 ? '1 page' : `${drag.keys.size} pages`}
        </div>
      )}

      {busy && (
        <div className="organize-busy">
          <div className="spinner" /> {busy}
        </div>
      )}

      {splitOpen && (
        <SplitDialog cards={cards} selected={selected} onSplit={(g) => void split(g)} onClose={() => setSplitOpen(false)} />
      )}
    </div>
  );
}

// ----- one page in the grid -----

interface CardProps {
  card: Card;
  position: number;
  number: number;
  source: Source | null;
  size: { width: number; height: number };
  width: number;
  selected: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  dragging: boolean;
  root: HTMLElement;
  onClick: (e: MouseEvent, key: string) => void;
  onPointerDown: (e: RPointerEvent, key: string) => void;
}

const PageCard = memo(function PageCard(p: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const shown = rotatedSize(p.size, p.card.rotate);
  const height = Math.round((p.width * shown.height) / shown.width);
  // Render at a fixed size and let CSS scale it, so the size slider doesn't re-render everything.
  const renderWidth = p.width > 180 ? 280 : 180;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { root: p.root, rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [p.root]);

  useEffect(() => {
    if (!visible || !p.source) return;
    const job = renderThumbnail(p.source.doc, p.card.index, p.card.rotate, renderWidth);
    void job.promise.then((canvas) => canvas && hostRef.current?.replaceChildren(canvas));
    return () => job.cancel();
  }, [visible, p.source, p.card.index, p.card.rotate, renderWidth]);

  const fromOther = p.source && p.card.source !== 0;

  return (
    <div
      ref={ref}
      className={`page-card${p.selected ? ' selected' : ''}${p.dragging ? ' dragging' : ''}${p.dropBefore ? ' drop-before' : ''}${p.dropAfter ? ' drop-after' : ''}`}
      style={{ width: p.width }}
      data-card-index={p.position}
      onClick={(e) => p.onClick(e, p.card.key)}
      onPointerDown={(e) => p.onPointerDown(e, p.card.key)}
      role="option"
      aria-selected={p.selected}
      aria-label={`Page ${p.number}`}
    >
      <div ref={hostRef} className={`page-card-thumb${p.source ? '' : ' blank'}`} style={{ width: p.width, height }} />
      <div className="page-card-label">
        <span>{p.number}</span>
        {fromOther && (
          <span className="page-card-source" title={p.source!.name}>
            {p.source!.name}
          </span>
        )}
        {p.card.blank && <span className="page-card-source">Blank</span>}
      </div>
    </div>
  );
});

// ----- split dialog -----

function SplitDialog({
  cards,
  selected,
  onSplit,
  onClose,
}: {
  cards: Card[];
  selected: Set<string>;
  onSplit: (groups: Card[][]) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'every' | 'selected'>(selected.size ? 'selected' : 'every');
  const [every, setEvery] = useState(1);

  const groups = useMemo(() => {
    const out: Card[][] = [];
    if (mode === 'every') {
      const n = Math.max(1, every);
      for (let i = 0; i < cards.length; i += n) out.push(cards.slice(i, i + n));
    } else {
      let current: Card[] = [];
      for (const c of cards) {
        if (selected.has(c.key) && current.length) {
          out.push(current);
          current = [];
        }
        current.push(c);
      }
      if (current.length) out.push(current);
    }
    return out;
  }, [mode, every, cards, selected]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="split-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-icon">
          <Scissors size={20} />
        </div>
        <h2 id="split-title">Split into separate files</h2>
        <label className="radio-row">
          <input type="radio" checked={mode === 'every'} onChange={() => setMode('every')} />
          <span>
            Every{' '}
            <input
              className="num-input"
              type="number"
              min={1}
              max={cards.length}
              value={every}
              onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))}
              onFocus={() => setMode('every')}
            />{' '}
            page{every === 1 ? '' : 's'}
          </span>
        </label>
        <label className={`radio-row${selected.size ? '' : ' disabled'}`}>
          <input type="radio" checked={mode === 'selected'} disabled={!selected.size} onChange={() => setMode('selected')} />
          <span>Start a new file at each selected page</span>
        </label>
        <p>
          This makes <strong>{groups.length}</strong> file{groups.length === 1 ? '' : 's'}. Your document itself isn't changed.
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={groups.length < 2} onClick={() => onSplit(groups)}>
            Split
          </button>
        </div>
      </div>
    </div>
  );
}
