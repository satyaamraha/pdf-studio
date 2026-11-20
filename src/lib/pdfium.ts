import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

/**
 * PDFium (Google's PDF engine, BSD/Apache-licensed) compiled to WebAssembly, used for
 * editing page content: redaction, editing text and images. It's 4 MB, so it loads
 * only when editing starts.
 */
export type Pdfium = WrappedPdfiumModule;

let loading: Promise<Pdfium> | null = null;

/** `wasmBinary` lets tests supply the engine directly instead of fetching it. */
export function getPdfium(wasmBinary?: ArrayBuffer): Promise<Pdfium> {
  if (!loading) {
    loading = (async () => {
      const { init } = await import('@embedpdf/pdfium');
      let binary = wasmBinary;
      if (!binary) {
        const { default: url } = await import('@embedpdf/pdfium/pdfium.wasm?url');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Couldn't load the editing engine (${res.status}).`);
        binary = await res.arrayBuffer();
      }
      const m = await init({ wasmBinary: binary });
      m.PDFiumExt_Init();
      return m;
    })();
    loading.catch(() => (loading = null));
  }
  return loading;
}

/** Small helper for passing values in and out of the engine's memory. */
export class Mem {
  private ptrs: number[] = [];
  private m: Pdfium;
  constructor(m: Pdfium) {
    this.m = m;
  }

  alloc(size: number): number {
    const p = this.m.pdfium.wasmExports.malloc(Math.max(1, size));
    this.ptrs.push(p);
    return p;
  }

  bytes(data: Uint8Array): number {
    const p = this.alloc(data.length);
    const heap = (this.m.pdfium as unknown as { HEAPU8?: Uint8Array }).HEAPU8;
    if (heap) heap.set(data, p);
    else for (let i = 0; i < data.length; i++) this.m.pdfium.setValue(p + i, data[i], 'i8');
    return p;
  }

  read(ptr: number, size: number): Uint8Array {
    const heap = (this.m.pdfium as unknown as { HEAPU8?: Uint8Array }).HEAPU8;
    if (heap) return heap.slice(ptr, ptr + size);
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = this.m.pdfium.getValue(ptr + i, 'i8') & 255;
    return out;
  }

  /** UTF-16LE, zero-terminated (PDFium's "wide string"). */
  wide(text: string): number {
    const p = this.alloc((text.length + 1) * 2);
    this.m.pdfium.stringToUTF16(text, p, (text.length + 1) * 2);
    return p;
  }

  f32(ptr: number, i = 0): number {
    return this.m.pdfium.getValue(ptr + i * 4, 'float');
  }

  f64(ptr: number, i = 0): number {
    return this.m.pdfium.getValue(ptr + i * 8, 'double');
  }

  u32(ptr: number, i = 0): number {
    return this.m.pdfium.getValue(ptr + i * 4, 'i32') >>> 0;
  }

  setF32(ptr: number, i: number, v: number): void {
    this.m.pdfium.setValue(ptr + i * 4, v, 'float');
  }

  free(): void {
    for (const p of this.ptrs) this.m.pdfium.wasmExports.free(p);
    this.ptrs = [];
  }
}
