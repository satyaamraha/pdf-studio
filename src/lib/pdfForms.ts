import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  rgb,
  StandardFonts,
  type PDFField,
  type PDFFont,
} from 'pdf-lib';
import type { FieldDef, FieldValue, FieldValues } from './forms';
import { STUDIO_KEY } from './pdfBytes';

/** Catalog entry pointing at an empty, never-compressed stream that carries the marker, so a byte scan finds our fields. */
const MARKER_KEY = 'PDFStudioForms';

function acroFields(pdf: PDFDocument): PDFArray | undefined {
  const acro = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  return acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
}

/**
 * Takes the fields PDF Studio placed out of the document (so they can be edited again)
 * and returns their definitions plus their saved values.
 */
export function extractStudioFields(pdf: PDFDocument): { defs: FieldDef[]; fields: FieldValues } {
  const defs: FieldDef[] = [];
  const fields: FieldValues = {};
  const list = acroFields(pdf);
  if (!list) return { defs, fields };
  const ctx = pdf.context;
  const pageIndex = new Map(pdf.getPages().map((p, i) => [p.ref.toString(), i]));
  const keep: (PDFRef | PDFDict)[] = [];
  const removedWidgets = new Set<string>();

  for (let i = 0; i < list.size(); i++) {
    const entry = list.get(i);
    const dict = ctx.lookup(entry);
    const data = dict instanceof PDFDict ? dict.get(PDFName.of(STUDIO_KEY)) : undefined;
    if (!(dict instanceof PDFDict) || !(data instanceof PDFHexString || data instanceof PDFString)) {
      keep.push(entry as PDFRef);
      continue;
    }
    let saved: FieldDef[];
    try {
      saved = JSON.parse(data.decodeText()) as FieldDef[];
    } catch {
      keep.push(entry as PDFRef);
      continue;
    }

    // Widgets: the field's kids, or the field itself when they're merged.
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    const widgetRefs: PDFRef[] = [];
    if (kids) for (let k = 0; k < kids.size(); k++) widgetRefs.push(kids.get(k) as PDFRef);
    else if (entry instanceof PDFRef) widgetRefs.push(entry);
    // Each widget's page tells us where the def lives now (pages may have moved elsewhere).
    widgetRefs.forEach((ref, k) => {
      removedWidgets.add(ref.toString());
      const w = ctx.lookup(ref);
      const p = w instanceof PDFDict ? w.get(PDFName.of('P')) : undefined;
      const page = p instanceof PDFRef ? pageIndex.get(p.toString()) : undefined;
      if (saved[k]) defs.push({ ...saved[k], page: page ?? saved[k].page });
    });

    const name = saved[0]?.name;
    const v = dict.lookup(PDFName.of('V'));
    if (name && v) {
      const kind = saved[0].kind;
      if (kind === 'checkbox') fields[name] = v instanceof PDFName && v.decodeText() !== 'Off';
      else if (kind === 'radio') {
        // pdf-lib stores radio choices as "0", "1"… and lists the real values in /Opt.
        const on = v instanceof PDFName ? v.decodeText() : '';
        const byIndex = /^\d+$/.test(on) ? saved[Number(on)]?.radioValue : undefined;
        fields[name] = on === 'Off' ? 'Off' : (byIndex ?? on);
      } else if (v instanceof PDFString || v instanceof PDFHexString) fields[name] = v.decodeText();
    }
  }

  if (keep.length !== list.size()) {
    const acro = pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    acro.set(PDFName.of('Fields'), ctx.obj(keep));
    for (const page of pdf.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const rest = annots.asArray().filter((a) => !(a instanceof PDFRef && removedWidgets.has(a.toString())));
      if (rest.length !== annots.size()) page.node.set(PDFName.of('Annots'), ctx.obj(rest));
    }
  }
  pdf.catalog.delete(PDFName.of(MARKER_KEY));
  return { defs, fields };
}

