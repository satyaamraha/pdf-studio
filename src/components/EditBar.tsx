import { Eraser, ImagePlus, Images, SquareDashedMousePointer, TextCursor, TextSelect, Undo2, Redo2 } from 'lucide-react';
import type { EditTool } from './EditLayer';

const TOOLS: { tool: EditTool; icon: typeof Eraser; label: string; tip: string }[] = [
  { tool: 'text', icon: TextCursor, label: 'Text', tip: 'Edit text: click a line to change it' },
  { tool: 'image', icon: Images, label: 'Images', tip: 'Move, resize or delete pictures' },
  { tool: 'add-image', icon: ImagePlus, label: 'Add image', tip: 'Add a picture to the page' },
];
const REDACT: { tool: EditTool; icon: typeof Eraser; label: string; tip: string }[] = [
  { tool: 'redact-text', icon: TextSelect, label: 'Redact text', tip: 'Select text to remove for good' },
  { tool: 'redact-area', icon: SquareDashedMousePointer, label: 'Redact area', tip: 'Drag over anything to remove it for good' },
];

interface Props {
  tool: EditTool | null;
  marks: number;
  scrub: boolean;
  busy: string | null;
  canUndo: boolean;
  canRedo: boolean;
  hasPicture: boolean;
  onTool: (tool: EditTool) => void;
  onScrub: (on: boolean) => void;
  onApply: () => void;
  onClearMarks: () => void;
  onChoosePicture: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

/** Tools for changing the page itself, and for redaction. */
export function EditBar(p: Props) {
  const redacting = p.tool === 'redact-area' || p.tool === 'redact-text';
  const button = ({ tool, icon: Icon, label, tip }: (typeof TOOLS)[number]) => (
    <button key={tool} className={`icon-btn wide${p.tool === tool ? ' on' : ''}`} title={tip} aria-pressed={p.tool === tool} onClick={() => p.onTool(tool)} disabled={!!p.busy}>
      <Icon size={17} /> <span>{label}</span>
    </button>
  );
  return (
    <div className="editbar" role="toolbar" aria-label="Edit page content">
      <div className="tool-group">{TOOLS.map(button)}</div>
      <div className="tool-group">{REDACT.map(button)}</div>

      {p.tool === 'add-image' && (
        <button className="plain-btn small" onClick={p.onChoosePicture} disabled={!!p.busy}>
          {p.hasPicture ? 'Choose another picture…' : 'Choose a picture…'}
        </button>
      )}
      {p.tool === 'add-image' && p.hasPicture && <span className="bar-note">Click or drag on the page to place it.</span>}
      {p.tool === 'text' && <span className="bar-note">Click a line of text to change it. Enter saves, Esc cancels.</span>}
      {p.tool === 'image' && <span className="bar-note">Select a picture to move or resize it; Delete removes it.</span>}

      {(redacting || p.marks > 0) && (
        <div className="redact-controls">
          <span className="bar-note">
            {p.marks ? `${p.marks} area${p.marks === 1 ? '' : 's'} marked` : p.tool === 'redact-text' ? 'Select text to mark it.' : 'Drag over what to remove.'}
          </span>
          {p.marks > 0 && (
            <>
              <label className="bar-check" title="Title, author and other details stored in the file">
                <input type="checkbox" checked={p.scrub} onChange={(e) => p.onScrub(e.target.checked)} />
                Also remove document info
              </label>
              <button className="plain-btn small" onClick={p.onClearMarks} disabled={!!p.busy}>
                Clear marks
              </button>
              <button className="primary small danger-fill" onClick={p.onApply} disabled={!!p.busy}>
                <Eraser size={14} /> Apply redactions
              </button>
            </>
          )}
        </div>
      )}

      <div className="spacer" />
      {p.busy && (
        <span className="bar-note working-note">
          <span className="spinner" /> {p.busy}
        </span>
      )}
      <button className="icon-btn" title="Undo" onClick={p.onUndo} disabled={!p.canUndo || !!p.busy}>
        <Undo2 size={17} />
      </button>
      <button className="icon-btn" title="Redo" onClick={p.onRedo} disabled={!p.canRedo || !!p.busy}>
        <Redo2 size={17} />
      </button>
    </div>
  );
}
