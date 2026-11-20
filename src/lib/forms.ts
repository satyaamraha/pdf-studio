import type { Box } from './geometry';

/**
 * Form fields. Values of every field (existing or new) are kept by field name, which is
 * how PDFs link several widgets to one field. A value is: text for text fields and
 * dropdowns, true/false for checkboxes, the chosen option's export value for radio
 * groups, and a list for multi-select lists.
 */
export type FieldValue = string | boolean | string[];
export type FieldValues = Record<string, FieldValue>;

/** Kinds of field PDF Studio can create. */
export type FieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown';

/** A field placed in PDF Studio. Radio groups are several defs sharing a name. */
export interface FieldDef {
  id: string;
  kind: FieldKind;
  page: number;
  box: Box;
  name: string;
  required: boolean;
  /** Text fields: allow several lines. */
  multiline?: boolean;
  /** Text and dropdown fields: font size in points, 0 = fit automatically. */
  fontSize?: number;
  /** Dropdown choices. */
  options?: string[];
  /** Radio buttons: the value this button gives the group when chosen. */
  radioValue?: string;
}

/** What the viewer needs to draw an input for one widget, from PDF.js or from a FieldDef. */
export interface Widget {
  id: string;
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature';
  /** PDF-space rectangle. */
  box: Box;
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  maxLen: number;
  comb: boolean;
  /** Value this checkbox or radio button stands for when on. */
  onValue: string;
  options: { value: string; label: string }[];
  multiSelect: boolean;
  /** Font size in points; 0 = fit to the box. */
  fontSize: number;
  align: 'left' | 'center' | 'right';
  color: string;
  /** Border and background from the field's own styling (CSS colours), if any. */
  borderColor: string | null;
  backgroundColor: string | null;
  /** Value stored in the file. */
  initial: FieldValue;
  /** Drawn by PDF.js on the page itself (read-only text, signatures): no input on top. */
  drawnByPage: boolean;
  label?: string;
  def?: FieldDef;
  /** Signature fields: already signed (has an appearance). */
  signed?: boolean;
}

type RawAnnotation = Record<string, unknown> & { rect: number[] };

function cssColor(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null;
  const arr = Array.from(c as ArrayLike<number>);
  return arr.length >= 3 ? `rgb(${arr[0]}, ${arr[1]}, ${arr[2]})` : null;
}

const toBox = (r: number[]): Box => ({
  x1: Math.min(r[0], r[2]),
  y1: Math.min(r[1], r[3]),
  x2: Math.max(r[0], r[2]),
  y2: Math.max(r[1], r[3]),
});

/** Turns a PDF.js widget annotation into a Widget, or null if it isn't a form field. */
export function widgetFromAnnotation(a: RawAnnotation): Widget | null {
  if (a.subtype !== 'Widget' || typeof a.fieldName !== 'string') return null;
  const box = toBox(a.rect);
  const da = a.defaultAppearanceData as { fontSize?: number; fontColor?: Record<string, number> } | undefined;
  const c = da?.fontColor;
  const color = c ? `rgb(${[c[0], c[1], c[2]].map((v) => Math.round((v ?? 0) * (v > 1 ? 1 : 255))).join(',')})` : '#000';
  const base: Widget = {
    id: String(a.id),
    name: a.fieldName,
    type: 'text',
    box,
    readOnly: !!a.readOnly,
    required: !!a.required,
    multiline: !!a.multiLine,
    maxLen: Number(a.maxLen) || 0,
    comb: !!a.comb,
    onValue: '',
    options: [],
    multiSelect: !!a.multiSelect,
    fontSize: Number(da?.fontSize) || 0,
    align: a.textAlignment === 1 ? 'center' : a.textAlignment === 2 ? 'right' : 'left',
    color,
    borderColor: cssColor(a.borderColor),
    backgroundColor: cssColor(a.backgroundColor),
    initial: '',
    drawnByPage: !!a.hasOwnCanvas,
  };
  switch (a.fieldType) {
    case 'Tx':
      return { ...base, type: 'text', initial: typeof a.fieldValue === 'string' ? a.fieldValue : '' };
    case 'Btn':
      if (a.checkBox) {
        const on = String(a.exportValue ?? 'Yes');
        return { ...base, type: 'checkbox', onValue: on, initial: a.fieldValue === on || (a.fieldValue !== 'Off' && !!a.fieldValue && a.fieldValue === on) };
      }
      if (a.radioButton) return { ...base, type: 'radio', onValue: String(a.buttonValue), initial: String(a.fieldValue ?? 'Off') };
      return { ...base, type: 'button', readOnly: true, label: typeof a.alternativeText === 'string' ? a.alternativeText : '' };
    case 'Ch': {
      const options = ((a.options as { exportValue: string; displayValue: string }[]) ?? []).map((o) => ({
        value: String(o.exportValue),
        label: String(o.displayValue ?? o.exportValue),
      }));
      const raw = a.fieldValue;
      const list = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
      return a.combo
        ? { ...base, type: 'combo', options, initial: list[0] ?? '' }
        : { ...base, type: 'list', options, initial: list };
    }
    case 'Sig':
      return { ...base, type: 'signature', readOnly: true, drawnByPage: true, signed: !!a.hasAppearance };
  }
  return null;
}

/** A Widget for a field placed in PDF Studio (not yet in the file). */
export function widgetFromDef(def: FieldDef): Widget {
  const base: Widget = {
    id: `def-${def.id}`,
    name: def.name,
    type: 'text',
    box: def.box,
    readOnly: false,
    required: def.required,
    multiline: !!def.multiline,
    maxLen: 0,
    comb: false,
    onValue: '',
    options: [],
    multiSelect: false,
    fontSize: def.fontSize ?? 0,
    align: 'left',
    color: '#000',
    borderColor: 'rgb(140, 148, 166)',
    backgroundColor: 'rgb(255, 255, 255)',
    initial: '',
    drawnByPage: false,
    def,
  };
  switch (def.kind) {
    case 'checkbox':
      return { ...base, type: 'checkbox', onValue: 'Yes', initial: false };
    case 'radio':
      return { ...base, type: 'radio', onValue: def.radioValue ?? '', initial: 'Off' };
    case 'dropdown':
      return { ...base, type: 'combo', options: (def.options ?? []).map((o) => ({ value: o, label: o })) };
    default:
      return base;
  }
}

/** The value to show for a widget: the user's change if there is one, else what's in the file. */
export function currentValue(w: Widget, values: FieldValues): FieldValue {
  return Object.prototype.hasOwnProperty.call(values, w.name) ? values[w.name] : w.initial;
}

/** An empty value of the right type, for "Clear form". */
export function emptyValue(w: Widget): FieldValue {
  if (w.type === 'checkbox') return false;
  if (w.type === 'radio') return 'Off';
  if (w.type === 'list') return [];
  return '';
}

/** Font size to show a text value at: the field's own, or a size that fits its box. */
export function effectiveFontSize(w: Widget): number {
  const h = w.box.y2 - w.box.y1;
  if (w.fontSize > 0 && (w.multiline ? w.fontSize < h * 0.6 : w.fontSize <= h)) return w.fontSize;
  return w.multiline ? 11 : Math.max(6, Math.min(14, h * 0.62));
}

/** A field name not yet used by `taken`, like "Text 3". */
export function uniqueFieldName(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const name = `${prefix} ${i}`;
    if (!taken.has(name)) return name;
  }
}

export const FIELD_LABELS: Record<FieldKind, string> = {
  text: 'Text field',
  checkbox: 'Checkbox',
  radio: 'Radio button',
  dropdown: 'Dropdown',
};
