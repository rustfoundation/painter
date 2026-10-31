import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PATTERN_HINT } from '../match';

export interface Hint {
  value: string;
  note?: string;
}

/** Crate-name hints: partial matches as you type (or the pattern's matches), most relevant first. */
export const crateHints = (q: string): Promise<Hint[]> => api.searchCrates(q, 12).then((names) => names.map((value) => ({ value })));

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Hints for the typed text; always partial, so the user can pick an exact name. */
  hints?: (q: string) => Promise<Hint[]>;
  placeholder?: string;
  className?: string;
}

/**
 * Text filter for the table views. The table matches the typed text exactly (case-insensitive) unless it
 * contains `*` / `?`; the dropdown offers partial matches and picking one sets that exact name.
 */
export function NameFilter({ value, onChange, hints = crateHints, placeholder = `Crate: ${PATTERN_HINT}`, className = 'q' }: Props) {
  const [items, setItems] = useState<Hint[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    const q = value.trim();
    if (!open || !q) {
      setItems([]);
      return;
    }
    let cancelled = false;
    timer.current = window.setTimeout(() => {
      hints(q)
        .then((r) => {
          if (cancelled) return;
          // An exact hit adds nothing to what is already in the box.
          setItems(r.length === 1 && r[0].value.toLowerCase() === q.toLowerCase() ? [] : r);
          setActive(-1);
        })
        .catch(() => !cancelled && setItems([]));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [value, open, hints]);

  const pick = (v: string) => {
    setOpen(false);
    onChange(v);
  };

  return (
    <div className="search name-filter">
      <input
        type="text"
        className={className}
        placeholder={placeholder}
        title={`Exact name (case-insensitive). Use * for any run of characters and ? for one, e.g. tokio* or *-sys.`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Enter') {
            if (active >= 0 && items[active]) pick(items[active].value);
            else setOpen(false);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        spellCheck={false}
      />
      {open && items.length > 0 && (
        <ul className="suggestions">
          {items.map((h, i) => (
            <li key={h.value} className={i === active ? 'active' : ''} onMouseDown={() => pick(h.value)}>
              {h.value}
              {h.note && <span className="muted small"> {h.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
