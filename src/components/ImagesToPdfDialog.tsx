import { useState } from 'react';
import { Images, X } from 'lucide-react';
import type { ImageLayout } from '../lib/images';
import { pickImageFiles } from '../lib/platform';

interface Props {
  initial: File[];
  busy: boolean;
  onCreate: (files: File[], layout: ImageLayout) => void;
  onClose: () => void;
}

/** Make a PDF from photos or scans: one page per picture. */
export function ImagesToPdfDialog({ initial, busy, onCreate, onClose }: Props) {
  const [files, setFiles] = useState<File[]>(initial);
  const [layout, setLayout] = useState<ImageLayout>(() => (navigator.language.endsWith('US') || navigator.language.endsWith('CA') ? 'letter' : 'a4'));

  const add = async () => setFiles([...files, ...(await pickImageFiles())]);
  const move = (i: number, d: -1 | 1) => {
    const next = [...files];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setFiles(next);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="img-title" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-icon">
          <Images size={20} />
        </div>
        <h2 id="img-title">New PDF from pictures</h2>
        <p>One page per picture, in this order.</p>
        <ol className="img-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="img-name">{f.name}</span>
              <button className="icon-btn small" onClick={() => move(i, -1)} disabled={i === 0 || busy} aria-label="Move up">
                ↑
              </button>
              <button className="icon-btn small" onClick={() => move(i, 1)} disabled={i === files.length - 1 || busy} aria-label="Move down">
                ↓
              </button>
              <button className="icon-btn small" onClick={() => setFiles(files.filter((_, k) => k !== i))} disabled={busy} aria-label="Remove">
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
        <button className="plain-btn small" onClick={() => void add()} disabled={busy}>
          {files.length ? 'Add more pictures…' : 'Choose pictures…'}
        </button>
        <div className="dsig-form">
          <label>
            <span>Page size</span>
            <select className="bar-select" value={layout} onChange={(e) => setLayout(e.target.value as ImageLayout)} disabled={busy}>
              <option value="a4">A4, picture fitted with a margin</option>
              <option value="letter">US Letter, picture fitted with a margin</option>
              <option value="image">Same size as each picture</option>
            </select>
          </label>
        </div>
        {busy && (
          <p className="working">
            <span className="spinner" /> Making the PDF…
          </p>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => onCreate(files, layout)} disabled={!files.length || busy}>
            Create PDF
          </button>
        </div>
      </div>
    </div>
  );
}
