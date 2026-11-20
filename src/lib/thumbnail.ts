import type { PDFDocumentProxy } from './pdf';

/** At most this many thumbnails render at once, so scrolling a big document stays responsive. */
const MAX_CONCURRENT = 3;
let running = 0;
const queue: (() => void)[] = [];

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
  const next = queue.shift();
  if (next) next();
  else running--;
}

export interface ThumbnailJob {
  promise: Promise<HTMLCanvasElement | null>;
  cancel(): void;
}

/**
 * Draws page `index` (0-based) at `width` CSS pixels wide with an extra clockwise
 * `rotation`. Resolves to null if cancelled or if drawing fails.
 */
export function renderThumbnail(doc: PDFDocumentProxy, index: number, rotation: number, width: number): ThumbnailJob {
  let cancelled = false;
  let task: { promise: Promise<void>; cancel(): void } | null = null;
  const promise = (async () => {
    await acquire();
    try {
      if (cancelled) return null;
      const page = await doc.getPage(index + 1);
      if (cancelled) return null;
      const total = (page.rotate + rotation) % 360;
      const unit = page.getViewport({ scale: 1, rotation: total });
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / unit.width) * dpr, rotation: total });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return null;
      task = page.render({ canvasContext: ctx, viewport });
      await task.promise;
      return cancelled ? null : canvas;
    } catch {
      return null;
    } finally {
      release();
    }
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}
