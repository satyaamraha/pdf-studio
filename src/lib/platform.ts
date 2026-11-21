/** Bridges desktop (Tauri) and plain-browser behaviour. */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface OpenedFile {
  name: string;
  /** Absolute path on disk (desktop only). Used to avoid opening a file twice. */
  path?: string;
  /** Link to the file on disk (web, Chrome/Edge), so Save can write back to it. */
  handle?: FileSystemFileHandle;
  data: Uint8Array;
}

/** Chrome/Edge let web apps open and save real files instead of uploading and downloading copies. */
export const canAccessFiles = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

const PDF_TYPES: FilePickerType[] = [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }];

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export async function handleToOpened(handle: FileSystemFileHandle): Promise<OpenedFile> {
  const file = await handle.getFile();
  return { name: file.name, handle, data: new Uint8Array(await file.arrayBuffer()) };
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

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(name);
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
  if (canAccessFiles) {
    try {
      const handles = await window.showOpenFilePicker!({ multiple: true, types: PDF_TYPES });
      return Promise.all(handles.map(handleToOpened));
    } catch (err) {
      if (isAbort(err)) return [];
      throw err;
    }
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

// ----- saving -----

/** Asks where to save (desktop). Returns null if the user cancels. */
export async function chooseSavePath(suggested: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ defaultPath: suggested, filters: [{ name: 'PDF documents', extensions: ['pdf'] }] });
}

/** Writes bytes to a .pdf path (desktop). Sent as raw binary, not JSON. */
export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('write_pdf', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Browser fallback: hands the file to the browser's downloads. */
export function downloadFile(bytes: Uint8Array, name: string): void {
  const ext = name.split('.').pop()?.toLowerCase() ?? 'pdf';
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function basenameOf(path: string): string {
  return basename(path);
}

/**
 * Lets the app stop the window closing (desktop) or warn before leaving (browser).
 * `shouldBlock` returns true when there is unsaved work; `onBlocked` then asks the user.
 */
export async function guardClose(shouldBlock: () => boolean, onBlocked: () => void): Promise<Unlisten> {
  if (!isTauri) {
    const handler = (e: BeforeUnloadEvent) => {
      if (shouldBlock()) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().onCloseRequested((event) => {
    if (shouldBlock()) {
      event.preventDefault();
      onBlocked();
    }
  });
}

/** Closes the app without asking again. */
export async function quitApp(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('exit_app');
}

/** Asks for a folder (desktop). Returns null if the user cancels. */
export async function chooseFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const chosen = await open({ directory: true, multiple: false });
  return typeof chosen === 'string' ? chosen : null;
}

// ----- web file access (Chrome/Edge) -----

/** Asks where to save in the browser. Returns null if cancelled. Must run straight after a click or key press. */
export async function chooseSaveHandle(suggestedName: string): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker!({ suggestedName, types: PDF_TYPES });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/** Writes bytes to a file the user chose, asking for permission again if the browser needs it. */
export async function writeHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const opts = { mode: 'readwrite' as const };
  if (handle.queryPermission && (await handle.queryPermission(opts)) !== 'granted') {
    if ((await handle.requestPermission?.(opts)) !== 'granted') throw new Error('Permission to save the file was not given.');
  }
  const writable = await handle.createWritable();
  await writable.write(bytes as BufferSource);
  await writable.close();
}

export async function chooseDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof window.showDirectoryPicker !== 'function') return null;
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export async function writeIntoDirectory(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  await writeHandle(await dir.getFileHandle(name, { create: true }), bytes);
}

/** Files dropped onto the page, keeping links to the originals where the browser allows. */
export function readDroppedFiles(dt: DataTransfer): Promise<OpenedFile[]> {
  const items = Array.from(dt.items).filter((i) => i.kind === 'file');
  // Handles must be requested during the drop event itself.
  const pending = items.map((item) => ({ handle: item.getAsFileSystemHandle?.(), file: item.getAsFile() }));
  return Promise.all(
    pending.map(async ({ handle, file }) => {
      const h = await handle?.catch(() => null);
      if (h && h.kind === 'file') return handleToOpened(h as FileSystemFileHandle);
      return file ? fileToOpened(file) : null;
    }),
  ).then((files) => files.filter((f): f is OpenedFile => !!f && isPdfName(f.name)));
}

/** PDFs the OS asked the installed web app to open ("Open with PDF Studio"). */
export function onLaunchFiles(handler: (files: OpenedFile[]) => void): void {
  window.launchQueue?.setConsumer((params) => {
    if (params.files.length) void Promise.all(params.files.map(handleToOpened)).then(handler);
  });
}

// ----- other file types (exports, pictures) -----

export interface FileKind {
  description: string;
  extensions: string[];
  mime: string;
}

export const WORD: FileKind = { description: 'Word document', extensions: ['docx'], mime: MIME.docx };
const PICTURES: FileKind = { description: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff'], mime: 'image/*' };

/**
 * Saves one file of another type (e.g. .docx): asks where on desktop and in Chrome/Edge,
 * downloads elsewhere. Call straight after a click. Returns the saved name, or null if cancelled.
 */
export async function saveFileAs(name: string, kind: FileKind, make: () => Promise<Uint8Array>): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: name, filters: [{ name: kind.description, extensions: kind.extensions }] });
    if (!path) return null;
    const final = kind.extensions.some((e) => path.toLowerCase().endsWith(`.${e}`)) ? path : `${path}.${kind.extensions[0]}`;
    await writePath(final, await make());
    return basename(final);
  }
  if (canAccessFiles) {
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker!({ suggestedName: name, types: [{ description: kind.description, accept: { [kind.mime]: kind.extensions.map((e) => `.${e}`) } }] });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
    await writeHandle(handle, await make());
    return handle.name;
  }
  downloadFile(await make(), name);
  return name;
}

/** Lets the user pick pictures (to make a PDF from them). */
export async function pickImageFiles(): Promise<File[]> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ multiple: true, directory: false, filters: [{ name: PICTURES.description, extensions: PICTURES.extensions }] });
    const paths = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
    const files = await Promise.all(paths.map(readPath));
    return files.map((f) => new File([f.data as BlobPart], f.name));
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
