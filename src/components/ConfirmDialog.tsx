import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

export interface ConfirmAction {
  label: string;
  kind?: 'primary' | 'danger';
  run?: () => void;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  actions: ConfirmAction[];
}

/** A small modal with a few buttons. Escape or clicking outside picks nothing. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => primaryRef.current?.focus(), []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-icon warn">
          <AlertTriangle size={20} />
        </div>
        <h2 id="confirm-title">{request.title}</h2>
        <p>{request.message}</p>
        <div className="modal-actions">
          {request.actions.map((a) => (
            <button
              key={a.label}
              ref={a.kind === 'primary' ? primaryRef : undefined}
              className={a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger' : undefined}
              onClick={() => {
                onClose();
                a.run?.();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
