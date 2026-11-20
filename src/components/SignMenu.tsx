import { useEffect, useRef } from 'react';
import { CalendarDays, Plus, ShieldCheck, X } from 'lucide-react';
import type { SavedSignature, SignatureRole } from '../lib/signatures';

interface Props {
  signatures: SavedSignature[];
  /** Signing a "Sign here" field rather than placing freely. */
  forField: boolean;
  canDigitallySign: boolean;
  /** Handwritten signatures and dates are edits; not allowed on signed or encrypted files. */
  visualAllowed: boolean;
  onPick: (sig: SavedSignature) => void;
  onNew: (role: SignatureRole) => void;
  onDate: () => void;
  onDelete: (id: string) => void;
  onDigital: () => void;
  onClose: () => void;
}

/** Saved signatures and initials, plus ways to add new ones. */
export function SignMenu(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-sign-toggle]')) p.onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [p]);

  const section = (role: SignatureRole, title: string) => {
    const list = p.signatures.filter((s) => s.role === role);
    return (
      <div className="sign-section">
        <div className="sign-title">{title}</div>
        {list.map((s) => (
          <div key={s.id} className="sign-item">
            <button className="sign-pick" onClick={() => p.onPick(s)} title={`Place this ${role === 'initials' ? 'set of initials' : 'signature'}`}>
              <img src={s.src} alt={role === 'initials' ? 'Saved initials' : 'Saved signature'} />
            </button>
            <button className="icon-btn small sign-remove" onClick={() => p.onDelete(s.id)} title="Remove from this device" aria-label="Remove">
              <X size={14} />
            </button>
          </div>
        ))}
        <button className="sign-new" onClick={() => p.onNew(role)}>
          <Plus size={14} /> {role === 'initials' ? 'Add initials…' : 'Add signature…'}
        </button>
      </div>
    );
  };

  return (
    <div ref={ref} className="sign-menu" role="menu">
      {p.forField && <p className="sign-note">Choose what to put in the signature field.</p>}
      {!p.visualAllowed && <p className="sign-note">This document is signed, so it can only take more digital signatures.</p>}
      {p.visualAllowed && section('signature', 'Signatures')}
      {p.visualAllowed && section('initials', 'Initials')}
      {!p.forField && p.visualAllowed && (
        <button className="sign-row" onClick={p.onDate}>
          <CalendarDays size={15} /> Today's date
        </button>
      )}
      <button className="sign-row" onClick={p.onDigital} disabled={!p.canDigitallySign}>
        <ShieldCheck size={15} /> Sign with a digital ID…
      </button>
    </div>
  );
}
