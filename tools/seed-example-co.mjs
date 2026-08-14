#!/usr/bin/env node
/**
 * Seed a realistic company knowledge base into an Amem workspace.
 *
 * Creates (or reuses) a workspace named `example-co` and ingests a set of
 * documents that resemble a real company wiki: ADRs, runbooks, a postmortem,
 * security policy, onboarding guide, API spec, meeting notes and a Chinese
 * design doc. Each document is distilled into units and auto-linked, so the
 * workspace demonstrates search, recall and knowledge-graph behavior.
 *
 * Usage:
 *   AMEM_URL=http://127.0.0.1:8321 AMEM_PAT=amem_pat_xxx node tools/seed-example-co.mjs
 *   AMEM_SLUG=my-co AMEM_KEEP=1 ...   # different workspace slug / keep idempotent
 */

const URL = process.env.AMEM_URL || 'http://127.0.0.1:8321';
const PAT = process.env.AMEM_PAT || '';
const SLUG = process.env.AMEM_SLUG || 'example-co';

if (!PAT) {
  console.error('AMEM_PAT is required');
  process.exit(1);
}

async function j(method, path, body, workspace) {
  const res = await fetch(URL + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${PAT}`,
      ...(workspace ? { 'x-amem-workspace': workspace } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.code || text.slice(0, 200);
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
  }
  return data;
}

const DOCS = [
  {
    title: 'ADR-014: semantic search on Postgres + pgvector',
    sourceKind: 'note',
    content: `
Decision: we will back semantic search with PostgreSQL 16 + pgvector instead of a
dedicated vector database. Rationale: one fewer operational system, SQL joins keep
workspace isolation trivial, and 10M-row workloads measured under 40ms p95 for our
embedding dimension (768). We keep hybrid ranking: keyword BM25 first, vector scores
as a tiebreaker, clamp semantic noise. Migration path: add the vector column via
migration 0231, backfill with the offline embedding model (bge-small-en), then flip
the search flag per workspace. Rollback: set feature flag search.engine=keyword only.
Owned by the platform team; review in Q4.
`.trim(),
  },
  {
    title: 'API spec: /v1/agents endpoints',
    sourceKind: 'note',
    content: `
Public API for agent management. POST /v1/agents creates an agent: body requires
name (1-64 chars), model (one of gpt-5, claude-sonnet-4, deepseek-v3), instructions
as markdown, tool_policy object listing allowed tools. Returns agent id + api key.
GET /v1/agents/{id} returns config without secrets. PATCH updates fields; changing
the model resets the agent session context. DELETE archives the agent, keeps audit
logs for 90 days. Rate limits: 60 rpm per agent, burst 120. Auth: Bearer token with
scope agents:write. All endpoints return 429 with Retry-After when throttled. Known
issue: PATCH does not yet support tags; tracked as AENG-882.
`.trim(),
  },
  {
    title: 'Runbook: production deploy and rollback',
    sourceKind: 'manual',
    content: `
Goal: ship backend and web releases safely. Preflight: confirm CI is green on main,
check dashboards (error rate < 0.5%, p95 latency < 250ms), and ensure the deploy
lock file does not exist. Deploy steps: 1) tag release and push to prod channel in
the CD pipeline; 2) canary 10% for 10 minutes, watch metrics via Grafana panel
Deploy Health; 3) promote to 100% when canary is clean. Rollback: run the one-click
rollback job which re-points the prod slot to the previous image; verify with
curl https://api.example.co/healthz. Escalation: if rollback fails, page the on-call
via PagerDuty policy "prod-critical" and freeze further deploys until incident
resolved. Post-deploy: smoke the top 5 customer flows (login, ingest, search, billing,
webhook). Full checklist lives in the ops repo under docs/runbooks.
`.trim(),
  },
  {
    title: 'Runbook: recover from a failed database migration',
    sourceKind: 'manual',
    content: `
When a migration fails mid-flight, the schema is locked and the API returns 500s
with "migration_pending". Do not retry blindly. 1) Identify the failed migration
from the migrations table (applied_at null). 2) If the migration is additive
(new column/table), fix the SQL and re-run. 3) If it rewrites data (backfill),
restore the pre-migration backup from the nightly snapshot and re-apply from a
clean point. 4) For pgvector migrations, verify the extension is installed on the
primary and replicas. 5) Communicate status in #eng-incidents. Rule: production
migrations require two approvals and always run with lock_timeout 5s. Related
incident: INC-441 (July 2026) where a backfill took the DB down for 40 minutes.
`.trim(),
  },
  {
    title: 'Postmortem INC-447: payment gateway timeout (2026-07-12)',
    sourceKind: 'note',
    content: `
