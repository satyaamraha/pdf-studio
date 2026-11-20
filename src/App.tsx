import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Combine, Download, FileText, FolderOpen, Plus, RefreshCw, X } from 'lucide-react';
const CompressDialog = lazy(() => import('./components/CompressDialog').then((m) => ({ default: m.CompressDialog })));
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { DocumentView, type Styles } from './components/DocumentView';
import type { OrganizeApi, OutputPart } from './components/OrganizeView';
import { PasswordDialog, type PasswordRequest } from './components/PasswordDialog';
import type { SidebarPanel } from './components/Sidebar';
import { commitDocument, initialDocState, isDirty, redo, undo, type Annotation, type DocState } from './lib/annotations';
import { getOutline, getPageSizes, loadPdf } from './lib/pdf';
import { hasStudioMarker, isEncrypted } from './lib/pdfBytes';
import { remapAnnotations, type PageSlot } from './lib/pagePlan';
// pdf-lib (saving, page edits) loads on first use rather than at start-up.
const pdfWrite = () => import('./lib/pdfWrite');
const pdfPages = () => import('./lib/pdfPages');
import {
  basenameOf,
  canAccessFiles,
  chooseDirectoryHandle,
  chooseFolder,
  chooseSaveHandle,
  chooseSavePath,
  downloadFile,
  guardClose,
  isPdfName,
  isTauri,
  onMenuCommand,
  onNativeDrop,
  onOsOpenFiles,
  pickPdfFiles,
  onLaunchFiles,
  quitApp,
  readDroppedFiles,
  readPath,
  setWindowTitle,
  writeHandle,
  writeIntoDirectory,
  writePath,
  type OpenedFile,
} from './lib/platform';
import { applyTheme, loadTheme, nextTheme, type ThemePref } from './lib/theme';
import { getPwaState, promptInstall, reloadForUpdate, subscribePwa } from './pwa';
import { stepZoom, type DocTab, type DocView } from './lib/view';

let nextId = 1;
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const DEFAULT_STYLES: Styles = {
  kinds: {
    highlight: { color: '#ffd400', opacity: 0.5, width: 2 },
    underline: { color: '#51cf66', opacity: 1, width: 2 },
    strike: { color: '#ff6b6b', opacity: 1, width: 2 },
    note: { color: '#ffd400', opacity: 1, width: 1 },
    ink: { color: '#ff6b6b', opacity: 1, width: 2 },
    rect: { color: '#ff6b6b', opacity: 1, width: 2 },
    ellipse: { color: '#ff6b6b', opacity: 1, width: 2 },
    line: { color: '#ff6b6b', opacity: 1, width: 2 },
    arrow: { color: '#ff6b6b', opacity: 1, width: 2 },
    text: { color: '#212529', opacity: 1, width: 1 },
    stamp: { color: '#ff6b6b', opacity: 1, width: 2 },
  },
  fontSize: 14,
  stamp: 'APPROVED',
};

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`pdf-studio:${key}`);
    if (raw) return { ...fallback, ...JSON.parse(raw) } as T;
  } catch {
    /* storage unavailable or corrupt */
  }
  return fallback;
}

