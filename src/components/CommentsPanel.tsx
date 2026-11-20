import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { annotBox, describe, TOOL_LABELS, type Annotation } from '../lib/annotations';
import { scrollIntoContainer } from '../lib/scroll';

interface Props {
  items: Annotation[];
  selectedId: string | null;
  author: string;
  onAuthor: (name: string) => void;
  onFocus: (a: Annotation) => void;
  onComment: (a: Annotation, final: boolean) => void;
  onDelete: (id: string) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Every annotation in reading order, with its comment editable in place. */
export function CommentsPanel({ items, selectedId, author, onAuthor, onFocus, onComment, onDelete }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.page - b.page || annotBox(b).y2 - annotBox(a).y2),
    [items],
  );

  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector(`[data-card="${selectedId}"]`);
    if (list && el) scrollIntoContainer(el, list, 'nearest');
  }, [selectedId]);

  return (
    <div className="comments">
      <label className="author-field">
        <span>Your name</span>
        <input value={author} placeholder="Shown on your annotations" onChange={(e) => onAuthor(e.target.value)} />
      </label>
      {sorted.length === 0 ? (
        <p className="sidebar-empty">No annotations yet. Turn on Annotate in the toolbar to add some.</p>
      ) : (
        <div className="comment-list" ref={listRef}>
          {sorted.map((a) => (
            <CommentCard
              key={a.id}
              a={a}
              selected={a.id === selectedId}
              onFocus={onFocus}
              onComment={onComment}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CommentCard({
  a,
  selected,
  onFocus,
  onComment,
  onDelete,
}: {
  a: Annotation;
  selected: boolean;
  onFocus: (a: Annotation) => void;
  onComment: (a: Annotation, final: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const latest = useRef(a);
  latest.current = a;
  const quote = describe(a);

  return (
    <div
      className={`comment-card${selected ? ' selected' : ''}`}
      data-card={a.id}
      onClick={() => onFocus(a)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onFocus(a)}
    >
      <div className="comment-head">
        <span className="dot" style={{ background: a.color }} />
        <span className="comment-kind">{TOOL_LABELS[a.kind]}</span>
        <span className="comment-meta">
          p. {a.page + 1} · {formatDate(a.modified)}
        </span>
        <button
          className="icon-btn small"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(a.id);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {quote && <p className="comment-quote">{quote}</p>}
      {editing || (selected && !a.comment) ? (
        <textarea
          className="comment-input"
          value={a.comment}
          placeholder="Add a comment…"
          rows={2}
          autoFocus={editing}
          onClick={(e) => e.stopPropagation()}
          onFocus={() => setEditing(true)}
          onChange={(e) => onComment({ ...a, comment: e.target.value, modified: new Date().toISOString() }, false)}
          onBlur={() => {
            setEditing(false);
            onComment(latest.current, true);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) (e.target as HTMLElement).blur();
          }}
        />
      ) : a.comment ? (
        <p
          className="comment-text"
          onClick={(e) => {
            e.stopPropagation();
            onFocus(a);
            setEditing(true);
          }}
        >
          {a.comment}
        </p>
      ) : null}
      {a.author && <div className="comment-author">{a.author}</div>}
    </div>
  );
}
