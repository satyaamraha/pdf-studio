import type { DocState } from './annotations';
import type { OutlineNode, PageSize, PDFDocumentProxy } from './pdf';

/** 'page-width' and 'page-fit' follow the window size; a number is a fixed scale (1 = 100%). */
export type Zoom = 'page-width' | 'page-fit' | number;

export interface DocView {
  zoom: Zoom;
  /** The scale actually in use, worked out from `zoom` and the window size. */
  scale: number;
  /** Extra clockwise rotation applied to every page: 0, 90, 180 or 270. */
  rotation: number;
  /** Current page, 0-based. */
  page: number;
}

export interface DocTab {
  id: string;
  name: string;
  /** Where the file lives on disk (desktop). */
  path?: string;
  /** Link to the file on disk (web app in Chrome/Edge); Save writes back to it. */
  handle?: FileSystemFileHandle;
  doc: PDFDocumentProxy;
  sizes: PageSize[];
  outline: OutlineNode[];
  view: DocView;
  /** Annotations, the file's bytes (without PDF Studio's annotations) and undo history. */
  annots: DocState;
  /** The bytes `doc` was loaded from. When `annots.base` moves on (page edits, undo), the document reloads. */
  docBase: Uint8Array;
  /** Why the document can't be saved, if it can't (e.g. encrypted). */
  readOnly: string | null;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function stepZoom(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((s) => s > scale + 0.005) ?? MAX_SCALE;
  return [...ZOOM_STEPS].reverse().find((s) => s < scale - 0.005) ?? MIN_SCALE;
}

export interface LinkTarget {
  url: string | null;
  dest: unknown;
}
