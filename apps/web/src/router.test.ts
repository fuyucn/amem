import { describe, expect, it } from 'vitest';
import { canonicalPath, DEFAULT_TAB, parsePath, tabPath, unitPath } from './router';

describe('parsePath', () => {
  it('maps the root path to the default tab', () => {
    expect(parsePath('/')).toEqual({ tab: DEFAULT_TAB });
    expect(parsePath('/')).toEqual({ tab: 'activity' });
  });

  it('maps every known tab path', () => {
    const paths: Array<[string, string]> = [
      ['/dashboard', 'dashboard'],
      ['/activity', 'activity'],
      ['/graph', 'graph'],
      ['/search', 'search'],
      ['/units', 'units'],
      ['/traces', 'traces'],
      ['/scenarios', 'scenarios'],
      ['/assets', 'assets'],
      ['/persona', 'persona'],
      ['/working-memory', 'working-memory'],
      ['/review', 'review'],
      ['/setup', 'setup'],
      ['/settings', 'settings'],
    ];
    for (const [path, tab] of paths) {
      expect(parsePath(path)).toEqual({ tab });
    }
  });

  it('strips trailing slashes', () => {
    expect(parsePath('/graph/')).toEqual({ tab: 'graph' });
  });

  it('parses unit detail routes', () => {
    expect(parsePath('/units/abc-123')).toEqual({ tab: 'units', unitId: 'abc-123' });
    expect(parsePath('/units/a%20b')).toEqual({ tab: 'units', unitId: 'a b' });
  });

  it('falls back to the default tab for unknown paths', () => {
    expect(parsePath('/nope')).toEqual({ tab: DEFAULT_TAB });
    expect(parsePath('')).toEqual({ tab: DEFAULT_TAB });
  });
});

describe('unitPath / tabPath', () => {
  it('round-trips unit ids through encode/decode', () => {
    const id = 'unit with spaces/and#symbols';
    expect(parsePath(unitPath(id)).unitId).toBe(id);
  });

  it('exposes stable tab paths', () => {
    expect(tabPath('graph')).toBe('/graph');
    expect(tabPath('settings')).toBe('/settings');
  });

  it('canonicalPath maps tab routes and unit routes', () => {
    expect(canonicalPath({ tab: 'activity' })).toBe('/activity');
    expect(canonicalPath({ tab: 'graph' })).toBe('/graph');
    expect(canonicalPath({ tab: 'units', unitId: 'unit_abc' })).toBe('/units/unit_abc');
  });
});