function widgetRect(def: FieldDef) {
  const { x1, y1, x2, y2 } = def.box;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * pdf-lib's "fit text to the box" sizing breaks on multi-line fields (one giant word),
 * so those get a normal reading size instead.
 */
const MULTILINE_AUTO_SIZE = 11;

function daFontSize(field: PDFTextField): number {
  const da = field.acroField.getDefaultAppearance() ?? '';
  const m = da.match(/([\d.]+)\s+Tf/);
  return m ? Number(m[1]) : 0;
}

const BORDER = { borderWidth: 1, borderColor: rgb(0.55, 0.58, 0.65), backgroundColor: rgb(1, 1, 1) };

/** Adds the fields placed in PDF Studio to the form, tagged so they can be extracted again. */
function createFields(pdf: PDFDocument, defs: FieldDef[], font: PDFFont): void {
  if (!defs.length) return;
  const form = pdf.getForm();
  const pages = pdf.getPages();
  const groups = new Map<string, FieldDef[]>();
  for (const d of defs) {
    if (!pages[d.page]) continue;
    const g = groups.get(d.name);
    if (g) g.push(d);
    else groups.set(d.name, [d]);
  }

  for (const [wanted, group] of groups) {
    // Don't clash with a field already in the file.
    let name = wanted;
    for (let n = 2; form.getFieldMaybe(name); n++) name = `${wanted} (${n})`;
    const first = group[0];
    let field: PDFField;
    switch (first.kind) {
      case 'text': {
        const tf = form.createTextField(name);
        if (first.multiline) tf.enableMultiline();
        for (const d of group) tf.addToPage(pages[d.page], { ...widgetRect(d), ...BORDER, font });
        if (first.fontSize) tf.setFontSize(first.fontSize);
        else if (first.multiline) tf.setFontSize(MULTILINE_AUTO_SIZE);
        field = tf;
        break;
      }
      case 'checkbox': {
        const cb = form.createCheckBox(name);
        for (const d of group) cb.addToPage(pages[d.page], { ...widgetRect(d), ...BORDER });
        field = cb;
        break;
      }
      case 'radio': {
        const rg = form.createRadioGroup(name);
        group.forEach((d, i) => rg.addOptionToPage(d.radioValue || `Choice ${i + 1}`, pages[d.page], { ...widgetRect(d), ...BORDER }));
        field = rg;
        break;
      }
      case 'dropdown': {
        const dd = form.createDropdown(name);
        dd.addOptions(first.options?.length ? first.options : ['']);
        for (const d of group) dd.addToPage(pages[d.page], { ...widgetRect(d), ...BORDER, font });
        if (first.fontSize) dd.setFontSize(first.fontSize);
        field = dd;
        break;
      }
    }
    if (first.required) field.enableRequired();
    field.acroField.dict.set(PDFName.of(STUDIO_KEY), PDFHexString.fromText(JSON.stringify(group.map((d) => ({ ...d, name })))));
  }
  pdf.catalog.set(PDFName.of(MARKER_KEY), pdf.context.register(pdf.context.stream('', { [STUDIO_KEY]: true })));
}

/** Writes one value into a field. Returns false if the field doesn't exist. */
function setValue(field: PDFField, value: FieldValue): void {
  if (field instanceof PDFTextField) {
    let text = typeof value === 'string' ? value : '';
    const max = field.getMaxLength();
    if (max !== undefined) text = text.slice(0, max);
    field.setText(text || undefined);
  } else if (field instanceof PDFCheckBox) {
    if (value === true) field.check();
    else field.uncheck();
  } else if (field instanceof PDFRadioGroup) {
    const v = typeof value === 'string' ? value : '';
    const options = field.getOptions();
    // Some files store choices as "0", "1"… with the names elsewhere: accept either.
    const option = options.includes(v) ? v : /^\d+$/.test(v) ? options[Number(v)] : undefined;
    if (option && v !== 'Off') field.select(option);
    else field.clear();
  } else if (field instanceof PDFDropdown) {
    const v = typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
    if (!v) field.clear();
    else if (field.getOptions().includes(v) || field.isEditable()) field.select(v);
  } else if (field instanceof PDFOptionList) {
    const list = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const valid = list.filter((v) => field.getOptions().includes(v));
    if (valid.length) field.select(valid);
    else field.clear();
  }
}

/**
 * Creates placed fields and fills in values. Appearances are regenerated for the fields
 * that changed so every reader shows the new values; if a value can't be drawn with the
 * standard font (e.g. non-Latin text), readers are asked to draw it themselves.
 */
export async function writeForm(pdf: PDFDocument, defs: FieldDef[], values: FieldValues): Promise<void> {
  if (!defs.length && !Object.keys(values).length) return;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  createFields(pdf, defs, font);
  const form = pdf.getForm();
  let needAppearances = false;
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field || field.isReadOnly()) continue;
    try {
      setValue(field, value);
      if (field instanceof PDFTextField && field.isMultiline()) {
        // 0 = "fit", and pdf-lib-made forms store their broken fitted size (e.g. 81 pt): use a reading size.
        const size = daFontSize(field);
        const height = field.acroField.getWidgets()[0]?.getRectangle().height ?? 0;
        if (size === 0 || size > Math.min(24, height * 0.5)) field.setFontSize(MULTILINE_AUTO_SIZE);
      }
    } catch {
      continue;
    }
    try {
      if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) field.updateAppearances(font);
      else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) field.updateAppearances();
    } catch {
      needAppearances = true;
    }
  }
  if (needAppearances) form.acroForm.dict.set(PDFName.of('NeedAppearances'), pdf.context.obj(true));
}
