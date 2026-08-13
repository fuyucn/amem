/** Wrap matched terms in <mark>. Falls back to plain text when no terms are provided. */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})`,
    'gi',
  );
  // split() with one capture group inserts matched terms at odd indices.
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}
