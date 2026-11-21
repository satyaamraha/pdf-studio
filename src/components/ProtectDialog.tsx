import { useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import type { Permissions, Security } from '../lib/pdfSecurity';

interface Props {
  /** Current protection (null = none). */
  security: Security | null;
  /** The file restricts changes and the owner password hasn't been given yet. */
  locked: boolean;
  /** Why the dialog opened, if not by choice (e.g. saving needs a password). */
  note?: string;
  onUnlock: (ownerPassword: string) => Promise<boolean>;
  onApply: (security: Security | null) => void;
  onClose: () => void;
}

const PERMS: { key: keyof Permissions | 'edit' | 'comment'; label: string }[] = [
  { key: 'print', label: 'Print' },
  { key: 'copy', label: 'Copy text and images' },
  { key: 'edit', label: 'Change the document and its pages' },
  { key: 'comment', label: 'Add comments and fill in forms' },
];

/** Add, change or remove password protection; or unlock a restricted document. */
export function ProtectDialog({ security, locked, note, onUnlock, onApply, onClose }: Props) {
  const [needOpen, setNeedOpen] = useState(!!security?.openPassword || security?.openPassword === null);
  const [openPw, setOpenPw] = useState(security?.openPassword ?? '');
  const [openPw2, setOpenPw2] = useState(security?.openPassword ?? '');
  const restricted = security ? Object.values(security.permissions).some((v) => !v) : false;
  const [restrict, setRestrict] = useState(restricted);
  const [ownerPw, setOwnerPw] = useState(security?.ownerPassword ?? '');
  const [ownerPw2, setOwnerPw2] = useState(security?.ownerPassword ?? '');
  const p = security?.permissions;
  const [allow, setAllow] = useState({
    print: p ? p.print : true,
    copy: p ? p.copy : true,
    edit: p ? p.modify && p.assemble : false,
    comment: p ? p.annotate && p.fillForms : true,
  });
  const [unlockPw, setUnlockPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    const ok = await onUnlock(unlockPw).catch(() => false);
    setBusy(false);
    if (!ok) setError("That isn't the owner password.");
  };

  const apply = () => {
    setError(null);
    if (!needOpen && !restrict) return setError('Choose at least one kind of protection, or remove protection.');
    if (needOpen && openPw.length < 4) return setError('Use an open password of at least 4 characters.');
    if (needOpen && openPw !== openPw2) return setError("The open passwords don't match.");
    if (restrict && ownerPw.length < 4) return setError('Use a permissions password of at least 4 characters.');
    if (restrict && ownerPw !== ownerPw2) return setError("The permissions passwords don't match.");
    if (needOpen && restrict && ownerPw === openPw) return setError('Use a different password for permissions, or anyone who can open the file could change them.');
    onApply({
      openPassword: needOpen ? openPw : '',
      ownerPassword: restrict ? ownerPw : null,
      permissions: restrict
        ? { print: allow.print, printHigh: allow.print, copy: allow.copy, modify: allow.edit, assemble: allow.edit, annotate: allow.comment, fillForms: allow.comment }
        : { print: true, printHigh: true, copy: true, modify: true, assemble: true, annotate: true, fillForms: true },
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal protect-modal" role="dialog" aria-modal="true" aria-labelledby="protect-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-icon">{locked ? <LockOpen size={20} /> : <Lock size={20} />}</div>
        <h2 id="protect-title">{locked ? 'Unlock this document' : 'Password protection'}</h2>
        {note && <p className="note-box">{note}</p>}

        {locked ? (
          <>
            <p>The author restricted changes to this document. Enter the permissions (owner) password to edit it.</p>
            <div className="dsig-form">
              <label>
                <span>Permissions password</span>
                <input type="password" autoFocus autoComplete="off" value={unlockPw} onChange={(e) => setUnlockPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void unlock()} />
              </label>
            </div>
          </>
        ) : (
          <div className="dsig-form">
            <label className="bar-check">
              <input type="checkbox" checked={needOpen} onChange={(e) => setNeedOpen(e.target.checked)} />
              Require a password to open the document
            </label>
            {needOpen && (
              <div className="pw-pair">
                <input type="password" placeholder="Open password" autoComplete="new-password" value={openPw} onChange={(e) => setOpenPw(e.target.value)} />
                <input type="password" placeholder="Again" autoComplete="new-password" value={openPw2} onChange={(e) => setOpenPw2(e.target.value)} />
              </div>
            )}
            <label className="bar-check">
              <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
              Restrict printing, copying and changes
            </label>
            {restrict && (
              <>
                <div className="pw-pair">
                  <input type="password" placeholder="Permissions password" autoComplete="new-password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} />
                  <input type="password" placeholder="Again" autoComplete="new-password" value={ownerPw2} onChange={(e) => setOwnerPw2(e.target.value)} />
                </div>
                <div className="perm-list">
                  <span className="muted">People without this password can:</span>
                  {PERMS.map((perm) => (
                    <label key={perm.key} className="bar-check">
                      <input
                        type="checkbox"
                        checked={allow[perm.key as keyof typeof allow]}
                        onChange={(e) => setAllow({ ...allow, [perm.key]: e.target.checked })}
                      />
                      {perm.label}
                    </label>
                  ))}
                </div>
              </>
            )}
            <p className="muted small-print">
              Files are protected with AES-256. Write the passwords down: there’s no way to recover a lost open password.
              Some apps ignore permission restrictions, so don’t rely on them for secrets; use an open password instead.
            </p>
          </div>
        )}

        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          {!locked && security && (
            <button className="danger" onClick={() => onApply(null)}>
              Remove protection
            </button>
          )}
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {locked ? (
            <button className="primary" onClick={() => void unlock()} disabled={!unlockPw || busy}>
              Unlock
            </button>
          ) : (
            <button className="primary" onClick={apply}>
              Apply
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
