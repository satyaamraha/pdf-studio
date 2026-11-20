import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  annotBox,
  commitItems,
  isMarkup,
  newId,
  previewItems,
  redo,
  undo,
  type Annotation,
  type AnnotKind,
  type AnnotState,
  type Tool,
} from '../lib/annotations';
import { pageMatrix } from '../lib/geometry';
import { CSS_UNITS, resolveDest, type OutlineNode } from '../lib/pdf';
import { openExternal } from '../lib/platform';
import { makeMatcher, searchDocument, type SearchHit } from '../lib/search';
import { readSelection } from '../lib/selection';
import type { ThemePref } from '../lib/theme';
import { clampScale, stepZoom, type DocTab, type DocView, type LinkTarget, type Zoom } from '../lib/view';
import { AnnotateBar, TOOL_KEYS } from './AnnotateBar';
import type { AnnotApi, AnnotUi, ToolStyle } from './AnnotationLayer';
import { SearchBar } from './SearchBar';
import { Sidebar, type SidebarPanel } from './Sidebar';
import { Toolbar } from './Toolbar';
import { Viewer, type ViewerApi } from './Viewer';

export interface KindStyle {
  color: string;
  opacity: number;
  width: number;
}

export interface Styles {
  kinds: Record<AnnotKind, KindStyle>;
  fontSize: number;
  stamp: string;
}

interface Props {
  tab: DocTab;
  sidebarOpen: boolean;
  sidebarPanel: SidebarPanel;
  night: boolean;
  theme: ThemePref;
  findNonce: number;
  annotateOpen: boolean;
  styles: Styles;
  author: string;
  dirty: boolean;
  onView: (patch: Partial<DocView>) => void;
  onAnnots: (update: (s: AnnotState) => AnnotState) => void;
  onStyles: (update: (s: Styles) => Styles) => void;
  onAuthor: (name: string) => void;
  onSave: () => void;
  onToggleAnnotate: () => void;
  onToggleSidebar: () => void;
  onSidebarPanel: (panel: SidebarPanel) => void;
  onToggleNight: () => void;
  onCycleTheme: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

const replaceItem = (list: Annotation[], a: Annotation) => list.map((x) => (x.id === a.id ? a : x));

/** Tools that stay active after use; the rest switch back to Select so the new item can be adjusted. */
const STICKY_TOOLS: Tool[] = ['highlight', 'underline', 'strike', 'ink'];

export function DocumentView(props: Props) {
  const { tab, onView, onAnnots } = props;
  const { doc, sizes, view } = tab;
  const items = tab.annots.items;
  const viewerApi = useRef<ViewerApi | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // ----- search -----
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeHit, setActiveHit] = useState(-1);

  useEffect(() => {
    if (props.findNonce === 0) return;
    setSearchOpen(true);
    setFocusNonce((n) => n + 1);
  }, [props.findNonce]);

