import { boxFromPoints, padBox, type Box, type Point } from './geometry';
import { wrapText } from './textMetrics';

/**
 * Annotations made in PDF Studio. All coordinates are PDF user space of the page
 * (points, y grows upwards), so they don't depend on zoom or rotation.
 */
export type MarkupKind = 'highlight' | 'underline' | 'strike';
export type BoxKind = 'rect' | 'ellipse' | 'text' | 'stamp';
export type LineKind = 'line' | 'arrow';
export type AnnotKind = MarkupKind | BoxKind | LineKind | 'ink' | 'note';

interface Base {
  id: string;
  page: number;
  color: string;
  opacity: number;
  comment: string;
  author: string;
  created: string;
  modified: string;
}

export interface MarkupAnnot extends Base {
  kind: MarkupKind;
  /** One quadrilateral per line of text: [x1,y1, x2,y2, x3,y3, x4,y4] = top-left, top-right, bottom-left, bottom-right. */
  quads: number[][];
  /** The text that was marked, for the comments list. */
  text: string;
}

export interface NoteAnnot extends Base {
  kind: 'note';
  /** Top-left corner of the note icon. */
  x: number;
  y: number;
}

export interface InkAnnot extends Base {
  kind: 'ink';
  paths: Point[][];
  width: number;
}

export interface ShapeAnnot extends Base {
  kind: 'rect' | 'ellipse';
  box: Box;
  width: number;
}

export interface LineAnnot extends Base {
  kind: LineKind;
  from: Point;
  to: Point;
  width: number;
}

export interface TextAnnot extends Base {
  kind: 'text';
  box: Box;
  text: string;
  fontSize: number;
}

export interface StampAnnot extends Base {
  kind: 'stamp';
  box: Box;
  label: string;
}

export type Annotation = MarkupAnnot | NoteAnnot | InkAnnot | ShapeAnnot | LineAnnot | TextAnnot | StampAnnot;

export type Tool = 'select' | AnnotKind;

export const NOTE_SIZE = 20;

export const COLORS = ['#ffd400', '#ff6b6b', '#4dabf7', '#51cf66', '#cc5de8', '#212529'];

export const STAMPS = ['APPROVED', 'REJECTED', 'DRAFT', 'CONFIDENTIAL', 'FINAL', 'FOR COMMENT', 'NOT APPROVED', 'VOID'];

export const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'Strikethrough',
  note: 'Note',
  ink: 'Draw',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text box',
  stamp: 'Stamp',
};

export function isMarkup(kind: Tool): kind is MarkupKind {
  return kind === 'highlight' || kind === 'underline' || kind === 'strike';
}

export function isBoxKind(kind: Tool): kind is BoxKind {
  return kind === 'rect' || kind === 'ellipse' || kind === 'text' || kind === 'stamp';
}

export function hasStrokeWidth(kind: Tool): boolean {
  return kind === 'ink' || kind === 'rect' || kind === 'ellipse' || kind === 'line' || kind === 'arrow';
}

let counter = 0;
export function newId(): string {
  counter++;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${counter.toString(36)}-${rand}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]: number[]): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Size of a stamp for a label, before the user resizes it. */
export function stampSize(label: string): { width: number; height: number } {
  const height = 34;
  return { width: Math.max(90, label.length * 11 + 28), height };
}

export const TEXT_PADDING = 4;
export const TEXT_LINE_HEIGHT = 1.2;

export function textLines(a: TextAnnot): string[] {
  return wrapText(a.text, a.fontSize, a.box.x2 - a.box.x1 - TEXT_PADDING * 2);
}

/** Box around everything the annotation draws (PDF space), used for selection and the PDF /Rect. */
export function annotBox(a: Annotation): Box {
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strike': {
      const pts: Point[] = [];
      for (const q of a.quads) for (let i = 0; i < 8; i += 2) pts.push([q[i], q[i + 1]]);
      return boxFromPoints(pts);
    }
    case 'note':
      return { x1: a.x, y1: a.y - NOTE_SIZE, x2: a.x + NOTE_SIZE, y2: a.y };
    case 'ink':
      return padBox(boxFromPoints(a.paths.flat()), a.width / 2 + 1);
    case 'line':
    case 'arrow':
      return padBox(boxFromPoints([a.from, a.to]), a.width * 3 + 4);
    default:
      return a.box;
  }
}

