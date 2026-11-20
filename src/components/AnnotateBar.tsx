import {
  Circle,
  Highlighter,
  MessageSquare,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  Slash,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { COLORS, hasStrokeWidth, STAMPS, TOOL_LABELS, type Annotation, type Tool } from '../lib/annotations';
import type { ToolStyle } from './AnnotationLayer';

const TOOLS: { tool: Tool; icon: LucideIcon; key?: string }[] = [
  { tool: 'select', icon: MousePointer2, key: 'V' },
  { tool: 'highlight', icon: Highlighter, key: 'H' },
  { tool: 'underline', icon: Underline, key: 'U' },
  { tool: 'strike', icon: Strikethrough, key: 'K' },
  { tool: 'note', icon: StickyNote, key: 'N' },
  { tool: 'ink', icon: Pencil, key: 'D' },
  { tool: 'rect', icon: Square, key: 'R' },
  { tool: 'ellipse', icon: Circle, key: 'O' },
  { tool: 'line', icon: Slash, key: 'L' },
  { tool: 'arrow', icon: MoveUpRight, key: 'A' },
  { tool: 'text', icon: Type, key: 'T' },
  { tool: 'stamp', icon: Stamp, key: 'S' },
];

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  TOOLS.filter((t) => t.key).map((t) => [t.key!.toLowerCase(), t.tool]),
);

const WIDTHS = [1, 2, 3, 5, 8];
const FONT_SIZES = [10, 12, 14, 18, 24, 32];

interface Props {
  tool: Tool;
  style: ToolStyle;
  selected: Annotation | null;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: string | null;
  onTool: (tool: Tool) => void;
  onStyle: (patch: Partial<ToolStyle>) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onComment: () => void;
}

export function AnnotateBar(p: Props) {
  // With an annotation selected, the style controls edit it; otherwise they set up the current tool.
  const subject: Tool = p.selected ? p.selected.kind : p.tool;
  const showWidth = hasStrokeWidth(subject);
  const showFont = subject === 'text';
  const showStamp = subject === 'stamp' && !p.selected;
  const showColor = subject !== 'select';

  return (
    <div className="annotatebar" role="toolbar" aria-label="Annotation tools">
      <div className="tool-group">
        {TOOLS.map(({ tool, icon: Icon, key }) => (
          <button
            key={tool}
            className={`icon-btn${p.tool === tool ? ' on' : ''}`}
            title={`${TOOL_LABELS[tool]}${key ? ` (${key})` : ''}`}
            aria-pressed={p.tool === tool}
            disabled={!!p.readOnly && tool !== 'select'}
            onClick={() => p.onTool(tool)}
          >
            <Icon size={17} />
          </button>
        ))}
      </div>

      {showStamp && (
        <select className="bar-select" aria-label="Stamp" value={p.style.stamp} onChange={(e) => p.onStyle({ stamp: e.target.value })}>
          {STAMPS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}

      {showColor && (
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={p.style.color === c}
              aria-label={c}
              className={`swatch${p.style.color === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => p.onStyle({ color: c })}
            />
          ))}
        </div>
      )}

      {showWidth && (
        <select
          className="bar-select"
          aria-label="Line width"
          value={p.style.width}
          onChange={(e) => p.onStyle({ width: Number(e.target.value) })}
        >
          {WIDTHS.map((w) => (
            <option key={w} value={w}>
              {w} pt
            </option>
          ))}
        </select>
      )}

      {showFont && (
        <select
          className="bar-select"
          aria-label="Font size"
          value={p.style.fontSize}
          onChange={(e) => p.onStyle({ fontSize: Number(e.target.value) })}
        >
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s} pt
            </option>
          ))}
        </select>
      )}

      {p.selected && (
        <div className="tool-group">
          <button className="icon-btn" title="Comment" onClick={p.onComment}>
            <MessageSquare size={17} />
          </button>
          <button className="icon-btn" title="Delete (Delete key)" onClick={p.onDelete}>
            <Trash2 size={17} />
          </button>
        </div>
      )}

      <div className="spacer" />
      {p.readOnly && <span className="bar-note">{p.readOnly}</span>}

      <button className="icon-btn" title="Undo" onClick={p.onUndo} disabled={!p.canUndo}>
        <Undo2 size={17} />
      </button>
      <button className="icon-btn" title="Redo" onClick={p.onRedo} disabled={!p.canRedo}>
        <Redo2 size={17} />
      </button>
    </div>
  );
}
