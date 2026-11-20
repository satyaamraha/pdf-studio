import { useState } from 'react';
import { Download, KeyRound, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { createSelfSignedId, importP12, loadIds, p12Bytes, storeIds, unlockP12, type DigitalId, type UnlockedId } from '../lib/digitalId';
import { downloadFile } from '../lib/platform';
import type { SavedSignature } from '../lib/signatures';

export interface DigitalSignPlan {
  id: DigitalId;
  unlocked: UnlockedId;
  reason: string;
  location: string;
  /** Show the signature on the page (otherwise it's invisible but still in the file). */
  visible: boolean;
  /** Handwritten signature to show in the box. */
  picture: SavedSignature | null;
}

interface Props {
  signatures: SavedSignature[];
  /** Signing into an existing "Sign here" field. */
  forField: boolean;
  onReady: (plan: DigitalSignPlan) => void;
  onClose: () => void;
}

type View = 'list' | 'create' | 'import';

const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Choose, import or create a digital ID, then unlock it to sign. */
export function DigitalSignDialog({ signatures, forField, onReady, onClose }: Props) {
  const [ids, setIds] = useState<DigitalId[]>(loadIds);
  const [view, setView] = useState<View>(ids.length ? 'list' : 'create');
  const [selected, setSelected] = useState<string | null>(ids[0]?.id ?? null);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [visible, setVisible] = useState(true);
  const handwritten = signatures.filter((s) => s.role === 'signature');
  const [pictureId, setPictureId] = useState<string>(handwritten[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Create
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');

  // Import
  const [file, setFile] = useState<File | null>(null);
  const [importPw, setImportPw] = useState('');

  const keep = (id: DigitalId) => {
    const next = [id, ...ids.filter((x) => x.id !== id.id)];
    if (!storeIds(next)) {
      setError("Couldn't keep the ID on this device (storage is full or blocked).");
      return false;
    }
    setIds(next);
    setSelected(id.id);
    setView('list');
    return true;
  };

  const create = async () => {
    setError(null);
    if (!name.trim()) return setError('Enter your name.');
    if (pw1.length < 6) return setError('Use a password of at least 6 characters.');
    if (pw1 !== pw2) return setError("The passwords don't match.");
    setBusy('Creating your digital ID…');
    try {
      const id = await createSelfSignedId({ name: name.trim(), email: email.trim(), organization: org.trim(), password: pw1, years: 5 });
      if (keep(id)) setPassword(pw1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    setError(null);
    if (!file) return setError('Choose a .p12 or .pfx file.');
    setBusy('Opening the digital ID…');
    try {
      const id = importP12(new Uint8Array(await file.arrayBuffer()), importPw);
      if (keep(id)) setPassword(importPw);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = (id: DigitalId) => {
    const next = ids.filter((x) => x.id !== id.id);
    storeIds(next);
    setIds(next);
    if (selected === id.id) setSelected(next[0]?.id ?? null);
  };

  const sign = () => {
    setError(null);
    const id = ids.find((x) => x.id === selected);
    if (!id) return setError('Choose a digital ID.');
    if (new Date(id.notAfter) < new Date()) return setError('This digital ID has expired.');
    try {
      const unlocked = unlockP12(id.p12, password);
      onReady({ id, unlocked, reason: reason.trim(), location: location.trim(), visible: forField || visible, picture: handwritten.find((s) => s.id === pictureId) ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const chosen = ids.find((x) => x.id === selected);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal dsig-modal" role="dialog" aria-modal="true" aria-labelledby="dsig-title" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-icon">
          <ShieldCheck size={20} />
        </div>
        <h2 id="dsig-title">Sign with a digital ID</h2>

        {view === 'list' && (
          <>
            <p>A digital signature proves who signed and shows if the document is changed afterwards.</p>
            <div className="id-list" role="radiogroup" aria-label="Digital ID">
              {ids.map((id) => (
                <label key={id.id} className={`id-card${selected === id.id ? ' on' : ''}`}>
                  <input type="radio" name="digital-id" checked={selected === id.id} onChange={() => setSelected(id.id)} />
                  <span className="id-main">
                    <strong>{id.name}</strong>
                    {id.email && <span className="muted"> · {id.email}</span>}
                    <span className="id-sub">
                      {id.selfSigned ? 'Self-signed' : `Issued by ${id.issuer}`} · valid until {fmt(id.notAfter)}
                    </span>
                  </span>
                  <button type="button" className="icon-btn small" title="Download a backup (.p12)" onClick={() => downloadFile(p12Bytes(id), `${id.name}.p12`)}>
                    <Download size={14} />
                  </button>
                  <button type="button" className="icon-btn small" title="Remove from this device" onClick={() => remove(id)}>
                    <Trash2 size={14} />
                  </button>
                </label>
              ))}
            </div>
            <div className="id-actions">
              <button className="plain-btn small" onClick={() => setView('import')}>
                <Upload size={13} /> Import .p12 / .pfx
              </button>
              <button className="plain-btn small" onClick={() => setView('create')}>
                <Plus size={13} /> Create a new ID
              </button>
            </div>
            {chosen && (
              <div className="dsig-form">
                <label>
                  <span>Password for this ID</span>
                  <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sign()} />
                </label>
                <label>
                  <span>Reason (optional)</span>
                  <input value={reason} placeholder="e.g. I approve this document" onChange={(e) => setReason(e.target.value)} />
                </label>
                <label>
                  <span>Location (optional)</span>
                  <input value={location} onChange={(e) => setLocation(e.target.value)} />
                </label>
                {!forField && (
                  <label className="bar-check">
                    <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
                    Show the signature on the page
                  </label>
                )}
                {(forField || visible) && handwritten.length > 0 && (
                  <label>
                    <span>Handwritten signature</span>
                    <select className="bar-select" value={pictureId} onChange={(e) => setPictureId(e.target.value)}>
                      <option value="">None, text only</option>
                      {handwritten.map((s, i) => (
                        <option key={s.id} value={s.id}>
                          Saved signature {i + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </>
        )}

        {view === 'create' && (
          <>
            <p>
              Creates a self-signed ID on this device. It proves the document wasn’t changed after you signed, but other people’s apps
              will show it as “not from a trusted authority”. For legally recognised signatures, import an ID from a certificate provider.
            </p>
            <div className="dsig-form">
              <label>
                <span>Your name</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                <span>Email (optional)</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label>
                <span>Organisation (optional)</span>
                <input value={org} onChange={(e) => setOrg(e.target.value)} />
              </label>
              <label>
                <span>Password</span>
                <input type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
              </label>
              <label>
                <span>Password again</span>
                <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
              </label>
              <p className="muted small-print">The password protects the ID; it’s never saved. If you forget it, the ID can’t be used.</p>
            </div>
          </>
        )}

        {view === 'import' && (
          <>
            <p>Use a digital ID file (.p12 or .pfx) from a certificate provider, your organisation, or another app.</p>
            <div className="dsig-form">
              <label className="secondary sig-file">
                <KeyRound size={16} /> {file ? file.name : 'Choose a .p12 or .pfx file…'}
                <input type="file" accept=".p12,.pfx,application/x-pkcs12" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              <label>
                <span>Password for the file</span>
                <input type="password" autoComplete="off" value={importPw} onChange={(e) => setImportPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doImport()} />
              </label>
            </div>
          </>
        )}

        {busy && (
          <p className="working">
            <span className="spinner" /> {busy}
          </p>
        )}
        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          {view !== 'list' && ids.length > 0 ? (
            <button onClick={() => setView('list')} disabled={!!busy}>
              Back
            </button>
          ) : (
            <button onClick={onClose} disabled={!!busy}>
              Cancel
            </button>
          )}
          {view === 'list' && (
            <button className="primary" onClick={sign} disabled={!chosen || !password}>
              {forField || !visible ? 'Sign and save…' : 'Choose where to sign'}
            </button>
          )}
          {view === 'create' && (
            <button className="primary" onClick={() => void create()} disabled={!!busy}>
              Create ID
            </button>
          )}
          {view === 'import' && (
            <button className="primary" onClick={() => void doImport()} disabled={!!busy}>
              Import
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
