/** Bridges desktop (Tauri) and plain-browser behaviour. */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface OpenedFile {
  name: string;
  /** Absolute path on disk (desktop only). Used to avoid opening a file twice. */
  path?: string;
  data: Uint8Array;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export async function readPath(path: string): Promise<OpenedFile> {
  const { invoke } = await import('@tauri-apps/api/core');
  const buffer = await invoke<ArrayBuffer>('read_pdf', { path });
  return { name: basename(path), path, data: new Uint8Array(buffer) };
}

export async function fileToOpened(file: File): Promise<OpenedFile> {
  return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
}

export function isPdfName(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

/** Shows the system file picker and reads the chosen PDFs. */
export async function pickPdfFiles(): Promise<OpenedFile[]> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'PDF documents', extensions: ['pdf', 'PDF'] }],
    });
    const paths = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
    return Promise.all(paths.map(readPath));
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.multiple = true;
    input.onchange = () => {
      void Promise.all(Array.from(input.files ?? []).map(fileToOpened)).then(resolve);
    };
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export async function openExternal(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  if (isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
  }
}

type Unlisten = () => void;

/** Native menu commands (desktop only). */
export async function onMenuCommand(handler: (id: string) => void): Promise<Unlisten> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('menu', (e) => handler(e.payload));
}

/** Files opened from the OS: "Open With", double-click, or command line (desktop only). */
export async function onOsOpenFiles(handler: (paths: string[]) => void): Promise<Unlisten> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const { invoke } = await import('@tauri-apps/api/core');
  const drain = async () => {
    const paths = await invoke<string[]>('take_pending_files');
    if (paths.length) handler(paths);
  };
  const unlisten = await listen('open-files', () => void drain());
  await drain();
  return unlisten;
}

export type DragState = 'over' | 'drop' | 'leave';

/** Files dragged onto the desktop window (desktop only; the browser uses HTML drag and drop). */
export async function onNativeDrop(handler: (state: DragState, paths: string[]) => void): Promise<Unlisten> {
  if (!isTauri) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === 'enter' || p.type === 'over') handler('over', []);
    else if (p.type === 'drop') handler('drop', p.paths);
    else handler('leave', []);
  });
}
