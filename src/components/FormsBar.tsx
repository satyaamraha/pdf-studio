import { useEffect, useState } from 'react';
import { CircleDot, Eraser, Highlighter, ListChecks, MousePointer2, SquareCheck, TextCursorInput, Trash2, type LucideIcon } from 'lucide-react';
import { FIELD_LABELS, type FieldDef, type FieldKind } from '../lib/forms';

const TOOLS: { tool: 'select' | FieldKind; icon: LucideIcon; label: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Select and move fields' },
  { tool: 'text', icon: TextCursorInput, label: FIELD_LABELS.text },
  { tool: 'checkbox', icon: SquareCheck, label: FIELD_LABELS.checkbox },
  { tool: 'radio', icon: CircleDot, label: `${FIELD_LABELS.radio} (adds to the selected group)` },
  { tool: 'dropdown', icon: ListChecks, label: FIELD_LABELS.dropdown },
];

const FONT_SIZES = [0, 8, 9, 10, 11, 12, 14, 16, 18, 24];

interface Props {
  tool: 'select' | FieldKind;
  selected: FieldDef | null;
  highlight: boolean;
  readOnly: string | null;
  /** Names already used by other fields, to warn about clashes. */
  takenNames: Set<string>;
  onTool: (tool: 'select' | FieldKind) => void;
  onHighlight: (on: boolean) => void;
  onClear: () => void;
  onChange: (def: FieldDef) => void;
  onDelete: () => void;
}

/** Placing new fields and editing the settings of the selected one. */
export function FormsBar(p: Props) {
  return (
    <div className="formsbar" role="toolbar" aria-label="Form tools">
      <div className="tool-group">
        {TOOLS.map(({ tool, icon: Icon, label }) => (
          <button
            key={tool}
            className={`icon-btn${p.tool === tool ? ' on' : ''}`}
            title={label}
            aria-pressed={p.tool === tool}
            disabled={!!p.readOnly && tool !== 'select'}
            onClick={() => p.onTool(tool)}
          >
            <Icon size={17} />
          </button>
        ))}
      </div>

      {p.selected ? (
        <FieldSettings def={p.selected} takenNames={p.takenNames} onChange={p.onChange} onDelete={p.onDelete} />
      ) : (
        <span className="bar-note">
          {p.tool === 'select' ? 'Choose a field type, then click or drag on the page.' : `Click or drag on the page to add a ${FIELD_LABELS[p.tool].toLowerCase()}.`}
        </span>
      )}

      <div className="spacer" />
      <button className={`icon-btn${p.highlight ? ' on' : ''}`} title="Highlight fields" aria-pressed={p.highlight} onClick={() => p.onHighlight(!p.highlight)}>
        <Highlighter size={17} />
      </button>
      <button className="icon-btn" title="Clear all values" onClick={p.onClear}>
        <Eraser size={17} />
      </button>
    </div>
  );
}

function FieldSettings({
  def,
  takenNames,
  onChange,
  onDelete,
}: {
  def: FieldDef;
  takenNames: Set<string>;
  onChange: (def: FieldDef) => void;
  onDelete: () => void;
}) {
  // Text inputs edit locally and apply when you leave them, so each edit is one undo step.
  const [name, setName] = useState(def.name);
  const [options, setOptions] = useState((def.options ?? []).join('\n'));
  const [radioValue, setRadioValue] = useState(def.radioValue ?? '');
  useEffect(() => {
    setName(def.name);
    setOptions((def.options ?? []).join('\n'));
    setRadioValue(def.radioValue ?? '');
  }, [def]);

  const clash = name.trim() !== def.name && takenNames.has(name.trim());
  const applyName = () => {
    const n = name.trim();
    if (!n || clash) setName(def.name);
    else if (n !== def.name) onChange({ ...def, name: n });
  };

  return (
    <div className="field-settings">
      <span className="field-kind">{FIELD_LABELS[def.kind]}</span>
      <label className={`bar-field${clash ? ' invalid' : ''}`} title={clash ? 'Another field already uses this name' : 'Field name'}>
        <span>{def.kind === 'radio' ? 'Group' : 'Name'}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={applyName} onKeyDown={(e) => e.key === 'Enter' && applyName()} />
      </label>
      {def.kind === 'radio' && (
        <label className="bar-field" title="The value this button gives the group">
          <span>Value</span>
          <input
            value={radioValue}
            onChange={(e) => setRadioValue(e.target.value)}
            onBlur={() => radioValue.trim() && radioValue !== def.radioValue && onChange({ ...def, radioValue: radioValue.trim() })}
          />
        </label>
      )}
      {def.kind === 'dropdown' && (
        <label className="bar-field" title="One choice per line">
          <span>Choices</span>
          <textarea
            rows={1}
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            onBlur={() => {
              const list = options.split('\n').map((o) => o.trim()).filter(Boolean);
              if (list.join('\n') !== (def.options ?? []).join('\n')) onChange({ ...def, options: list });
            }}
          />
        </label>
      )}
      {(def.kind === 'text' || def.kind === 'dropdown') && (
        <select className="bar-select" aria-label="Font size" value={def.fontSize ?? 0} onChange={(e) => onChange({ ...def, fontSize: Number(e.target.value) })}>
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'Auto size' : `${s} pt`}
            </option>
          ))}
        </select>
      )}
      {def.kind === 'text' && (
        <label className="bar-check">
          <input type="checkbox" checked={!!def.multiline} onChange={(e) => onChange({ ...def, multiline: e.target.checked })} />
          Multi-line
        </label>
      )}
      <label className="bar-check">
        <input type="checkbox" checked={def.required} onChange={(e) => onChange({ ...def, required: e.target.checked })} />
        Required
      </label>
      <button className="icon-btn" title="Delete field (Delete key)" onClick={onDelete}>
        <Trash2 size={17} />
      </button>
    </div>
  );
}
