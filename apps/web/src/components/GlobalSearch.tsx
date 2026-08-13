import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Highlight } from './Highlight';
import type { SearchResult } from '../types';

const QUICK_LIMIT = 6;

/**
 * Sidebar keyword search: debounced results dropdown while typing, Enter jumps
 * to the full Search page, clicking a result opens the unit directly.
 */
export function GlobalSearch({
  onOpenUnit,
  onOpenSearch,
}: {
  onOpenUnit: (id: string) => void;
  onOpenSearch: (query: string) => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const term = q.trim();
      if (!term) {
        setRes(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      api
        .search(term, { limit: QUICK_LIMIT })
        .then((r) => setRes(r))
        .catch(() => setRes(null))
        .finally(() => setLoading(false));
    }, 220);
    return () => window.clearTimeout(t);
  }, [q]);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setOpen(false);
    onOpenSearch(term);
  };

  const pick = (id: string) => {
    setOpen(false);
    onOpenUnit(id);
  };

  return (
    <div className="global-search" ref={boxRef}>
      <form onSubmit={submit} role="search">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search memories…"
          aria-label="Keyword search"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        {loading && <span className="gs-spinner" aria-hidden />}
      </form>
      {open && q.trim() && res && (
        <div className="gs-pop">
          {res.items.length === 0 ? (
            <div className="gs-empty">No matches</div>
          ) : (
            <>
              {res.items.map((it) => (
                <button key={it.unit.id} className="gs-item" onClick={() => pick(it.unit.id)}>
                  <span className="gs-item-title">
                    <Highlight text={it.unit.title} terms={it.terms} />
                  </span>
                  <span className="gs-item-meta">
                    {it.unit.category || 'unclassified'}
                    {it.unit.type ? ` · ${it.unit.type}` : ''}
                    {it.unit.tags.length ? ` · ${it.unit.tags.slice(0, 2).join(', ')}` : ''}
                  </span>
                  {it.unit.summary ? (
                    <span className="gs-item-sum">
                      <Highlight text={it.unit.summary} terms={it.terms} />
                    </span>
                  ) : null}
                </button>
              ))}
              <button className="gs-more" onClick={submit as unknown as React.MouseEventHandler}>
                {res.total > res.items.length
                  ? `View all ${res.total} results →`
                  : `Search “${q.trim()}” →`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
