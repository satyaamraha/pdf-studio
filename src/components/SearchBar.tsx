import { useEffect, useRef } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react';

interface Props {
  query: string;
  matchCase: boolean;
  total: number;
  active: number;
  searching: boolean;
  focusNonce: number;
  onQuery: (q: string) => void;
  onMatchCase: (v: boolean) => void;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}

export function SearchBar(p: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [p.focusNonce]);

  let status = '';
  if (p.query.trim()) {
    if (p.total) status = `${p.active + 1} of ${p.total}${p.searching ? '+' : ''}`;
    else status = p.searching ? 'Searching…' : 'No results';
  }

  return (
    <div className="searchbar" role="search">
      <input
        ref={inputRef}
        type="search"
        placeholder="Find in document"
        value={p.query}
        aria-label="Find in document"
        onChange={(e) => p.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            p.onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            p.onClose();
          }
        }}
      />
      <span className="search-status" aria-live="polite">
        {status}
      </span>
      <button
        className={`icon-btn small${p.matchCase ? ' on' : ''}`}
        onClick={() => p.onMatchCase(!p.matchCase)}
        title="Match case"
        aria-pressed={p.matchCase}
      >
        <CaseSensitive size={16} />
      </button>
      <button className="icon-btn small" onClick={() => p.onStep(-1)} disabled={!p.total} title="Previous (Shift+Enter)">
        <ChevronUp size={16} />
      </button>
      <button className="icon-btn small" onClick={() => p.onStep(1)} disabled={!p.total} title="Next (Enter)">
        <ChevronDown size={16} />
      </button>
      <button className="icon-btn small" onClick={p.onClose} title="Close (Esc)">
        <X size={16} />
      </button>
    </div>
  );
}
