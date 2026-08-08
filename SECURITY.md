# Security

Amem is a self-hosted, local-first memory layer. This document describes the
security model, how to report vulnerabilities, and how to harden a deployment.

## Threat model

Amem stores personal and team knowledge. The main risks, in order:

1. **Unauthorized writes** — someone (or a compromised agent/tool) writes
   garbage or misleading knowledge into your memory.
2. **Unauthorized reads** — someone reads knowledge they should not see.
3. **Token/session theft** — a PAT, access token, or session cookie leaks and
   is replayed.
4. **Supply-chain / dependency risk** — a compromised dependency in the
   container image or pnpm tree.
5. **Data loss** — accidental deletion, corruption, or lost backups.

Amem's design answers these with: scope-checked auth on every request
(server-side, before any storage access), workspace isolation enforced at the
storage layer, signed tokens with rotation + reuse detection, rate-limited
auth endpoints, a slim non-root container, and a single-file SQLite store that
is trivial to back up.

## Reporting a vulnerability

Please **do not open a public issue** for security bugs. Report privately:

- Open a **private advisory** via
  [GitHub Security Advisories](https://github.com/fuyucn/amem/security/advisories/new).

We aim to acknowledge within **48 hours** and to ship a fix (or a mitigation
plan) within **14 days** for critical issues.

## Hardening checklist

For anything beyond a single-user laptop install:

- [ ] **Enable auth**: `AMEM_AUTH_ENABLED=true`, set a strong
      `AMEM_AUTH_SECRET` and `AMEM_BOOTSTRAP_ADMIN_PASSWORD`, then mint
      scoped PATs instead of the bootstrap password.
- [ ] **Bind to localhost** unless a reverse proxy is in front:
      `AMEM_HOST=127.0.0.1`. For LAN/Internet exposure, put Amem behind a
      TLS-terminating reverse proxy and set `AMEM_TRUST_PROXY=true` +
      `AMEM_COOKIE_SECURE=true`.
- [ ] **Scope every token**: agents get `read` / `ws:<slug>:read` only unless
      they need writes. Use one PAT per tool/project so a leak is contained.
- [ ] **Keep `AMEM_MCP_OAUTH=1`** so MCP-over-HTTP requires OAuth/PAT.
- [ ] **Set short TTLs**: `AMEM_PAT_DEFAULT_TTL_DAYS` (default 90); rotate
      tokens regularly. Refresh tokens rotate on use with replay detection.
- [ ] **Never store secrets in Amem** — no API keys, passwords, or tokens in
      unit bodies. Amem is a knowledge store, not a vault.
- [ ] **Back up**: `docker cp amem:/data/amem.db` (or copy `data/amem.db`
      after a `PRAGMA wal_checkpoint(TRUNCATE)`) on a schedule; keep an
      exported JSON/OKF bundle off-box. See `docs/OPERATIONS.md`.
- [ ] **Update regularly**: pull new images and run `pnpm audit`; the
      committed `pnpm-lock.yaml` keeps dependency bumps reviewable.

## Security-relevant configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `AMEM_AUTH_ENABLED` | `false` | Real accounts / OAuth 2.1 / PATs (recommended for anything shared) |
| `AMEM_AUTH_SECRET` | – | HMAC secret; changing it invalidates all tokens and sessions |
| `AMEM_ALLOW_LEGACY_API_TOKEN` | unset | Accept the single `AMEM_API_TOKEN` only when auth is disabled; set `false` to force off |
| `AMEM_MCP_OAUTH` | `1` | Require OAuth/PAT for MCP-over-HTTP |
| `AMEM_RATE_LIMIT_ENABLED` | `true` | Per-IP throttle on login/token/oauth/register endpoints |
| `AMEM_COOKIE_SECURE` | `false` | Add `Secure` to session cookies (set behind HTTPS) |
| `AMEM_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for rate-limit IPs (only behind a proxy) |
| `AMEM_CORS_ORIGIN` | – | Restrict browser origins; empty = no CORS headers |

Full model and schema: [`docs/AUTH_WORKSPACES.md`](docs/AUTH_WORKSPACES.md).
Ops procedures: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