function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`pdf-studio:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function isTyping(el: Element | null): boolean {
  return !!el && ((el as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function App() {
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Phones and narrow windows start with the page list hidden.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('thumbs');
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [night, setNight] = useState(false);
  const [findNonce, setFindNonce] = useState(0);
  const [password, setPassword] = useState<PasswordRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [styles, setStyles] = useState<Styles>(() => {
    const saved = loadPref<Styles>('styles', DEFAULT_STYLES);
    return { ...saved, kinds: { ...DEFAULT_STYLES.kinds, ...saved.kinds } };
  });
  const [author, setAuthor] = useState<string>(() => loadPref<{ name: string }>('author', { name: '' }).name);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const organizeApi = useRef<OrganizeApi | null>(null);

  useEffect(() => savePref('styles', styles), [styles]);
  useEffect(() => savePref('author', { name: author }), [author]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const active = tabs.find((t) => t.id === activeId) ?? null;

  useEffect(() => applyTheme(theme), [theme]);
  const title = active ? `${active.name} — PDF Studio` : 'PDF Studio';
  useEffect(() => void setWindowTitle(title), [title]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ----- opening and closing -----

  /** Loads `base` into PDF.js and adds a tab for it. Returns false if the user cancelled a password prompt. */
  const addTab = useCallback(
    async (opts: {
      name: string;
      path?: string;
      handle?: FileSystemFileHandle;
      base: Uint8Array;
      items: Annotation[];
      encrypted: boolean;
      unsaved?: boolean;
    }) => {
      // PDF.js takes ownership of the bytes it is given, so give it a copy.
      const doc = await loadPdf(
        opts.base.slice(),
        (reason) => new Promise((resolve) => setPassword({ fileName: opts.name, reason, resolve })),
      );
      if (!doc) return false;
      const [sizes, outline] = await Promise.all([getPageSizes(doc), getOutline(doc).catch(() => [])]);
      if (sizes.length === 0) throw new Error('The document has no pages.');
      const tab: DocTab = {
        id: `doc-${nextId++}`,
        name: opts.name,
        path: opts.path,
        handle: opts.handle,
        doc,
        sizes,
        outline,
        view: { zoom: 'page-width', scale: 1, rotation: 0, page: 0 },
        annots: initialDocState(opts.base, opts.items, opts.unsaved),
        docBase: opts.base,
        readOnly: opts.encrypted ? 'Encrypted PDFs can be read but not changed or saved yet.' : null,
      };
      setTabs((ts) => [...ts, tab]);
      setActiveId(tab.id);
      return true;
    },
    [],
  );

  /** A new, not-yet-saved document (extracted pages, combined files). */
  const openGenerated = useCallback(
    async (name: string, base: Uint8Array, items: Annotation[]) => {
      setLoading((n) => n + 1);
      try {
        await addTab({ name, base, items, encrypted: false, unsaved: true });
      } catch (err) {
        setToast(`Couldn't open “${name}”. ${errorText(err)}`);
      } finally {
        setLoading((n) => n - 1);
      }
    },
    [addTab],
  );

  /** Several PDFs → one new document, then Organize so the pages can be arranged. */
  const combineFiles = useCallback(async () => {
    try {
      const files = (await pickPdfFiles()).filter((f) => {
        if (!isEncrypted(f.data)) return true;
        setToast(`“${f.name}” is encrypted and was left out.`);
        return false;
      });
      if (files.length === 0) return;
      setLoading((n) => n + 1);
      try {
        const { extractStudioAnnotations } = await pdfWrite();
        const { applyPagePlan } = await pdfPages();
        const sources = await Promise.all(files.map((f) => extractStudioAnnotations(f.data)));
        const counts = await Promise.all(
          sources.map(async (src) => {
            const doc = await loadPdf(src.base.slice(), async () => null);
            const n = doc?.numPages ?? 0;
            void doc?.destroy();
            return n;
          }),
        );
        const plan: PageSlot[] = counts.flatMap((n, source) => Array.from({ length: n }, (_, index) => ({ source, index, rotate: 0 })));
        const base = await applyPagePlan(sources[0].base, plan, sources.slice(1).map((s) => s.base));
        const items = remapAnnotations(plan, sources.map((s) => s.items));
        const name = files.length === 1 ? files[0].name : 'Combined.pdf';
        await addTab({ name, base, items, encrypted: false, unsaved: true });
        setOrganizeOpen(true);
      } finally {
        setLoading((n) => n - 1);
      }
    } catch (err) {
      setToast(`Couldn't combine the files. ${errorText(err)}`);
    }
  }, [addTab]);

  /**
   * Writes split parts: into a chosen folder (desktop, Chrome/Edge) or as downloads.
   * The folder is asked for before the parts are built, while the click still counts.
   */
  const saveParts = useCallback(async (makeParts: () => Promise<OutputPart[]>) => {
    if (isTauri) {
      const folder = await chooseFolder();
      if (!folder) return;
      const parts = await makeParts();
      const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
      for (const part of parts) await writePath(`${folder.replace(/[\\/]$/, '')}${sep}${part.name}`, part.bytes);
      setToast(`Saved ${parts.length} files to ${basenameOf(folder)}.`);
      return;
    }
    const dir = canAccessFiles ? await chooseDirectoryHandle() : null;
    if (canAccessFiles && !dir) return;
    const parts = await makeParts();
    if (dir) {
      for (const part of parts) await writeIntoDirectory(dir, part.name, part.bytes);
      setToast(`Saved ${parts.length} files to ${dir.name}.`);
      return;
    }
    for (const part of parts) {
      downloadFile(part.bytes, part.name);
      await new Promise((r) => setTimeout(r, 300));
    }
    setToast(`Downloaded ${parts.length} files.`);
  }, []);

  const openFiles = useCallback(async (files: OpenedFile[]) => {
    for (const file of files) {
      let existing = file.path ? tabsRef.current.find((t) => t.path === file.path) : undefined;
      if (!existing && file.handle) {
        for (const t of tabsRef.current) {
          if (t.handle && (await t.handle.isSameEntry(file.handle))) existing = t;
        }
      }
      if (existing) {
        setActiveId(existing.id);
        continue;
      }
      setLoading((n) => n + 1);
      try {
        // PDF Studio's own annotations come out of the file so they stay editable.
        const encrypted = isEncrypted(file.data);
        let base = file.data;
        let items: Annotation[] = [];
        if (!encrypted && hasStudioMarker(file.data)) {
          try {
            ({ base, items } = await (await pdfWrite()).extractStudioAnnotations(file.data));
          } catch {
            /* unreadable by pdf-lib: show the file as it is */
          }
        }
        await addTab({ name: file.name, path: file.path, handle: file.handle, base, items, encrypted });
      } catch (err) {
        setToast(`Couldn't open “${file.name}”. ${errorText(err)}`);
      } finally {
        setLoading((n) => n - 1);
      }
    }
  }, [addTab]);

  const openPaths = useCallback(
    async (paths: string[]) => {
      const files: OpenedFile[] = [];
      for (const path of paths.filter(isPdfName)) {
        try {
          files.push(await readPath(path));
        } catch (err) {
          setToast(`Couldn't read ${path}: ${String(err)}`);
        }
      }
      await openFiles(files);
    },
    [openFiles],
  );

  const pickAndOpen = useCallback(async () => {
    try {
      await openFiles(await pickPdfFiles());
    } catch (err) {
      setToast(String(err));
    }
  }, [openFiles]);

  const closeTab = useCallback((id: string) => {
    const ts = tabsRef.current;
    const i = ts.findIndex((t) => t.id === id);
    if (i < 0) return;
    void ts[i].doc.destroy();
    const rest = ts.filter((t) => t.id !== id);
    setTabs(rest);
    setActiveId((current) => (current === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : current));
  }, []);

  const updateAnnots = useCallback((id: string, update: (s: DocState) => DocState) => {
    setTabs((ts) => {
      let changed = false;
      const next = ts.map((t) => {
        if (t.id !== id) return t;
        const annots = update(t.annots);
        if (annots === t.annots) return t;
        changed = true;
        return { ...t, annots };
      });
      return changed ? next : ts;
    });
  }, []);

  // When a document's bytes change (page edits, compression, undo of those), reload it.
  const reloading = useRef(new Map<string, Uint8Array>());
  useEffect(() => {
    for (const tab of tabs) {
      const target = tab.annots.base;
      if (target === tab.docBase || reloading.current.get(tab.id) === target) continue;
      reloading.current.set(tab.id, target);
      void (async () => {
        try {
          const doc = await loadPdf(target.slice(), async () => null);
          if (!doc) return;
          const [sizes, outline] = await Promise.all([getPageSizes(doc), getOutline(doc).catch(() => [])]);
          let used = false;
          setTabs((ts) =>
            ts.map((t) => {
              // Only if nothing newer arrived meanwhile.
              if (t.id !== tab.id || t.annots.base !== target) return t;
              used = true;
              void t.doc.destroy();
              const page = Math.min(t.view.page, sizes.length - 1);
              return { ...t, doc, sizes, outline, docBase: target, view: { ...t.view, page } };
            }),
          );
          if (!used) void doc.destroy();
        } catch (err) {
          setToast(`Couldn't show the changed document. ${errorText(err)}`);
        } finally {
          if (reloading.current.get(tab.id) === target) reloading.current.delete(tab.id);
        }
      })();
    }
  }, [tabs]);

  // ----- saving -----
  const saveTab = useCallback(async (id: string, saveAs = false): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return false;
    if (tab.readOnly) {
      setToast(tab.readOnly);
      return false;
    }
    const { items, base } = tab.annots;
    try {
      let path = tab.path;
      let handle = tab.handle;
      let name = tab.name;
      // Ask where to save first: browsers only allow the save dialog right after a click or key press.
      if (isTauri && (saveAs || !path)) {
        const chosen = await chooseSavePath(path ?? name);
        if (!chosen) return false;
        path = isPdfName(chosen) ? chosen : `${chosen}.pdf`;
        name = basenameOf(path);
      } else if (!isTauri && canAccessFiles && (saveAs || !handle)) {
        const chosen = await chooseSaveHandle(name);
        if (!chosen) return false;
        handle = chosen;
        name = chosen.name;
      }
      setLoading((n) => n + 1);
      try {
        const bytes = await (await pdfWrite()).buildPdf(base, items);
        if (isTauri && path) await writePath(path, bytes);
        else if (handle) await writeHandle(handle, bytes);
        else downloadFile(bytes, name);
      } finally {
        setLoading((n) => n - 1);
      }
      setTabs((ts) =>
        ts.map((t) => (t.id === id ? { ...t, path, handle, name, annots: { ...t.annots, saved: { base, items } } } : t)),
      );
      setToast(`Saved “${name}”.`);
      return true;
    } catch (err) {
      setToast(`Couldn't save “${tab.name}”. ${errorText(err)}`);
      return false;
    }
  }, []);

  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      if (!isDirty(tab.annots)) return closeTab(id);
      setActiveId(id);
      setConfirm({
        title: `Save changes to “${tab.name}”?`,
        message: "Your changes will be lost if you don't save them.",
        actions: [
          { label: "Don't Save", kind: 'danger', run: () => closeTab(id) },
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', run: () => void saveTab(id).then((ok) => ok && closeTab(id)) },
        ],
      });
    },
    [closeTab, saveTab],
  );

  const dirtyTabs = () => tabsRef.current.filter((t) => isDirty(t.annots));
  const confirmQuit = useCallback(() => {
    const dirty = tabsRef.current.filter((t) => isDirty(t.annots));
    setConfirm({
      title: dirty.length === 1 ? `“${dirty[0].name}” has unsaved changes` : `${dirty.length} documents have unsaved changes`,
      message: 'If you quit now, your unsaved changes will be lost.',
      actions: [
        { label: 'Quit Anyway', kind: 'danger', run: () => void quitApp() },
        { label: 'Cancel', kind: 'primary' },
      ],
    });
  }, []);

  useEffect(() => {
    const p = guardClose(() => tabsRef.current.some((t) => isDirty(t.annots)), confirmQuit);
    return () => void p.then((f) => f());
  }, [confirmQuit]);

  const updateView = useCallback((id: string, patch: Partial<DocView>) => {
    setTabs((ts) => {
      let changed = false;
      const next = ts.map((t) => {
        if (t.id !== id) return t;
        const keys = Object.keys(patch) as (keyof DocView)[];
        if (keys.every((k) => t.view[k] === patch[k])) return t;
        changed = true;
        return { ...t, view: { ...t.view, ...patch } };
      });
      return changed ? next : ts;
    });
  }, []);

  // ----- commands (menu bar on desktop, keyboard shortcuts in the browser) -----
  const runCommand = (cmd: string) => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    const view = (patch: Partial<DocView>) => tab && updateView(tab.id, patch);
    switch (cmd) {
      case 'open':
        return void pickAndOpen();
      case 'close_tab':
        return activeId && requestCloseTab(activeId);
      case 'save':
        return tab && void saveTab(tab.id);
      case 'save_as':
        return tab && void saveTab(tab.id, true);
      case 'undo':
      case 'redo':
        // In a text field the menu item edits the text, as usual.
        if (isTyping(document.activeElement)) return void document.execCommand(cmd);
        if (organizeOpen && organizeApi.current) return organizeApi.current[cmd]();
        return tab && updateAnnots(tab.id, cmd === 'undo' ? undo : redo);
      case 'organize':
        return tab && !tab.readOnly && setOrganizeOpen((v) => !v);
      case 'compress':
        return tab && !tab.readOnly && setCompressOpen(true);
      case 'combine':
        return void combineFiles();
      case 'quit':
        return dirtyTabs().length ? confirmQuit() : void quitApp();
      case 'find':
        return tab && setFindNonce((n) => n + 1);
      case 'zoom_in':
        return tab && view({ zoom: stepZoom(tab.view.scale, 1) });
      case 'zoom_out':
        return tab && view({ zoom: stepZoom(tab.view.scale, -1) });
      case 'actual_size':
        return view({ zoom: 1 });
      case 'fit_width':
        return view({ zoom: 'page-width' });
      case 'fit_page':
        return view({ zoom: 'page-fit' });
      case 'rotate':
        return tab && view({ rotation: (tab.view.rotation + 90) % 360 });
      case 'toggle_sidebar':
        return setSidebarOpen((v) => !v);
      case 'toggle_night':
        return setNight((v) => !v);
    }
  };
  const commandRef = useRef(runCommand);
  commandRef.current = runCommand;

  useEffect(() => {
    const unlisten = [onMenuCommand((id) => commandRef.current(id)), onOsOpenFiles((paths) => void openPaths(paths))];
    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, [openPaths]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Ctrl+Tab / Ctrl+Shift+Tab switch tabs everywhere.
      if (e.key === 'Tab' && e.ctrlKey) {
        const ts = tabsRef.current;
        const i = ts.findIndex((t) => t.id === activeId);
        if (ts.length > 1) setActiveId(ts[(i + (e.shiftKey ? -1 : 1) + ts.length) % ts.length].id);
        e.preventDefault();
        return;
      }
      // On desktop the native menu owns these shortcuts.
      if (isTauri) return;
      const map: Record<string, string> = {
        s: 'save',
        'shift+s': 'save_as',
        'shift+o': 'organize',
        z: 'undo',
        'shift+z': 'redo',
        y: 'redo',
        o: 'open',
        w: 'close_tab',
        f: 'find',
        '=': 'zoom_in',
        '+': 'zoom_in',
        '-': 'zoom_out',
        '0': 'actual_size',
        '1': 'fit_width',
        '2': 'fit_page',
        r: 'rotate',
      };
      const cmd = map[(e.shiftKey ? 'shift+' : '') + e.key.toLowerCase()];
      if (!cmd) return;
      // Let text fields handle their own undo.
      if ((cmd === 'undo' || cmd === 'redo') && isTyping(document.activeElement)) return;
      e.preventDefault();
      commandRef.current(cmd);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId]);

  // ----- drag and drop -----
  useEffect(() => {
    if (isTauri) {
      const p = onNativeDrop((state, paths) => {
        setDragging(state === 'over');
        if (state === 'drop') void openPaths(paths);
      });
      return () => void p.then((f) => f());
    }
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer) return;
      void readDroppedFiles(e.dataTransfer).then((files) => {
        if (files.length) void openFiles(files);
        else setToast('Only PDF files can be opened.');
      });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [openFiles, openPaths]);

  // Installed web app: PDFs opened from the OS ("Open with PDF Studio").
  useEffect(() => {
    if (!isTauri) onLaunchFiles((files) => void openFiles(files));
  }, [openFiles]);

  // Development helper: open a PDF from the dev server with ?file=/samples/sample.pdf
  useEffect(() => {
    // Kept on window so hot reloads during development don't open the file again.
    const flags = window as { __pdfStudioDevFile?: boolean };
    if (!import.meta.env.DEV || flags.__pdfStudioDevFile) return;
    const file = new URLSearchParams(location.search).get('file');
    if (!file || !file.startsWith('/')) return;
    flags.__pdfStudioDevFile = true;
    void fetch(file)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
      .then((buf) => openFiles([{ name: file.split('/').pop() || 'document.pdf', data: new Uint8Array(buf) }]))
      .catch((err) => setToast(`Couldn't load ${file}: ${String(err)}`));
  }, [openFiles]);

  return (
    <div className="app">
      <div className="tabbar" role="tablist" aria-label="Open documents">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab${t.id === activeId ? ' active' : ''}`}
            onClick={() => setActiveId(t.id)}
            onAuxClick={(e) => e.button === 1 && requestCloseTab(t.id)}
            title={t.path ?? t.name}
          >
            <FileText size={14} className="tab-icon" />
            <span className="tab-name">{t.name}</span>
            <button
              className={`tab-close${isDirty(t.annots) ? ' dirty' : ''}`}
              aria-label={`Close ${t.name}${isDirty(t.annots) ? ' (unsaved changes)' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTab(t.id);
              }}
            >
              <X size={13} className="tab-x" />
              <span className="tab-dirty" />
            </button>
          </div>
        ))}
        <button className="tab-new" onClick={() => void pickAndOpen()} title={`Open (${mod}O)`} aria-label="Open file">
          <Plus size={16} />
        </button>
        {pwa.canInstall && (
          <button className="install-btn" onClick={() => void promptInstall()} title="Install PDF Studio as an app">
            <Download size={14} /> Install app
          </button>
        )}
      </div>

      {pwa.updateReady && (
        <div className="update-bar" role="status">
          <RefreshCw size={14} /> A new version of PDF Studio is ready.
          <button
            className="primary small"
            onClick={() => {
              if (tabsRef.current.some((t) => isDirty(t.annots))) {
                setToast('Save your changes first, then update.');
                return;
              }
              void reloadForUpdate();
            }}
          >
            Update now
          </button>
        </div>
      )}

      {loading > 0 && <div className="progress" aria-label="Loading" />}

      {active ? (
        <DocumentView
          key={active.id}
          tab={active}
          sidebarOpen={sidebarOpen}
          sidebarPanel={sidebarPanel}
          night={night}
          theme={theme}
          findNonce={findNonce}
          annotateOpen={annotateOpen}
          organizeOpen={organizeOpen}
          organizeApi={organizeApi}
          styles={styles}
          author={author}
          dirty={isDirty(active.annots)}
          onView={(patch) => updateView(active.id, patch)}
          onAnnots={(update) => updateAnnots(active.id, update)}
          onStyles={setStyles}
          onAuthor={setAuthor}
          onSave={() => void saveTab(active.id)}
          onToggleAnnotate={() => setAnnotateOpen((v) => !v)}
          onToggleOrganize={() => setOrganizeOpen((v) => !v)}
          onCompress={() => setCompressOpen(true)}
          onOpenNew={(name, base, items) => {
            setOrganizeOpen(false);
            void openGenerated(name, base, items);
          }}
          onSaveParts={saveParts}
          onError={setToast}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onSidebarPanel={setSidebarPanel}
          onToggleNight={() => setNight((v) => !v)}
          onCycleTheme={() => setTheme(nextTheme)}
        />
      ) : (
        <div className="empty">
          <div className="empty-card">
            <div className="empty-icon">
              <FileText size={34} strokeWidth={1.5} />
            </div>
            <h1>Open a PDF to start reading</h1>
            <p>Drop files anywhere in this window, or choose them from your computer.</p>
            <div className="empty-actions">
              <button className="primary" onClick={() => void pickAndOpen()}>
                <FolderOpen size={16} /> Open file…
              </button>
              <button className="secondary" onClick={() => void combineFiles()}>
                <Combine size={16} /> Combine files…
              </button>
            </div>
            <p className="hint">
              <kbd>{mod}O</kbd> open · <kbd>{mod}F</kbd> find · <kbd>{mod}+</kbd>/<kbd>{mod}−</kbd> zoom
            </p>
          </div>
        </div>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div>Drop PDF files to open them</div>
        </div>
      )}

      {password && (
        <PasswordDialog
          request={password}
          onDone={(value) => {
            password.resolve(value);
            setPassword(null);
          }}
        />
      )}

      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}

      {compressOpen && active && (
        <Suspense fallback={null}>
        <CompressDialog
          name={active.name}
          base={active.annots.base}
          onClose={() => setCompressOpen(false)}
          onKeep={(bytes) => {
            setCompressOpen(false);
            updateAnnots(active.id, (s) => commitDocument(s, bytes, s.items));
          }}
        />
        </Suspense>
      )}

      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
