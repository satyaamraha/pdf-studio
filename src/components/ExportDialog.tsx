import { useState } from 'react';
import { FileDown } from 'lucide-react';

export type ExportChoice =
  | { kind: 'images'; format: 'png' | 'jpeg'; dpi: number; pages: 'all' | 'current' | string }
  | { kind: 'word' };

interface Props {
  pageCount: number;
  currentPage: number;
  busy: string | null;
  onExport: (choice: ExportChoice) => void;
  onClose: () => void;
}

/** Save the document as pictures or as a Word document. */
export function ExportDialog({ pageCount, currentPage, busy, onExport, onClose }: Props) {
  const [kind, setKind] = useState<'png' | 'jpeg' | 'word'>('png');
  const [dpi, setDpi] = useState(150);
  const [scope, setScope] = useState<'all' | 'current' | 'range'>(pageCount > 1 ? 'all' : 'current');
  const [range, setRange] = useState(`1-${pageCount}`);

  const go = () =>
    onExport(kind === 'word' ? { kind: 'word' } : { kind: 'images', format: kind, dpi, pages: scope === 'range' ? range : scope });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-icon">
          <FileDown size={20} />
        </div>
        <h2 id="export-title">Export</h2>
        <div className="segmented sig-tabs" role="tablist">
          {(
            [
              ['png', 'PNG pictures'],
              ['jpeg', 'JPEG pictures'],
              ['word', 'Word document'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} disabled={!!busy}>
              {label}
            </button>
          ))}
        </div>
        {kind === 'word' ? (
          <p>
            Saves the text, headings, bold and italic, fonts and pictures as an editable .docx. Simple documents come out well;
            columns, tables and complex layouts are approximate. Scanned pages need text recognition first.
          </p>
        ) : (
          <div className="dsig-form">
            <p className="muted small-print">
              One picture per page, including your annotations, signatures and form values.
              {kind === 'png' ? ' PNG keeps text sharp.' : ' JPEG makes smaller files, best for photos and scans.'}
            </p>
            <label>
              <span>Resolution</span>
              <select className="bar-select" value={dpi} onChange={(e) => setDpi(Number(e.target.value))} disabled={!!busy}>
                <option value={72}>72 dpi (small, for screens)</option>
                <option value={150}>150 dpi (good for most uses)</option>
                <option value={300}>300 dpi (printing)</option>
                <option value={600}>600 dpi (high-quality printing)</option>
              </select>
            </label>
            <label className="radio-row">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} disabled={!!busy} />
              <span>All pages ({pageCount})</span>
            </label>
            <label className="radio-row">
              <input type="radio" checked={scope === 'current'} onChange={() => setScope('current')} disabled={!!busy} />
              <span>This page (page {currentPage + 1})</span>
            </label>
            <label className="radio-row">
              <input type="radio" checked={scope === 'range'} onChange={() => setScope('range')} disabled={!!busy} />
              <span>
                Pages{' '}
                <input className="num-input range-input" value={range} onChange={(e) => setRange(e.target.value)} onFocus={() => setScope('range')} disabled={!!busy} />
              </span>
            </label>
          </div>
        )}
        {busy && (
          <p className="working">
            <span className="spinner" /> {busy}
          </p>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button className="primary" onClick={go} disabled={!!busy}>
            Export…
          </button>
        </div>
      </div>
    </div>
  );
}
