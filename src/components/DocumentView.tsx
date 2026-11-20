import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveDest, type OutlineNode } from '../lib/pdf';
import { openExternal } from '../lib/platform';
import { makeMatcher, searchDocument, type SearchHit } from '../lib/search';
import type { ThemePref } from '../lib/theme';
import { clampScale, stepZoom, type DocTab, type DocView, type LinkTarget, type Zoom } from '../lib/view';
import { SearchBar } from './SearchBar';
import { Sidebar, type SidebarPanel } from './Sidebar';
import { Toolbar } from './Toolbar';
import { Viewer, type ViewerApi } from './Viewer';

interface Props {
  tab: DocTab;
  sidebarOpen: boolean;
  sidebarPanel: SidebarPanel;
  night: boolean;
  theme: ThemePref;
  findNonce: number;
  onView: (patch: Partial<DocView>) => void;
  onToggleSidebar: () => void;
  onSidebarPanel: (panel: SidebarPanel) => void;
  onToggleNight: () => void;
  onCycleTheme: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

export function DocumentView(props: Props) {
  const { tab, onView } = props;
  const { doc, sizes, view } = tab;
  const viewerApi = useRef<ViewerApi | null>(null);

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

  // ----- navigation -----
  const viewRef = useRef(view);
  viewRef.current = view;

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const page = viewRef.current.page;
      if (e.key === 'ArrowLeft') goToPage(page - 1);
      else if (e.key === 'ArrowRight') goToPage(page + 1);
      else if (e.key === 'Home') goToPage(0);
      else if (e.key === 'End') goToPage(sizes.length - 1);
      else if (e.key === 'Escape' && searchOpen) closeSearch();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToPage, sizes.length, searchOpen]);

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
        onToggleNight={props.onToggleNight}
        onCycleTheme={props.onCycleTheme}
      />
      <div className="document-body">
        {props.sidebarOpen && (
          <Sidebar
            doc={doc}
            sizes={sizes}
            rotation={view.rotation}
            outline={tab.outline}
            page={view.page}
            panel={props.sidebarPanel}
            onPanelChange={props.onSidebarPanel}
            onGoToPage={goToPage}
            onOutline={(node) => void followLink(node)}
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
