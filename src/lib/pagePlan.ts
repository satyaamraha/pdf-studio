import { newId, type Annotation } from './annotations';

/**
 * One page of a planned document: page `index` of source `source` (0 = the document
 * itself, 1+ = files being inserted), turned by an extra `rotate` degrees.
 * A blank page has `blank` set instead.
 */
export interface PageSlot {
  source: number;
  index: number;
  rotate: number;
  blank?: { width: number; height: number };
}

/**
 * Items (annotations, placed form fields) for a planned document: each follows its page
 * to the new position; items on removed pages are dropped; duplicated pages get copies.
 */
export function remapByPage<T extends { id: string; page: number }>(plan: PageSlot[], bySource: T[][]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  plan.forEach((slot, newIndex) => {
    if (slot.blank) return;
    for (const a of bySource[slot.source] ?? []) {
      if (a.page !== slot.index) continue;
      const key = `${slot.source}:${a.id}`;
      const duplicate = seen.has(key);
      seen.add(key);
      out.push({ ...a, page: newIndex, id: duplicate ? newId() : a.id });
    }
  });
  return out;
}

export function remapAnnotations(plan: PageSlot[], itemsBySource: Annotation[][]): Annotation[] {
  return remapByPage(plan, itemsBySource);
}
