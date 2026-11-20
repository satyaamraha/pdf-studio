import { useState } from 'react';
import { ChevronDown, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { SignatureInfo } from '../lib/pdfVerify';

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown time';

/** Summary of a signed document's signatures, with details on demand. */
export function SignatureBanner({ signatures, checking }: { signatures: SignatureInfo[] | null; checking: boolean }) {
  const [open, setOpen] = useState(false);
  if (checking && !signatures) {
    return (
      <div className="sig-banner">
        <span className="spinner" /> Checking signatures…
      </div>
    );
  }
  if (!signatures?.length) return null;
  const bad = signatures.some((s) => s.status === 'invalid');
  const unknown = signatures.some((s) => s.status === 'unknown');
  const untrusted = signatures.some((s) => s.selfSigned);
  const tone = bad ? 'bad' : unknown ? 'warn' : 'good';
  const Icon = bad ? ShieldAlert : unknown ? ShieldQuestion : ShieldCheck;
  const names = signatures.map((s) => s.signer).join(', ');
  const summary = bad
    ? 'A signature is not valid: the document was changed after signing.'
    : unknown
      ? `Signed by ${names}. Some signatures couldn’t be checked.`
      : `Signed by ${names}. ${signatures.length > 1 ? 'All signatures are' : 'The signature is'} valid.`;

  return (
    <div className={`sig-banner ${tone}`}>
      <button className="sig-banner-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon size={16} />
        <span>
          {summary}
          {!bad && untrusted && <span className="muted"> Identity not verified by a trusted authority.</span>}
        </span>
        <ChevronDown size={14} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <ul className="sig-details">
          {signatures.map((s, i) => (
            <li key={i} className={s.status}>
              <strong>{s.signer}</strong>
              {s.email && <span className="muted"> · {s.email}</span>}
              <div>
                {s.detail} Signed {when(s.signedAt)}.
              </div>
              <div className="muted">
                {s.selfSigned ? 'Self-signed certificate (not from a trusted authority).' : s.issuer ? `Certificate issued by ${s.issuer}.` : ''}
                {s.reason && ` Reason: ${s.reason}.`}
                {s.location && ` Location: ${s.location}.`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
