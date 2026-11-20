import { memo, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { Check, PenLine } from 'lucide-react';
import {
  currentValue,
  effectiveFontSize,
  FIELD_LABELS,
  type FieldDef,
  type FieldKind,
  type FieldValue,
  type FieldValues,
  type Widget,
} from '../lib/forms';
import { apply, invert, transformBox, type Box, type Matrix, type Point } from '../lib/geometry';
import { normalizeBox } from '../lib/annotations';

/** Callbacks from a page's form layer to the document. Kept stable across renders. */
export interface FormApi {
  setValue(name: string, value: FieldValue): void;
  selectDef(id: string | null): void;
  createDef(def: FieldDef): void;
  updateDef(def: FieldDef): void;
  /** An empty "Sign here" field was clicked. */
  signField(page: number, box: Box, name: string): void;
}

/** Document-wide form state every page needs. */
export interface FormUi {
  values: FieldValues;
  highlight: boolean;
  /** Placing and arranging fields (the Forms bar is open). */
  designing: boolean;
  /** Signed or encrypted: values can't be changed. */
  locked: boolean;
  tool: 'select' | FieldKind;
  selectedDefId: string | null;
  /** Makes a def for a new field of `kind` at `box`, choosing its name and settings. */
  newDef: (kind: FieldKind, page: number, box: Box) => FieldDef;
  api: FormApi;
}

interface Props extends FormUi {
  page: number;
  /** Widgets already in the file on this page (from PDF.js). */
  widgets: Widget[];
  /** Widgets for fields placed in PDF Studio on this page. */
  placed: Widget[];
  matrix: Matrix;
}

const DEFAULT_SIZES: Record<FieldKind, [number, number]> = {
  text: [180, 22],
  checkbox: [14, 14],
  radio: [14, 14],
  dropdown: [150, 22],
};

function FormLayerImpl(p: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  // While dragging a placed field, show it where it's going before committing.
  const [moving, setMoving] = useState<FieldDef | null>(null);
  const scale = Math.hypot(p.matrix[0], p.matrix[1]);
  const inv = invert(p.matrix);

  const toPdf = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    return apply(inv, e.clientX - r.left, e.clientY - r.top);
  };

  const placing = p.designing && p.tool !== 'select';

  const onPointerDown = (e: RPointerEvent) => {
    if (!placing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const kind = p.tool as FieldKind;
    const start = toPdf(e);
    let box: Box | null = null;
    const move = (ev: PointerEvent) => {
      const q = toPdf(ev);
      if (Math.hypot(q[0] - start[0], q[1] - start[1]) * scale < 4) return;
      box = normalizeBox(start[0], start[1], q[0], q[1]);
      setDraft(box);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraft(null);
      // A click (no drag) places a field of the usual size.
      const [w, h] = DEFAULT_SIZES[kind];
      const square = kind === 'checkbox' || kind === 'radio';
      let b = box ?? { x1: start[0], y1: start[1] - h, x2: start[0] + w, y2: start[1] };
      if (square && box) {
        const side = Math.max(10, Math.min(b.x2 - b.x1, b.y2 - b.y1));
        b = { x1: b.x1, y1: b.y2 - side, x2: b.x1 + side, y2: b.y2 };
      }
      p.api.createDef(p.newDef(kind, p.page, b));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startDrag = (e: RPointerEvent, def: FieldDef, corner: Point | null) => {
    if (!p.designing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    p.api.selectDef(def.id);
    const start = toPdf(e);
    let next: FieldDef | null = null;
    const move = (ev: PointerEvent) => {
      const [x, y] = toPdf(ev);
      if (corner) {
        const b = normalizeBox(corner[0], corner[1], x, y);
        if (b.x2 - b.x1 < 8 || b.y2 - b.y1 < 8) return;
        next = { ...def, box: b };
      } else {
        const dx = x - start[0];
        const dy = y - start[1];
        if (!next && Math.hypot(dx, dy) * scale < 3) return;
        next = { ...def, box: { x1: def.box.x1 + dx, y1: def.box.y1 + dy, x2: def.box.x2 + dx, y2: def.box.y2 + dy } };
      }
      setMoving(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMoving(null);
      if (next) p.api.updateDef(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const screen = (b: Box): CSSProperties => {
    const s = transformBox(p.matrix, b);
    return { left: s.x1, top: s.y1, width: s.x2 - s.x1, height: s.y2 - s.y1 };
  };

  const widgets = [...p.widgets, ...p.placed.map((w) => (moving && w.def?.id === moving.id ? { ...w, box: moving.box, def: moving } : w))];

  return (
    <div
      ref={rootRef}
      className={`form-layer${p.highlight ? ' show-fields' : ''}${p.designing ? ' designing' : ''}${placing ? ' placing' : ''}`}
      onPointerDown={onPointerDown}
    >
      {widgets.map((w) =>
        w.type === 'signature' && !w.signed && !p.designing ? (
          <button
            key={w.id}
            className="field field-sign"
            style={screen(w.box)}
            onClick={() => p.api.signField(p.page, w.box, w.name)}
            aria-label={`Sign here: ${w.name}`}
          >
            <PenLine style={{ width: '1.1em', height: '1.1em' }} /> Sign here
          </button>
        ) : w.drawnByPage ? null : (
          <FieldInput
            key={w.id}
            w={w}
            style={screen(w.box)}
            scale={scale}
            value={currentValue(w, p.values)}
            // In design mode only placed fields respond, and only to dragging.
            disabled={p.designing || p.locked}
            onChange={(v) => p.api.setValue(w.name, v)}
          />
        ),
      )}

      {p.designing &&
        widgets
          .filter((w) => w.def)
          .map((w) => {
            const def = w.def!;
            const selected = def.id === p.selectedDefId;
            const s = transformBox(p.matrix, def.box);
            const corners: [string, number, number, number, number][] = [
              ['nw', s.x1, s.y1, s.x2, s.y2],
              ['ne', s.x2, s.y1, s.x1, s.y2],
              ['sw', s.x1, s.y2, s.x2, s.y1],
              ['se', s.x2, s.y2, s.x1, s.y1],
            ];
            return (
              <div key={`frame-${def.id}`}>
                <div
                  className={`field-frame${selected ? ' selected' : ''}`}
                  style={screen(def.box)}
                  onPointerDown={(e) => startDrag(e, def, null)}
                  title={`${FIELD_LABELS[def.kind]}: ${def.name}`}
                >
                  <span className="field-tag">
                    {def.name}
                    {def.kind === 'radio' && def.radioValue ? ` · ${def.radioValue}` : ''}
                    {def.required ? ' *' : ''}
                  </span>
                </div>
                {selected &&
                  corners.map(([key, x, y, ox, oy]) => (
                    <div
                      key={key}
                      className={`annot-handle h-${key}`}
                      style={{ left: x - 5, top: y - 5 }}
                      onPointerDown={(e) => startDrag(e, def, apply(inv, ox, oy))}
                    />
                  ))}
              </div>
            );
          })}

      {draft && <div className="field-frame draft" style={screen(draft)} />}
    </div>
  );
}

export const FormLayer = memo(FormLayerImpl);

// ----- one input -----

function FieldInput({
  w,
  style,
  scale,
  value,
  disabled,
  onChange,
}: {
  w: Widget;
  style: CSSProperties;
  scale: number;
  value: FieldValue;
  disabled: boolean;
  onChange: (v: FieldValue) => void;
}) {
  const fontSize = effectiveFontSize(w) * scale;
  const common: CSSProperties = {
    ...style,
    fontSize,
    color: w.color,
    textAlign: w.align,
    borderColor: w.borderColor ?? 'transparent',
    background: w.backgroundColor ?? undefined,
  };
  const label = w.name + (w.required ? ' (required)' : '');
  const off = disabled || w.readOnly;

  switch (w.type) {
    case 'text':
      return (
        <TextInput
          w={w}
          style={common}
          scale={scale}
          value={typeof value === 'string' ? value : ''}
          disabled={off}
          label={label}
          onCommit={onChange}
        />
      );
    case 'checkbox': {
      const checked = value === true;
      return (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={label}
          className={`field field-check${w.required ? ' required' : ''}`}
          style={common}
          disabled={off}
          onClick={() => onChange(!checked)}
        >
          {checked && <Check style={{ width: '82%', height: '82%' }} strokeWidth={3} />}
        </button>
      );
    }
    case 'radio': {
      const checked = value === w.onValue;
      return (
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          aria-label={`${w.name}: ${w.onValue}`}
          className={`field field-radio${w.required ? ' required' : ''}`}
          style={common}
          disabled={off}
          onClick={() => onChange(w.onValue)}
        >
          {checked && <span className="radio-dot" />}
        </button>
      );
    }
    case 'combo':
      return (
        <select
          className={`field field-select${w.required ? ' required' : ''}`}
          style={common}
          aria-label={label}
          disabled={off}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" />
          {w.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'list': {
      const selected = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      return (
        <select
          multiple={w.multiSelect}
          size={Math.max(2, w.options.length)}
          className={`field field-list${w.required ? ' required' : ''}`}
          style={{ ...common, fontSize: Math.min(fontSize, (style.height as number) / Math.max(2, w.options.length) / 1.25) }}
          aria-label={label}
          disabled={off}
          value={w.multiSelect ? selected : (selected[0] ?? '')}
          onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}
        >
          {w.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case 'button':
      return (
        <div className="field field-button" style={common} aria-hidden>
          {w.label}
        </div>
      );
    default:
      return null;
  }
}

/** Text field: edits locally and saves on leaving the field, so undo gets one step per edit. */
function TextInput({
  w,
  style,
  scale,
  value,
  disabled,
  label,
  onCommit,
}: {
  w: Widget;
  style: CSSProperties;
  scale: number;
  value: string;
  disabled: boolean;
  label: string;
  onCommit: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  const commit = () => {
    focused.current = false;
    if (cancelled.current) {
      cancelled.current = false;
      setLocal(value);
      return;
    }
    if (local !== value) onCommit(local);
  };

  // Combed fields (one character per box) spread the letters evenly.
  const comb: CSSProperties =
    w.comb && w.maxLen > 0
      ? {
          letterSpacing: `${(style.width as number) / w.maxLen - (style.fontSize as number) * 0.6}px`,
          paddingLeft: `${((style.width as number) / w.maxLen - (style.fontSize as number) * 0.6) / 2}px`,
          fontFamily: 'ui-monospace, Menlo, monospace',
          textAlign: 'left',
        }
      : {};
  const props = {
    className: `field field-text${w.required ? ' required' : ''}${w.required && !local ? ' empty' : ''}`,
    style: { ...style, ...comb, padding: w.comb ? undefined : `0 ${2 * scale}px` },
    value: local,
    disabled,
    'aria-label': label,
    maxLength: w.maxLen > 0 ? w.maxLen : undefined,
    spellCheck: false,
    onFocus: () => (focused.current = true),
    onBlur: commit,
    onChange: (e: { target: { value: string } }) => setLocal(e.target.value),
  };
  return w.multiline ? (
    <textarea {...props} style={{ ...props.style, padding: `${2 * scale}px` }} />
  ) : (
    <input
      {...props}
      type="text"
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
