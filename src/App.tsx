import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, Plus, X } from 'lucide-react';
import { DocumentView } from './components/DocumentView';
import { PasswordDialog, type PasswordRequest } from './components/PasswordDialog';
import type { SidebarPanel } from './components/Sidebar';
import { getOutline, getPageSizes, loadPdf } from './lib/pdf';
import {
  fileToOpened,
  isPdfName,
  isTauri,
  onMenuCommand,
  onNativeDrop,
  onOsOpenFiles,
  pickPdfFiles,
  readPath,
  setWindowTitle,
  type OpenedFile,
} from './lib/platform';
import { applyTheme, loadTheme, nextTheme, type ThemePref } from './lib/theme';
import { stepZoom, type DocTab, type DocView } from './lib/view';

let nextId = 1;
let devFileLoaded = false;
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export default function App() {
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('thumbs');
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [night, setNight] = useState(false);
  const [findNonce, setFindNonce] = useState(0);
  const [password, setPassword] = useState<PasswordRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(0);
  const [dragging, setDragging] = useState(false);

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
  const openFiles = useCallback(async (files: OpenedFile[]) => {
    for (const file of files) {
      const existing = file.path && tabsRef.current.find((t) => t.path === file.path);
      if (existing) {
        setActiveId(existing.id);
        continue;
      }
      setLoading((n) => n + 1);
      try {
        const doc = await loadPdf(
          file.data,
          (reason) => new Promise((resolve) => setPassword({ fileName: file.name, reason, resolve })),
        );
        if (!doc) continue;
        const [sizes, outline] = await Promise.all([getPageSizes(doc), getOutline(doc).catch(() => [])]);
        if (sizes.length === 0) throw new Error('The document has no pages.');
        const tab: DocTab = {
          id: `doc-${nextId++}`,
          name: file.name,
          path: file.path,
          doc,
          sizes,
          outline,
          view: { zoom: 'page-width', scale: 1, rotation: 0, page: 0 },
        };
        setTabs((ts) => [...ts, tab]);
        setActiveId(tab.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setToast(`Couldn't open “${file.name}”. ${reason}`);
      } finally {
        setLoading((n) => n - 1);
      }
    }
  }, []);

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
        return activeId && closeTab(activeId);
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
      const cmd = map[e.key.toLowerCase()];
      if (!cmd || e.shiftKey) return;
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
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => isPdfName(f.name) || f.type === 'application/pdf');
      if (files.length) void Promise.all(files.map(fileToOpened)).then(openFiles);
      else setToast('Only PDF files can be opened.');
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

  // Development helper: open a PDF from the dev server with ?file=/samples/sample.pdf
  useEffect(() => {
    if (!import.meta.env.DEV || devFileLoaded) return;
    const file = new URLSearchParams(location.search).get('file');
    if (!file || !file.startsWith('/')) return;
    devFileLoaded = true;
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
            onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
            title={t.path ?? t.name}
          >
            <FileText size={14} className="tab-icon" />
            <span className="tab-name">{t.name}</span>
            <button
              className="tab-close"
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="tab-new" onClick={() => void pickAndOpen()} title={`Open (${mod}O)`} aria-label="Open file">
          <Plus size={16} />
        </button>
      </div>

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
          onView={(patch) => updateView(active.id, patch)}
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
            <button className="primary" onClick={() => void pickAndOpen()}>
              <FolderOpen size={16} /> Open file…
            </button>
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

      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
