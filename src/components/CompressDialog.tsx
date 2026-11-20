import { useState } from 'react';
import { Minimize2 } from 'lucide-react';
import { COMPRESS_LEVELS, compressPdf, formatBytes } from '../lib/pdfPages';

interface Props {
  name: string;
  base: Uint8Array;
  onKeep: (bytes: Uint8Array) => void;
  onClose: () => void;
}

type Phase = { kind: 'choose' } | { kind: 'working'; done: number; total: number } | { kind: 'done'; bytes: Uint8Array; images: number; recompressed: number } | { kind: 'error'; message: string };

/** Lets the user shrink a document and see the result before keeping it. */
export function CompressDialog({ name, base, onKeep, onClose }: Props) {
  const [level, setLevel] = useState(1);
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });

  const run = async () => {
    setPhase({ kind: 'working', done: 0, total: 0 });
    try {
      const result = await compressPdf(base, COMPRESS_LEVELS[level], (done, total) => setPhase({ kind: 'working', done, total }));
      setPhase({ kind: 'done', ...result });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const before = base.length;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && phase.kind !== 'working' && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compress-title"
        onKeyDown={(e) => e.key === 'Escape' && phase.kind !== 'working' && onClose()}
      >
        <div className="modal-icon">
          <Minimize2 size={20} />
        </div>
        <h2 id="compress-title">Reduce file size</h2>

        {phase.kind === 'choose' && (
          <>
            <p>
              “{name}” is {formatBytes(before)}. Photos and scans are re-saved at a lower resolution; text and drawings
              stay sharp.
            </p>
            {COMPRESS_LEVELS.map((l, i) => (
              <label key={l.label} className="radio-row">
                <input type="radio" checked={level === i} onChange={() => setLevel(i)} />
                <span>
                  {l.label} <span className="muted">· pictures up to {l.maxSide}px</span>
                </span>
              </label>
            ))}
            <div className="modal-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={() => void run()}>
                Compress
              </button>
            </div>
          </>
        )}

        {phase.kind === 'working' && (
          <p className="working">
            <span className="spinner" />
            {phase.total ? `Compressing pictures… ${phase.done} of ${phase.total}` : 'Reading the document…'}
          </p>
        )}

        {phase.kind === 'done' && (() => {
          const after = phase.bytes.length;
          const saved = before - after;
          const smaller = saved > before * 0.01;
          return (
            <>
              <p>
                {smaller ? (
                  <>
                    {formatBytes(before)} → <strong>{formatBytes(after)}</strong> ({Math.round((saved / before) * 100)}% smaller).
                  </>
                ) : (
                  <>This document is already about as small as it gets ({formatBytes(after)}).</>
                )}{' '}
                {phase.images > 0 && `${phase.recompressed} of ${phase.images} pictures were reduced.`}
              </p>
              <div className="modal-actions">
                <button onClick={onClose}>{smaller ? 'Discard' : 'Close'}</button>
                {smaller && (
                  <button className="primary" onClick={() => onKeep(phase.bytes)}>
                    Keep smaller version
                  </button>
                )}
              </div>
            </>
          );
        })()}

        {phase.kind === 'error' && (
          <>
            <p className="error">Couldn't compress this document. {phase.message}</p>
            <div className="modal-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
