import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FormInput,
  PencilRuler,
  Signature,
  LayoutGrid,
  Minimize2,
  Minus,
  Moon,
  PanelLeft,
  PenLine,
  Save,
  Plus,
  RotateCw,
  Search,
  Monitor,
  Sun,
  SunMoon,
} from 'lucide-react';
import { ZOOM_STEPS, type Zoom } from '../lib/view';
import type { ThemePref } from '../lib/theme';

interface Props {
  page: number;
  pageCount: number;
  zoom: Zoom;
  scale: number;
  sidebarOpen: boolean;
  searchOpen: boolean;
  annotateOpen: boolean;
  formsOpen: boolean;
  editOpen: boolean;
  organizeOpen: boolean;
  canEdit: boolean;
  canSign: boolean;
  dirty: boolean;
  night: boolean;
  theme: ThemePref;
  onToggleSidebar: () => void;
  onGoToPage: (index: number) => void;
  onZoom: (zoom: Zoom) => void;
  onZoomStep: (direction: 1 | -1) => void;
  onRotate: () => void;
  onToggleSearch: () => void;
  onToggleAnnotate: () => void;
  onToggleForms: () => void;
  onToggleEdit: () => void;
  onSign: () => void;
  onToggleOrganize: () => void;
  onCompress: () => void;
  onSave: () => void;
  onToggleNight: () => void;
  onCycleTheme: () => void;
}

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function Toolbar(p: Props) {
  const [pageText, setPageText] = useState(String(p.page + 1));
  useEffect(() => setPageText(String(p.page + 1)), [p.page]);

  const commitPage = () => {
    const n = parseInt(pageText, 10);
    if (Number.isFinite(n)) p.onGoToPage(Math.min(p.pageCount, Math.max(1, n)) - 1);
    else setPageText(String(p.page + 1));
  };

  const zoomValue = typeof p.zoom === 'number' ? 'custom' : p.zoom;
  const percent = `${Math.round(p.scale * 100)}%`;
  const ThemeIcon = p.theme === 'light' ? Sun : p.theme === 'dark' ? Moon : Monitor;

  return (
    <div className="toolbar" role="toolbar" aria-label="Document">
      <button
        className={`icon-btn${p.sidebarOpen ? ' on' : ''}`}
        onClick={p.onToggleSidebar}
        title="Sidebar"
        aria-pressed={p.sidebarOpen}
      >
        <PanelLeft size={18} />
      </button>

      <div className="group">
        <button className="icon-btn" onClick={() => p.onGoToPage(p.page - 1)} disabled={p.page <= 0} title="Previous page">
          <ChevronLeft size={18} />
        </button>
        <input
          className="page-input"
          value={pageText}
          inputMode="numeric"
          aria-label="Page number"
          onChange={(e) => setPageText(e.target.value.replace(/\D/g, ''))}
          onBlur={commitPage}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitPage();
              (e.target as HTMLInputElement).blur();
            }
          }}
          onFocus={(e) => e.target.select()}
        />
        <span className="page-count">of {p.pageCount}</span>
        <button
          className="icon-btn"
          onClick={() => p.onGoToPage(p.page + 1)}
          disabled={p.page >= p.pageCount - 1}
          title="Next page"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="group">
        <button className="icon-btn" onClick={() => p.onZoomStep(-1)} title={`Zoom out (${mod}−)`}>
          <Minus size={18} />
        </button>
        <select
          className="zoom-select"
          aria-label="Zoom"
          value={zoomValue}
          onChange={(e) => {
            const v = e.target.value;
            p.onZoom(v === 'page-width' || v === 'page-fit' ? v : Number(v));
          }}
        >
          <option value="custom" hidden>
            {percent}
          </option>
          <option value="page-width">Fit width{p.zoom === 'page-width' ? ` (${percent})` : ''}</option>
          <option value="page-fit">Fit page{p.zoom === 'page-fit' ? ` (${percent})` : ''}</option>
          {ZOOM_STEPS.filter((s) => s >= 0.5 && s <= 4).map((s) => (
            <option key={s} value={s}>
              {Math.round(s * 100)}%
            </option>
          ))}
        </select>
        <button className="icon-btn" onClick={() => p.onZoomStep(1)} title={`Zoom in (${mod}+)`}>
          <Plus size={18} />
        </button>
      </div>

      <button className="icon-btn" onClick={p.onRotate} title={`Rotate view (${mod}R)`}>
        <RotateCw size={18} />
      </button>

      <button
        className={`icon-btn wide${p.annotateOpen && !p.organizeOpen ? ' on' : ''}`}
        onClick={p.onToggleAnnotate}
        title="Annotate"
        aria-pressed={p.annotateOpen}
        disabled={p.organizeOpen || !p.canEdit}
      >
        <PenLine size={17} /> <span>Annotate</span>
      </button>
      <button
        className="icon-btn wide"
        onClick={p.onSign}
        title="Sign: add your signature, initials or the date"
        disabled={p.organizeOpen || !p.canSign}
        data-sign-toggle
      >
        <Signature size={17} /> <span>Sign</span>
      </button>
      <button
        className={`icon-btn wide${p.formsOpen && !p.organizeOpen ? ' on' : ''}`}
        onClick={p.onToggleForms}
        title="Forms: fill in fields, or add new ones"
        aria-pressed={p.formsOpen}
        disabled={p.organizeOpen || !p.canEdit}
      >
        <FormInput size={17} /> <span>Forms</span>
      </button>
      <button
        className={`icon-btn wide${p.editOpen && !p.organizeOpen ? ' on' : ''}`}
        onClick={p.onToggleEdit}
        title={p.canEdit ? 'Edit: change text and pictures, redact' : 'This document can’t be changed'}
        aria-pressed={p.editOpen}
        disabled={p.organizeOpen || !p.canEdit}
      >
        <PencilRuler size={17} /> <span>Edit</span>
      </button>
      <button
        className={`icon-btn wide${p.organizeOpen ? ' on' : ''}`}
        onClick={p.onToggleOrganize}
        title={p.canEdit ? 'Organize pages: reorder, rotate, delete, insert, extract, split' : 'Encrypted PDFs can’t be changed yet'}
        aria-pressed={p.organizeOpen}
        disabled={!p.canEdit}
      >
        <LayoutGrid size={17} /> <span>Organize</span>
      </button>
      <button className="icon-btn" onClick={p.onCompress} title="Reduce file size" disabled={!p.canEdit || p.organizeOpen}>
        <Minimize2 size={17} />
      </button>

      <div className="spacer" />

      <button
        className={`icon-btn${p.dirty ? ' dirty' : ''}`}
        onClick={p.onSave}
        title={`Save (${mod}S)${p.dirty ? ' — unsaved changes' : ''}`}
      >
        <Save size={18} />
      </button>

      <button
        className={`icon-btn${p.searchOpen ? ' on' : ''}`}
        onClick={p.onToggleSearch}
        title={`Find (${mod}F)`}
        aria-pressed={p.searchOpen}
      >
        <Search size={18} />
      </button>
      <button
        className={`icon-btn${p.night ? ' on' : ''}`}
        onClick={p.onToggleNight}
        title="Night reading (dark pages)"
        aria-pressed={p.night}
      >
        <SunMoon size={18} />
      </button>
      <button className="icon-btn" onClick={p.onCycleTheme} title={`Theme: ${p.theme}`}>
        <ThemeIcon size={18} />
      </button>
    </div>
  );
}
