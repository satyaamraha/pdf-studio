import { useEffect, useRef, useState } from 'react';
import { ScanText } from 'lucide-react';
import type { PDFDocumentProxy } from '../lib/pdf';
import type { OcrProgress } from '../lib/ocr';

interface Props {
  doc: PDFDocumentProxy;
  base: Uint8Array;
  currentPage: number;
  /** Pages that seem to have no text (likely scanned). */
  emptyPages: number[];
  onDone: (bytes: Uint8Array, pages: number) => void;
  onClose: () => void;
}

const LANG_KEY = 'pdf-studio:ocr-lang';

/** Make scanned pages searchable: choose language and pages, then recognise. */
export function OcrDialog({ doc, base, currentPage, emptyPages, onDone, onClose }: Props) {
  const [languages, setLanguages] = useState<{ code: string; name: string }[]>([{ code: 'eng', name: 'English' }]);
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem(LANG_KEY) || 'eng';
    } catch {
      return 'eng';
    }
  });
  const [scope, setScope] = useState<'empty' | 'all' | 'current'>(emptyPages.length ? 'empty' : 'all');
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void import('../lib/ocr').then((m) => setLanguages(m.OCR_LANGUAGES));
  }, []);

  const pages =
    scope === 'empty' ? emptyPages : scope === 'current' ? [currentPage] : Array.from({ length: doc.numPages }, (_, i) => i);

  const run = async () => {
    setError(null);
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore */
    }
    abort.current = new AbortController();
    setProgress({ page: pages[0], done: 0, total: pages.length, pageProgress: 0, status: 'loading' });
    try {
      const { ocrDocument } = await import('../lib/ocr');
      const bytes = await ocrDocument(doc, base, pages, lang, setProgress, abort.current.signal);
      onDone(bytes, pages.length);
    } catch (err) {
      setProgress(null);
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        lang !== 'eng' && /fetch|network|load/i.test(msg)
          ? `Couldn't download the ${languages.find((l) => l.code === lang)?.name ?? lang} language data. It's needed once; check your connection.`
          : `Text recognition failed: ${msg}`,
      );
    }
  };

  const working = !!progress;
  const pct = progress ? Math.round(((progress.done + progress.pageProgress) / Math.max(1, progress.total)) * 100) : 0;
  const statusText = progress
    ? progress.status === 'loading' || progress.status.startsWith('loading')
      ? 'Loading the text recognition engine…'
      : progress.status === 'adding text'
        ? 'Adding the text to the document…'
        : `Reading page ${progress.page + 1} (${progress.done + 1} of ${progress.total})…`
    : '';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !working && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ocr-title" onKeyDown={(e) => e.key === 'Escape' && !working && onClose()}>
        <div className="modal-icon">
          <ScanText size={20} />
        </div>
        <h2 id="ocr-title">Make text searchable</h2>
        <p>Recognises the text in scanned pages so you can search, select and copy it. The page images stay exactly as they are.</p>
        <div className="dsig-form">
          <label>
            <span>Language of the text</span>
            <select className="bar-select" value={lang} onChange={(e) => setLang(e.target.value)} disabled={working}>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {lang !== 'eng' && <p className="muted small-print">This language is downloaded once (a few MB) the first time, then works offline.</p>}
          <label className={`radio-row${emptyPages.length ? '' : ' disabled'}`}>
            <input type="radio" checked={scope === 'empty'} disabled={!emptyPages.length || working} onChange={() => setScope('empty')} />
            <span>Pages without text ({emptyPages.length})</span>
          </label>
          <label className="radio-row">
            <input type="radio" checked={scope === 'all'} disabled={working} onChange={() => setScope('all')} />
            <span>All pages ({doc.numPages})</span>
          </label>
          <label className="radio-row">
            <input type="radio" checked={scope === 'current'} disabled={working} onChange={() => setScope('current')} />
            <span>This page only (page {currentPage + 1})</span>
          </label>
        </div>
        {working && (
          <div className="ocr-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="ocr-bar">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span className="muted">{statusText}</span>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          {working ? (
            <button onClick={() => abort.current?.abort()}>Cancel</button>
          ) : (
            <>
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={() => void run()} disabled={!pages.length}>
                Recognise text
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
