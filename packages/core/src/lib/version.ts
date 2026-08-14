import { readFileSync } from 'node:fs';

const FALLBACK_VERSION = '0.0.0-dev';

function resolveAppVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // package.json not resolvable (bundled context) — keep the dev fallback.
  }
  return FALLBACK_VERSION;
}

export const appVersion: string = resolveAppVersion();
