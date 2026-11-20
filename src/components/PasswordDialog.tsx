import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import type { PasswordReason } from '../lib/pdf';

export interface PasswordRequest {
  fileName: string;
  reason: PasswordReason;
  resolve: (password: string | null) => void;
}

export function PasswordDialog({ request, onDone }: { request: PasswordRequest; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pw-title"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(value);
        }}
        onKeyDown={(e) => e.key === 'Escape' && onDone(null)}
      >
        <div className="modal-icon">
          <Lock size={20} />
        </div>
        <h2 id="pw-title">Password required</h2>
        <p>
          “{request.fileName}” is protected.
          {request.reason === 'incorrect' && <strong className="error"> That password was incorrect.</strong>}
        </p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          placeholder="Document password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="modal-actions">
          <button type="button" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value}>
            Open
          </button>
        </div>
      </form>
    </div>
  );
}
