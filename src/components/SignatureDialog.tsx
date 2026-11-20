import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageUp, PenLine, Type } from 'lucide-react';
import { newId } from '../lib/annotations';
import { availableScriptFonts, imageToSignature, trimToPng, type SavedSignature, type SignatureRole } from '../lib/signatures';

type Mode = 'draw' | 'type' | 'image';

const INKS = [
  { color: '#111111', label: 'Black' },
  { color: '#1c3faa', label: 'Blue' },
];

interface Props {
  role: SignatureRole;
  onDone: (sig: SavedSignature, remember: boolean) => void;
  onClose: () => void;
}

/** Makes a signature or initials by drawing, typing or uploading a picture. */
export function SignatureDialog({ role, onDone, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('draw');
  const [ink, setInk] = useState(INKS[0].color);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const noun = role === 'initials' ? 'initials' : 'signature';

  // Draw
  const padRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  // Type
  const fonts = useMemo(() => availableScriptFonts(), []);
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState(fonts[0]);

  // Image
  const [uploaded, setUploaded] = useState<{ src: string; width: number; height: number } | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  useEffect(() => {
    if (!uploadFile) return;
    let cancelled = false;
    void imageToSignature(uploadFile, ink).then((r) => {
      if (cancelled) return;
      if (r) {
        setUploaded(r);
        setError(null);
      } else setError('No signature found in that picture. Try a darker pen on white paper.');
    });
    return () => {
      cancelled = true;
    };
  }, [uploadFile, ink]);

  // Size the drawing pad for the screen's pixel density.
  useEffect(() => {
    const c = padRef.current;
    if (!c || mode !== 'draw') return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    setDrawn(false);
  }, [mode]);

  const onPadDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = padRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    c.setPointerCapture(e.pointerId);
    const dpr = c.width / c.getBoundingClientRect().width;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = c.getBoundingClientRect();
      return [(ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr] as const;
    };
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let [lx, ly] = at(e);
    let lastWidth = 2.6 * dpr;
    ctx.beginPath();
    ctx.arc(lx, ly, lastWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    let lastTime = performance.now();
    const move = (ev: PointerEvent) => {
      const [x, y] = at(ev);
      const now = performance.now();
      // Faster strokes get a little thinner, like a real pen.
      const speed = Math.hypot(x - lx, y - ly) / Math.max(1, now - lastTime);
      const width = Math.max(1.4 * dpr, Math.min(3.6 * dpr, (3.4 - speed * 0.9) * dpr));
      ctx.lineWidth = (lastWidth + width) / 2;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(x, y);
      ctx.stroke();
      [lx, ly, lastWidth, lastTime] = [x, y, width, now];
    };
    const up = () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      setDrawn(true);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  };

  const clearPad = () => {
    const c = padRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };

  const renderTyped = (): { src: string; width: number; height: number } | null => {
    const text = typed.trim();
    if (!text) return null;
    const c = document.createElement('canvas');
    const size = 120;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.font = `${size}px "${font}", cursive`;
    c.width = Math.ceil(ctx.measureText(text).width + size);
    c.height = Math.ceil(size * 1.8);
    ctx.font = `${size}px "${font}", cursive`;
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, c.height / 2);
    return trimToPng(c);
  };

  const ready = mode === 'draw' ? drawn : mode === 'type' ? !!typed.trim() : !!uploaded;

  const done = () => {
    const result = mode === 'draw' ? (padRef.current ? trimToPng(padRef.current) : null) : mode === 'type' ? renderTyped() : uploaded;
    if (!result) {
      setError(`Add your ${noun} first.`);
      return;
    }
    onDone({ id: newId(), role, ...result }, remember);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sig-modal" role="dialog" aria-modal="true" aria-labelledby="sig-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="sig-title">{role === 'initials' ? 'Add your initials' : 'Add your signature'}</h2>
        <div className="segmented sig-tabs" role="tablist">
          {(
            [
              ['draw', PenLine, 'Draw'],
              ['type', Type, 'Type'],
              ['image', ImageUp, 'Upload'],
            ] as const
          ).map(([m, Icon, label]) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {mode === 'draw' && (
          <div className="sig-pad-wrap">
            <canvas ref={padRef} className="sig-pad" onPointerDown={onPadDown} aria-label={`Draw your ${noun} here`} />
            <div className="sig-line" />
            {!drawn && <span className="sig-hint">Draw your {noun} with a mouse, trackpad, pen or finger</span>}
            {drawn && (
              <button className="plain-btn small sig-clear" onClick={clearPad}>
                Clear
              </button>
            )}
          </div>
        )}

        {mode === 'type' && (
          <div className="sig-type">
            <input
              autoFocus
              placeholder={role === 'initials' ? 'Your initials' : 'Your full name'}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <div className="sig-fonts" role="radiogroup" aria-label="Style">
              {fonts.map((f) => (
                <button
                  key={f}
                  role="radio"
                  aria-checked={font === f}
                  className={`sig-font${font === f ? ' on' : ''}`}
                  style={{ fontFamily: `"${f}", cursive`, color: ink }}
                  onClick={() => setFont(f)}
                >
                  {typed.trim() || (role === 'initials' ? 'AB' : 'Your Name')}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === 'image' && (
          <div className="sig-upload">
            <label className="secondary sig-file">
              <ImageUp size={16} /> Choose a picture…
              <input type="file" accept="image/*" hidden onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
            </label>
            <p className="muted">A photo or scan of your {noun} on white paper. The paper is removed automatically.</p>
            {uploaded && <img className="sig-preview" src={uploaded.src} alt={`Your ${noun}`} />}
          </div>
        )}

        <div className="sig-options">
          <div className="swatches" role="radiogroup" aria-label="Ink colour">
            {INKS.map((i) => (
              <button
                key={i.color}
                role="radio"
                aria-checked={ink === i.color}
                aria-label={i.label}
                className={`swatch${ink === i.color ? ' on' : ''}`}
                style={{ background: i.color }}
                onClick={() => setInk(i.color)}
              />
            ))}
          </div>
          <label className="bar-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Save for next time (on this device)
          </label>
        </div>
        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={done}>
            Use {noun}
          </button>
        </div>
      </div>
    </div>
  );
}