Impact: checkout failed for 2.3% of paying customers for 54 minutes; no data loss;
4,120 support tickets. Root cause: the billing service retried the payment
provider with a 1s timeout but no circuit breaker, so provider slowness cascaded
into connection-pool exhaustion. Timeline: 09:02 provider degradation begins,
09:11 error rate spikes, 09:26 on-call paged, 09:47 circuit breaker enabled via
feature flag billing.cb=on, 09:56 recovery. Actions: (1) enable circuit breaker by
default, (2) add provider latency alert to Deploy Health, (3) extend payment
timeout to 10s with exponential backoff, (4) write an incident runbook for billing
degradation, (5) refresh the DR plan with payment provider failover. Owner: team
ledger. Review date: 2026-07-26.
`.trim(),
  },
  {
    title: 'Security policy: API token rotation and OAuth client management',
    sourceKind: 'note',
    content: `
All service-to-service credentials must rotate every 90 days. Personal access
tokens: minted through the admin console, scoped per workspace (read, write,
admin), stored hashed at rest, and revoked immediately on employee offboarding.
OAuth2.1 clients use PKCE + refresh-token rotation; a refresh token is one-time
use and reuse triggers account lockdown. Secrets never enter code, logs, or
chat; use the vault API and reference keys in CI. Security posture can only get
stricter: a workspace cannot relax the instance default. Compliance reviews run
quarterly; evidence exports to the GRC bucket. Any token leak is a P1 incident
and follows the incident protocol.
`.trim(),
  },
  {
    title: 'Engineering onboarding: first two weeks',
    sourceKind: 'manual',
    content: `
Welcome! Week 1: set up the dev environment (asdf, Docker Desktop, direnv), clone
the monorepo, run make setup, and complete the 6 onboarding tickets. Read the
architecture overview and the ADR index before your first 1:1. Week 2: ship a
small fix end-to-end (example: add a field to the agents API) with tests; deploy
to staging yourself using the deploy runbook, then ask a senior to review your
first production deploy. Key resources: #eng-help Slack, engineering wiki,
monthly architecture review, and the code conventions doc. Buddy system: your
buddy is listed in the onboarding tracker. By day 10 you should have merged 3 PRs
and filed one improvement issue.
`.trim(),
  },
  {
    title: 'Meeting notes: Q3 roadmap review (2026-07-29)',
    sourceKind: 'transcript',
    content: `
Attendees: eng leads + product. Decisions: (1) Q3 ships workspace-level audit
export before the enterprise pilot, owner platform; (2) search quality gates:
hit@3 >= 60% on the eval suite or the ranking change does not ship; (3) defer
multi-region read replicas to Q4, keep single-region with RPO 5min. Open
questions: whether to expose raw embeddings in the API (privacy review pending);
capacity for the knowledge-graph visualization revamp. Action items: Daria to
draft the audit export spec by Aug 8; Leo to benchmark bge-small vs gte-small
for recall; Mei to schedule the enterprise pilot kickoff. Next review: Aug 26.
`.trim(),
  },
  {
    title: 'Customer case: FinPay data ingestion (enterprise pilot)',
    sourceKind: 'note',
    content: `
FinPay, a fintech with 2M end users, piloted our agent knowledge base. Setup:
their compliance team required on-prem data residency, so we deployed the
self-hosted stack (SQLite + offline embeddings) inside their VPC. They ingest
~40k tickets/month; dedup cut storage 31%. Their support agents report 22% faster
case resolution because recall surfaces prior fixes and related runbooks. Key
learnings: (1) enterprise buyers care about audit exports and role-based access;
(2) onboarding needed a two-day workshop, not just docs; (3) they hit the
workspace-membership limit and we shipped group roles early. Reference contact:
their platform lead Priya. Next milestone: SSO via Okta and SCIM.
`.trim(),
  },
  {
    title: 'Competitive note: agent memory/knowledge tools landscape',
    sourceKind: 'note',
    content: `
Survey of adjacent tools as of Aug 2026. Memory frameworks: Mem0 focuses on user
profile memory for chat assistants; Zep retains conversation history with graph
semantics; Letta (formerly MemGPT) manages context windows with paging. Knowledge
base / wiki tools: Obsidian is file-first markdown with local linking; llm-wiki
renders markdown into LLM-friendly contexts; Notion is a full collaboration
suite, not agent-native. Differentiators we keep: atomic units + auto-linking,
workspace isolation with OAuth scopes, a native MCP server, offline embeddings
for self-hosting, and open knowledge format export (OKF). Watch: vector DB
bundling into Postgres ecosystems, and agentic crawlers replacing manual wiki
curation.
`.trim(),
  },
  {
    title: 'Code conventions: Go services',
    sourceKind: 'manual',
    content: `
