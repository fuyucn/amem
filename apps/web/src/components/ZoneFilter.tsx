import type { Zone } from '../types';

export function ZoneFilter({
  zones,
  value,
  onChange,
  label = 'zone',
  includeAll = true,
}: {
  zones: Zone[];
  value: string;
  onChange: (zoneId: string) => void;
  label?: string;
  includeAll?: boolean;
}) {
  return (
    <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {label}:
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {includeAll && <option value="">all</option>}
        {zones.map((z) => (
          <option key={z.id} value={z.id}>{z.name || z.slug}</option>
        ))}
      </select>
    </label>
  );
}