  useEffect(() => {
    const matcher = searchOpen ? makeMatcher(query, matchCase) : null;
    setHits([]);
    setActiveHit(-1);
    if (!matcher) {
      setSearching(false);
      return;
    }
    const abort = new AbortController();
    let first = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchDocument(doc, matcher, abort.signal, (found) => {
        if (abort.signal.aborted) return;
        setHits(found);
        // Jump to the first result at or after the current page as soon as one exists.
        if (first && found.length) {
          first = false;
          const page = viewRef.current.page;
          const next = found.find((h) => h.page >= page) ?? found[0];
          setActiveHit(next.id);
        }
      }).finally(() => !abort.signal.aborted && setSearching(false));
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [doc, query, matchCase, searchOpen]);

  const hitsByPage = useMemo(() => {
    const map = new Map<number, SearchHit[]>();
    for (const h of hits) {
      const list = map.get(h.page);
      if (list) list.push(h);
      else map.set(h.page, [h]);
    }
    return map;
  }, [hits]);

  // Make sure the page holding the active result is on screen; the page then centres the highlight.
  useEffect(() => {
    const hit = hits[activeHit];
    if (hit && !viewerApi.current?.isMounted(hit.page)) viewerApi.current?.goTo(hit.page);
    // Only when the active result changes, not when more results stream in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHit]);

  const stepHit = (direction: 1 | -1) => {
    if (!hits.length) return;
    setActiveHit((i) => (i < 0 ? 0 : (i + direction + hits.length) % hits.length));
  };

  const closeSearch = () => {
    setSearchOpen(false);
    document.querySelector<HTMLElement>('.viewer')?.focus();
  };

  // ----- annotations -----
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [commentId, setCommentId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const editingRef = useRef(editingId);
  editingRef.current = editingId;
  /** Items as they were before a drag or typing session began; that session becomes one undo step. */
  const pending = useRef<Annotation[] | null>(null);

  const onAnnotsRef = useRef(onAnnots);
  onAnnotsRef.current = onAnnots;
  const finalizePending = useCallback(() => {
    const prev = pending.current;
    if (!prev) return;
    pending.current = null;
    onAnnotsRef.current((s) => (s.items === prev ? s : commitItems(s, s.items, prev)));
  }, []);

  useEffect(() => {
    if (!props.annotateOpen) setTool('select');
  }, [props.annotateOpen]);

  // Leaving the document (switching tab) keeps any half-finished edit.
  useEffect(() => () => finalizePending(), [finalizePending]);

  const annotsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of items) {
      const list = map.get(a.page);
      if (list) list.push(a);
      else map.set(a.page, [a]);
    }
    return map;
  }, [items]);

  const selected = items.find((a) => a.id === selectedId) ?? null;

  // Drop selection if the item disappears (undo, delete).
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
    if (editingId && !items.some((a) => a.id === editingId)) setEditingId(null);
    if (commentId && !items.some((a) => a.id === commentId)) setCommentId(null);
  }, [items, selectedId, selected, editingId, commentId]);

  const api = useRef<AnnotApi>(null!);
  api.current = {
    create(a) {
      finalizePending();
      if (a.kind === 'text') {
        // Not an undo step until the user has typed something.
        pending.current = itemsRef.current;
        onAnnots((s) => previewItems(s, [...s.items, a]));
        setEditingId(a.id);
      } else {
        onAnnots((s) => commitItems(s, [...s.items, a]));
      }
      if (!STICKY_TOOLS.includes(a.kind)) {
        setTool('select');
        setSelectedId(a.id);
      }
      if (a.kind === 'note') setCommentId(a.id);
    },
    update(a, final) {
      if (!final) {
        if (!pending.current) pending.current = itemsRef.current;
        onAnnots((s) => previewItems(s, replaceItem(s.items, a)));
        return;
      }
      const prev = pending.current;
      pending.current = null;
      onAnnots((s) => {
        if (!prev && s.items.find((x) => x.id === a.id) === a) return s;
        return commitItems(s, replaceItem(s.items, a), prev ?? s.items);
      });
    },
    remove(id) {
      const prev = pending.current;
      pending.current = null;
      onAnnots((s) => {
        // Removing something made during the pending edit (an empty text box) leaves no trace.
        if (prev && !prev.some((x) => x.id === id)) return previewItems(s, prev);
        return commitItems(s, s.items.filter((x) => x.id !== id), prev ?? s.items);
      });
      if (selectedRef.current === id) setSelectedId(null);
      setEditingId((e) => (e === id ? null : e));
      setCommentId((c) => (c === id ? null : c));
    },
    select(id) {
      if (id !== selectedRef.current && !editingRef.current) finalizePending();
      setSelectedId(id);
      if (id === null) setCommentId(null);
    },
    editText(id) {
      setEditingId(id);
      if (id) setSelectedId(id);
    },
    openComment(id) {
      if (!id) finalizePending();
      setCommentId(id);
      if (id) setSelectedId(id);
    },
  };
  const stableApi = useMemo<AnnotApi>(
    () => ({
      create: (a) => api.current.create(a),
      update: (a, f) => api.current.update(a, f),
      remove: (id) => api.current.remove(id),
      select: (id) => api.current.select(id),
      editText: (id) => api.current.editText(id),
      openComment: (id) => api.current.openComment(id),
    }),
    [],
  );

  // Style shown in the bar: the selected annotation's, or the current tool's defaults.
  const { styles } = props;
  const styleKind: AnnotKind | null = selected ? selected.kind : tool === 'select' ? null : tool;
  const kindStyle = styleKind ? styles.kinds[styleKind] : styles.kinds.highlight;
  const toolStyle: ToolStyle = useMemo(
    () => ({
      color: selected?.color ?? kindStyle.color,
      opacity: selected?.opacity ?? kindStyle.opacity,
      width: selected && 'width' in selected ? selected.width : kindStyle.width,
      fontSize: selected?.kind === 'text' ? selected.fontSize : styles.fontSize,
      stamp: styles.stamp,
    }),
    [selected, kindStyle, styles.fontSize, styles.stamp],
  );

  const changeStyle = (patch: Partial<ToolStyle>) => {
    if (styleKind) {
      props.onStyles((s) => ({
        ...s,
        fontSize: patch.fontSize ?? s.fontSize,
        stamp: patch.stamp ?? s.stamp,
        kinds: {
          ...s.kinds,
          [styleKind]: {
            ...s.kinds[styleKind],
            ...(patch.color ? { color: patch.color } : {}),
            ...(patch.width ? { width: patch.width } : {}),
          },
        },
      }));
    }
    if (selected) {
      const next = { ...selected, modified: new Date().toISOString() } as Annotation;
      if (patch.color) next.color = patch.color;
      if (patch.width && 'width' in next) next.width = patch.width;
      if (patch.fontSize && next.kind === 'text') next.fontSize = patch.fontSize;
      stableApi.update(next, true);
    }
  };

  const annotUi: AnnotUi = useMemo(
    () => ({ tool, style: toolStyle, author: props.author, selectedId, editingId, commentId, api: stableApi }),
    [tool, toolStyle, props.author, selectedId, editingId, commentId, stableApi],
  );

  const matrixFor = useCallback(
    (page: number) => {
      const s = sizes[page];
      return pageMatrix(s.view, (s.rotate + viewRef.current.rotation) % 360, viewRef.current.scale * CSS_UNITS);
    },
    [sizes],
  );

  // Highlight / underline / strikethrough: select text with the tool active.
  const onPointerUp = () => {
    if (!isMarkup(tool)) return;
    window.setTimeout(() => {
      const found = readSelection(matrixFor);
      if (!found.length) return;
      const now = new Date().toISOString();
      const style = styles.kinds[tool];
      const created: Annotation[] = found.map((f) => ({
        id: newId(),
        kind: tool,
        page: f.page,
        quads: f.quads,
        text: f.text,
        color: style.color,
        opacity: style.opacity,
        comment: '',
        author: props.author,
        created: now,
        modified: now,
      }));
      finalizePending();
      onAnnots((s) => commitItems(s, [...s.items, ...created]));
      window.getSelection()?.removeAllRanges();
    }, 0);
  };

  // Clicking empty space deselects.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.annot-hit, .annot-frame, .annot-handle, .annot-textarea, .comment-pop, .annotatebar, .sidebar'))
      return;
    if (selectedRef.current && !editingRef.current) stableApi.select(null);
  };

  const focusAnnotation = (a: Annotation) => {
    const box = annotBox(a);
    viewerApi.current?.goTo(a.page, box.y2 + 40);
    stableApi.select(a.id);
  };

  // ----- navigation -----
  const goToPage = useCallback(
    (index: number) => viewerApi.current?.goTo(Math.min(sizes.length - 1, Math.max(0, index))),
    [sizes.length],
  );

  const followLink = useCallback(
    async (link: LinkTarget | OutlineNode) => {
      if (link.url) {
        await openExternal(link.url);
        return;
      }
      const target = await resolveDest(doc, link.dest);
      if (target) viewerApi.current?.goTo(target.pageIndex, target.top);
    },
    [doc],
  );

  const keyState = useRef({ tool, selectedId, searchOpen, annotateOpen: props.annotateOpen, readOnly: tab.readOnly });
  keyState.current = { tool, selectedId, searchOpen, annotateOpen: props.annotateOpen, readOnly: tab.readOnly };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = keyState.current;
      const page = viewRef.current.page;
      if ((e.key === 'Delete' || e.key === 'Backspace') && k.selectedId) stableApi.remove(k.selectedId);
      else if (e.key === 'Escape' && k.selectedId) stableApi.select(null);
      else if (e.key === 'Escape' && k.tool !== 'select') setTool('select');
      else if (e.key === 'Escape' && k.searchOpen) closeSearch();
      else if (k.annotateOpen && !e.shiftKey && TOOL_KEYS[e.key.toLowerCase()] && !k.readOnly) setTool(TOOL_KEYS[e.key.toLowerCase()]);
      else if (e.key === 'ArrowLeft') goToPage(page - 1);
      else if (e.key === 'ArrowRight') goToPage(page + 1);
      else if (e.key === 'Home') goToPage(0);
      else if (e.key === 'End') goToPage(sizes.length - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToPage, sizes.length, stableApi]);

  // ----- zoom -----
  const setZoom = (zoom: Zoom) => onView({ zoom });
  const zoomBy = useCallback(
    (factor: number) => {
      const scale = clampScale(viewRef.current.scale * factor);
      onView({ zoom: Math.round(scale * 100) / 100 });
    },
    [onView],
  );

  return (
    <div className="document">
      <Toolbar
        page={view.page}
        pageCount={sizes.length}
        zoom={view.zoom}
        scale={view.scale}
        sidebarOpen={props.sidebarOpen}
        searchOpen={searchOpen}
        annotateOpen={props.annotateOpen}
        dirty={props.dirty}
        night={props.night}
        theme={props.theme}
        onToggleSidebar={props.onToggleSidebar}
        onGoToPage={goToPage}
        onZoom={setZoom}
        onZoomStep={(d) => setZoom(stepZoom(view.scale, d))}
        onRotate={() => onView({ rotation: (view.rotation + 90) % 360 })}
        onToggleSearch={() => {
          if (searchOpen) closeSearch();
          else {
            setSearchOpen(true);
            setFocusNonce((n) => n + 1);
          }
        }}
        onToggleAnnotate={props.onToggleAnnotate}
        onSave={props.onSave}
        onToggleNight={props.onToggleNight}
        onCycleTheme={props.onCycleTheme}
      />
      {props.annotateOpen && (
        <AnnotateBar
          tool={tool}
          style={toolStyle}
          selected={selected}
          canUndo={tab.annots.past.length > 0}
          canRedo={tab.annots.future.length > 0}
          readOnly={tab.readOnly}
          onTool={(t) => {
            finalizePending();
            setTool(t);
            setSelectedId(null);
            setCommentId(null);
          }}
          onStyle={changeStyle}
          onUndo={() => {
            finalizePending();
            onAnnots(undo);
          }}
          onRedo={() => onAnnots(redo)}
          onDelete={() => selectedId && stableApi.remove(selectedId)}
          onComment={() => selectedId && stableApi.openComment(selectedId)}
        />
      )}
      <div className="document-body" onPointerDownCapture={onPointerDownCapture} onPointerUp={onPointerUp}>
        {props.sidebarOpen && (
          <Sidebar
            doc={doc}
            sizes={sizes}
            rotation={view.rotation}
            outline={tab.outline}
            page={view.page}
            panel={props.sidebarPanel}
            annotations={items}
            selectedId={selectedId}
            author={props.author}
            onAuthor={props.onAuthor}
            onPanelChange={props.onSidebarPanel}
            onGoToPage={goToPage}
            onOutline={(node) => void followLink(node)}
            onFocusAnnotation={focusAnnotation}
            onComment={(a, final) => stableApi.update(a, final)}
            onDeleteAnnotation={(id) => stableApi.remove(id)}
          />
        )}
        <div className="viewer-wrap">
          {searchOpen && (
            <SearchBar
              query={query}
              matchCase={matchCase}
              total={hits.length}
              active={activeHit}
              searching={searching}
              focusNonce={focusNonce}
              onQuery={setQuery}
              onMatchCase={setMatchCase}
              onStep={stepHit}
              onClose={closeSearch}
            />
          )}
          <Viewer
            doc={doc}
            sizes={sizes}
            zoom={view.zoom}
            rotation={view.rotation}
            initialPage={view.page}
            night={props.night}
            hitsByPage={hitsByPage}
            activeHit={activeHit}
            apiRef={viewerApi}
            annotsByPage={annotsByPage}
            annotUi={annotUi}
            onPageChange={(page) => onView({ page })}
            onScaleChange={(scale) => onView({ scale })}
            onZoomBy={zoomBy}
            onLink={(l) => void followLink(l)}
          />
        </div>
      </div>
    </div>
  );
}