Standard layout per service: cmd/, internal/{api,service,store}, migrations/.
Use the shared logging middleware (slog JSON) and the standard error envelope;
never return raw sql errors to clients. Context propagation: all store calls take
context.Context and respect the 3s timeout budget. Testing: table-driven tests
with fake stores; integration tests require the TEST_DATABASE_URL env and are
tagged integration. Lint gate: golangci-lint must pass with the repo config, and
staticcheck for critical issues. Concurrency: use errgroup for fan-out, never
fire-and-forget goroutines outside the job runner. Graceful shutdown on SIGTERM
with a 10s drain window.
`.trim(),
  },
  {
    title: 'SLA and alerting: production SLOs',
    sourceKind: 'manual',
    content: `
Production SLOs: availability 99.9% monthly, p95 API latency 250ms, error rate
below 0.5%. Alert rules live in the monitoring repo: Critical (page): availability
drop, deploy failure, payment provider error rate > 2%, DB replication lag > 60s.
Warning (no page): p95 > 250ms for 10 min, queue depth > 1000, disk > 80%.
Alerting uses PagerDuty with policy prod-critical and prod-warning. On-call
rotation weekly, handover notes in the ops channel. Incident severity table:
SEV1 (outage) requires the incident protocol and a postmortem within 5 days;
SEV2 (partial) postmortem optional. Dashboards: overview, Deploy Health, Billing,
Search quality. See the runbook repo for the full catalog.
`.trim(),
  },
  {
    title: '设计文档：企业知识库的权限模型（中文）',
    sourceKind: 'note',
    content: `
目标：为企业客户提供基于 workspace 的权限隔离。设计要点：每个 workspace 有独立
的存储前缀和审计日志；成员角色分为 owner、admin、editor、reader，角色只能收紧不
能放宽；OAuth2.1 授权码模式配合 PKCE，refresh token 一次性使用；PAT 可绑定到指
定 workspace 并声明 scope。数据主权：所有数据保存在客户自托管环境（本地 SQLite），
我们只提供服务代码。导出支持 OKF 开放知识格式。风险：多 workspace 时的备份策略
与迁移工具尚未统一，需要在企业试点前补齐。下一步：与合规团队对齐审计日志保留
周期（90 天），并完成 SSO 集成方案评审。
`.trim(),
  },
];

async function main() {
  const me = await j('GET', '/api/v1/me');
  const existing = (me.workspaces || []).find((w) => w.slug === SLUG);
  let ws;
  if (existing) {
    ws = existing;
    console.log(`workspace ${SLUG} already exists, reusing (idempotent)`);
  } else {
    ws = await j('POST', '/api/v1/workspaces', { slug: SLUG, name: 'ExampleCo — company knowledge base', kind: 'company' });
    console.log(`created workspace ${ws.slug} (${ws.id})`);
  }

  let traces = 0;
  let units = 0;
  for (const doc of DOCS) {
    const r = await j(
      'POST',
      '/api/v1/ingest',
      {
        title: doc.title,
        content: doc.content,
        contentType: 'text/plain',
        sourceKind: doc.sourceKind,
        extract: true,
        autoLink: true,
      },
      SLUG,
    );
    traces += 1;
    units += (r.units || []).length;
    console.log(`  ingested: ${doc.title} -> ${(r.units || []).length} units`);
  }
  console.log(`\ningested ${units} units across ${traces} docs`);

  const stats = await j('GET', '/api/v1/stats', undefined, SLUG);
  console.log('\nworkspace stats:', JSON.stringify(stats.counts, null, 2));

  console.log('\n=== search demos ===');
  for (const q of ['deploy rollback', 'payment provider outage', 'token rotation', 'pgvector migration', 'onboarding 入职']) {
    const s = await j('GET', `/api/v1/search?q=${encodeURIComponent(q)}&limit=3`, undefined, SLUG);
    console.log(`\nquery: "${q}" (${s.total} hits)`);
    for (const it of s.items.slice(0, 3)) {
      console.log(`  [${it.score.toFixed(2)} ${it.via}] ${it.unit.title}`);
    }
  }

  console.log('\n=== recall demo ===');
  const rc = await j(
    'POST',
    '/api/v1/recall',
    { query: 'a deploy went bad and checkout is failing, what do we do', tokenBudget: 2500 },
    SLUG,
  );
  console.log(`used ${rc.usedTokens}/${rc.budget} tokens, grounded=${rc.grounded}`);
  for (const it of rc.items.slice(0, 6)) {
    console.log(`  [${it.score.toFixed(2)}] ${it.unit.title} — ${it.reason}`);
  }

  const g = await j('GET', '/api/v1/graph?clusters=1&scenarios=1', undefined, SLUG);
  console.log(`\ngraph: ${g.nodes.length} nodes, ${g.links.length} links, ${(g.clusters || []).length} clusters`);
  console.log('\nseed complete. Open the UI, switch workspace to example-co and browse Activity / Graph / Search.');
}

main().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