/** Moves an annotation by (dx, dy) in PDF space. */
export function translate<T extends Annotation>(a: T, dx: number, dy: number): T {
  const mv = ([x, y]: Point): Point => [x + dx, y + dy];
  const mvBox = (b: Box): Box => ({ x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy });
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strike':
      return { ...a, quads: a.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx))) };
    case 'note':
      return { ...a, x: a.x + dx, y: a.y + dy };
    case 'ink':
      return { ...a, paths: a.paths.map((p) => p.map(mv)) };
    case 'line':
    case 'arrow':
      return { ...a, from: mv(a.from), to: mv(a.to) };
    default:
      return { ...a, box: mvBox(a.box) };
  }
}

export function normalizeBox(x1: number, y1: number, x2: number, y2: number): Box {
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
}

/** Plain-language summary for lists. */
export function describe(a: Annotation): string {
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strike':
      return a.text;
    case 'text':
      return a.text;
    case 'stamp':
      return a.label;
    default:
      return '';
  }
}

/** Arrowhead lines for an arrow ending at `to`, as two points either side. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const len = Math.max(8, width * 4);
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const spread = Math.PI / 7;
  return [
    [to[0] - len * Math.cos(angle - spread), to[1] - len * Math.sin(angle - spread)],
    [to[0] - len * Math.cos(angle + spread), to[1] - len * Math.sin(angle + spread)],
  ];
}

/** Turns a list of points into a smooth SVG/PDF-friendly set of cubic curves (Catmull-Rom). */
export function smoothPath(points: Point[]): { start: Point; curves: [Point, Point, Point][] } {
  const curves: [Point, Point, Point][] = [];
  if (points.length < 2) return { start: points[0] ?? [0, 0], curves };
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    curves.push([c1, c2, p2]);
  }
  return { start: points[0], curves };
}

/** Drops points closer than `minDist` to the previous kept point, to keep ink paths small. */
export function simplifyPoints(points: Point[], minDist: number): Point[] {
  if (points.length <= 2) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = out[out.length - 1];
    if (Math.hypot(points[i][0] - px, points[i][1] - py) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// ----- Undo / redo history -----

/** One version of a document: its file bytes (without PDF Studio annotations) and its annotations. */
export interface Snapshot {
  base: Uint8Array;
  items: Annotation[];
}

/**
 * The editable state of an open document. Annotation edits change `items`; page
 * edits (reorder, delete, compress…) change `base`. Both share one undo history.
 */
export interface DocState extends Snapshot {
  past: Snapshot[];
  future: Snapshot[];
  /** The version last saved (or opened). Unsaved changes exist when it differs. */
  saved: Snapshot;
}

export function initialDocState(base: Uint8Array, items: Annotation[], unsaved = false): DocState {
  // A brand-new document (e.g. combined files) starts unsaved.
  const saved = unsaved ? { base: new Uint8Array(), items: [] } : { base, items };
  return { base, items, past: [], future: [], saved };
}

// Page edits keep whole copies of the file, so keep fewer of those.
const HISTORY_LIMIT = 100;

function push(past: Snapshot[], snap: Snapshot): Snapshot[] {
  return [...past.slice(-HISTORY_LIMIT + 1), snap];
}

/** Applies an annotation change. With `previous`, records that snapshot (used when a drag started earlier). */
export function commitItems(state: DocState, items: Annotation[], previous: Annotation[] = state.items): DocState {
  if (items === previous) return { ...state, items };
  return { ...state, items, past: push(state.past, { base: state.base, items: previous }), future: [] };
}

/** Applies a change to the file itself (page edits, compression), with the annotations that go with it. */
export function commitDocument(state: DocState, base: Uint8Array, items: Annotation[]): DocState {
  return { ...state, base, items, past: push(state.past, { base: state.base, items: state.items }), future: [] };
}

/** Replaces items without adding an undo step (live preview while dragging). */
export function previewItems(state: DocState, items: Annotation[]): DocState {
  return { ...state, items };
}

export function undo(state: DocState): DocState {
  const prev = state.past[state.past.length - 1];
  if (!prev) return state;
  return {
    ...state,
    ...prev,
    past: state.past.slice(0, -1),
    future: [{ base: state.base, items: state.items }, ...state.future],
  };
}

export function redo(state: DocState): DocState {
  const next = state.future[0];
  if (!next) return state;
  return { ...state, ...next, past: push(state.past, { base: state.base, items: state.items }), future: state.future.slice(1) };
}

export function isDirty(state: DocState): boolean {
  return state.items !== state.saved.items || state.base !== state.saved.base;
}

export function markSaved(state: DocState, saved: Snapshot): DocState {
  return { ...state, saved };
}
