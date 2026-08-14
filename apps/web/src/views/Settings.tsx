import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { PageHead } from '../components/PageHead';
import type { AiProvider, AiStatus, OcrSettings } from '../types';

const PROVIDER_PRESETS: Array<{ name: string; baseUrl: string; model: string; note?: string }> = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  { name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
  {
    name: 'Local gateway (custom)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'my-model',
    note: 'Point this at any OpenAI-compatible service (e.g. your opencode Go gateway, vLLM, LM Studio).',
  },
];

function mcpConfigSnippet(pat: string, baseUrl: string): string {
  return `# Codex ~/.codex/config.toml (add to [mcp_servers] section)
[mcp_servers.amem]
command = "npx"
args = ["-y", "@amem/mcp", "--url", "${baseUrl}/mcp", "--token", "${pat}"]
env = { AMEM_TOKEN = "${pat}", AMEM_URL = "${baseUrl}" }

# REST (curl)
# curl -H "Authorization: Bearer ${pat}" -H "X-Amem-Workspace: personal" \\
#   ${baseUrl}/api/v1/recall -d '{"query":"what do I know?"}'
`;
}

export function Settings({ onAuthChange }: { onAuthChange?: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [email, setEmail] = useState('admin@localhost');
  const [password, setPassword] = useState('admin');
  const [patInput, setPatInput] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [members, setMembers] = useState<Array<{ userId: string; email: string; name: string | null; role: string }>>([]);
  const [memberEmail, setMemberEmail] = useState('');
  const [tokens, setTokens] = useState<Array<{ id: string; name: string; prefix: string; scopes: string[]; createdAt: string }>>([]);
  const [newWsSlug, setNewWsSlug] = useState('');
  const [newWsName, setNewWsName] = useState('');
  const [minted, setMinted] = useState('');
  const [patName, setPatName] = useState('codex');
  const [sessions, setSessions] = useState<
    Array<{
      id: string;
      kind: 'login' | 'oauth';
      type?: 'access' | 'refresh';
      clientId?: string | null;
      scopes?: string[];
      usedAt?: string | null;
      expiresAt?: string;
      createdAt?: string;
    }>
  >([]);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [provName, setProvName] = useState('');
  const [provBaseUrl, setProvBaseUrl] = useState('');
  const [provModel, setProvModel] = useState('');
  const [provEmbeddingModel, setProvEmbeddingModel] = useState('');
  const [provEmbeddingBaseUrl, setProvEmbeddingBaseUrl] = useState('');
  const [provEmbeddingApiKey, setProvEmbeddingApiKey] = useState('');
  const [provApiKey, setProvApiKey] = useState('');
  const [provTest, setProvTest] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [preset, setPreset] = useState('');
  const [ocrSettings, setOcrSettings] = useState<OcrSettings | null>(null);
  const [ocrBaseUrl, setOcrBaseUrl] = useState('');
  const [ocrModel, setOcrModel] = useState('');
  const [ocrApiKey, setOcrApiKey] = useState('');
  const [ocrMinChars, setOcrMinChars] = useState('60');
  const [ocrBusy, setOcrBusy] = useState(false);

  const load = async () => {
    try {
      const m = await api.me();
      setMe(m);
      setError('');
      if (m.user) {
        try {
          setTokens(await api.tokens());
        } catch {
          setTokens([]);
        }
        try {
          setSessions(await api.sessions());
        } catch {
          setSessions([]);
        }
        try {
          setMembers(await api.listMembers(api.getWorkspace()));
        } catch {
          setMembers([]);
        }
      }
      try {
        setProviders(await api.providers());
      } catch {
        setProviders([]);
      }
      try {
        setAiStatus(await api.aiStatus());
      } catch {
        setAiStatus(null);
      }
      try {
        const ocr = await api.ocrSettings();
        setOcrSettings(ocr);
        setOcrBaseUrl(ocr?.baseUrl ?? '');
        setOcrModel(ocr?.model ?? '');
        setOcrMinChars(String(ocr?.minChars ?? 60));
      } catch {
        setOcrSettings(null);
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const login = async () => {
    setError('');
    setInfo('');
    try {
      await api.login(email, password);
      setInfo('Logged in — PAT stored in this browser.');
      await load();
      onAuthChange?.();
    } catch (e) {
      try {
        await api.bootstrap(email, password, 'Admin');
        setInfo('Bootstrapped admin and stored PAT.');
        await load();
        onAuthChange?.();
      } catch (e2) {
        setError(String((e as Error).message || e) + ' / ' + String((e2 as Error).message || e2));
      }
    }
  };

  const logout = () => {
    api.logout();
    setInfo('Logged out (token cleared).');
    setMe(null);
    setTokens([]);
    setSessions([]);
    setMembers([]);
    setProviders([]);
    setAiStatus(null);
    onAuthChange?.();
    void load();
  };

  const usePat = async () => {
    setError('');
    setInfo('');
    const token = patInput.trim();
    if (!token) {
      setError('Paste a PAT first.');
      return;
    }
    try {
      const m = await api.usePat(token);
      setInfo(
        `PAT active — ${m.user ? `signed in as ${m.user.email}` : 'anonymous'}, scopes: ${m.scopes.join(', ')}`,
      );
      await load();
      onAuthChange?.();
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const createWs = async () => {
    try {
      await api.createWorkspace({ slug: newWsSlug, name: newWsName || newWsSlug, kind: 'company' });
      setNewWsSlug('');
      setNewWsName('');
      await load();
      setInfo('Workspace created.');
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const mintPat = async () => {
    try {
      const ws = me?.workspaces?.find((w) => w.slug === api.getWorkspace()) || me?.workspaces?.[0];
      const out = await api.createToken({
        name: patName || 'token',
        scopes: ['read', 'write', 'admin'],
        workspaceIds: ws ? [ws.id] : undefined,
      });
      setMinted(out.token);
      setInfo('PAT created — copy it now, it will not be shown again.');
      setTokens(await api.tokens());
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const switchWs = (slug: string) => {
    api.setWorkspace(slug);
    setInfo(`Active workspace → ${slug}`);
    onAuthChange?.();
    void load();
  };

  const createProvider = async () => {
    setError('');
    setInfo('');
    try {
      await api.createProvider({
        name: provName,
        baseUrl: provBaseUrl,
        model: provModel,
        embeddingModel: provEmbeddingModel.trim() || undefined,
        embeddingBaseUrl: provEmbeddingBaseUrl.trim() || undefined,
        embeddingApiKey: provEmbeddingApiKey || undefined,
        apiKey: provApiKey || undefined,
      });
      setProvName('');
      setProvBaseUrl('');
      setProvModel('');
      setProvEmbeddingModel('');
      setProvEmbeddingBaseUrl('');
      setProvEmbeddingApiKey('');
      setProvApiKey('');
      setProviders(await api.providers());
      setAiStatus(await api.aiStatus());
      setInfo('AI provider saved.');
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const runProviderTest = async (id: string) => {
    setProvTest(null);
    try {
      const r = await api.testProvider(id);
      setProvTest({
        id,
        ok: r.ok,
        msg: r.ok
          ? `ok · ${r.latencyMs}ms${r.model ? ` · model ${r.model}` : ''}`
          : `failed · ${r.error ?? 'unknown error'}`,
      });
    } catch (e) {
      setProvTest({ id, ok: false, msg: String((e as Error).message || e) });
    }
  };

  const saveOcr = async () => {
    setError('');
    setInfo('');
    setOcrBusy(true);
    try {
      await api.saveOcrSettings({
        baseUrl: ocrBaseUrl,
        model: ocrModel,
        apiKey: ocrApiKey.trim() || undefined,
        minChars: Number(ocrMinChars) || 60,
      });
      setOcrApiKey('');
      setOcrSettings(await api.ocrSettings());
      setAiStatus(await api.aiStatus());
      setInfo('OCR settings saved.');
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setOcrBusy(false);
    }
  };

  const clearOcr = async () => {
    setError('');
    setInfo('');
    setOcrBusy(true);
    try {
      await api.clearOcrSettings();
      setOcrSettings(null);
      setOcrBaseUrl('');
      setOcrModel('');
      setOcrMinChars('60');
      setAiStatus(await api.aiStatus());
      setInfo('OCR settings cleared.');
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setOcrBusy(false);
    }
  };

  return (
    <div className="grid">
      <PageHead
        title="Settings"
        sub={
          <>
            Day-to-day management: login, workspace isolation, PATs for Codex/MCP, sessions and AI
            providers. Active workspace: <code>{api.getWorkspace()}</code>
          </>
        }
      >
        {error && <div className="err">{error}</div>}
        {info && <div className="okmsg">{info}</div>}
      </PageHead>

      <div className="activity-columns">
        <div className="panel">
          <h3>Session</h3>
          {me ? (
            <>
              <div className="row">
                <span className="badge">{me.realm}</span>
                <span className="badge">auth {me.authEnabled ? 'on' : 'off'}</span>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                {me.user ? (
                  <>
                    Signed in as <b>{me.user.email}</b>
                  </>
                ) : (
                  <>Anonymous (no PAT). Local mode allows open access when auth is disabled.</>
                )}
              </div>
              <div className="muted">
                Current workspace: <b>{me.workspace.slug}</b> · scopes: {me.scopes.join(', ')}
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                {me.user && (
                  <button className="btn" onClick={logout}>
                    Log out
                  </button>
                )}
                <button className="btn" onClick={() => void load()}>
                  Refresh
                </button>
              </div>
            </>
          ) : (
            <div className="muted">Loading…</div>
          )}

          <h3 style={{ marginTop: 18 }}>Login / Bootstrap</h3>
          <label className="muted">Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <label className="muted">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => void login()}>
            Login or Bootstrap
          </button>
          <h4 style={{ marginTop: 14 }}>Or paste a PAT (Codex / CLI style)</h4>
          <label className="muted">PAT</label>
          <input
            value={patInput}
            onChange={(e) => setPatInput(e.target.value)}
            placeholder="amem_pat_…"
            style={{ width: '100%' }}
          />
          <button className="btn" style={{ marginTop: 10 }} onClick={() => void usePat()}>
            Use PAT
          </button>
          <p className="muted" style={{ marginTop: 8 }}>
            If no users exist, this bootstraps admin. If auth is disabled on server, APIs still work without PAT.
          </p>
        </div>

        <div className="panel">
          <h3>Workspaces</h3>
          <ul className="dots">
            {(me?.workspaces || []).map((w) => (
              <li key={w.id} onClick={() => switchWs(w.slug)}>
                <b>{w.name}</b> <span className="badge">{w.slug}</span>
                {w.kind && <span className="badge">{w.kind}</span>}
                {api.getWorkspace() === w.slug && <span className="badge">active</span>}
              </li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: 12 }}>
            <input placeholder="slug" value={newWsSlug} onChange={(e) => setNewWsSlug(e.target.value)} />
            <input placeholder="name" value={newWsName} onChange={(e) => setNewWsName(e.target.value)} />
            <button className="btn" onClick={() => void createWs()}>
              Create
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Personal Access Tokens</h3>
        <div className="row">
          <input placeholder="name" value={patName} onChange={(e) => setPatName(e.target.value)} />
          <button className="btn primary" onClick={() => void mintPat()}>
            Mint PAT
          </button>
        </div>
        {minted && (
          <pre style={{ marginTop: 10, whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>
            {minted}
          </pre>
        )}
        <h4 style={{ marginTop: 16 }}>Connect Codex / Claude Code</h4>
        <p className="muted" style={{ marginTop: 0 }}>
          Point an agent at Amem over MCP. Base URL: <code>{`${window.location.protocol}//${window.location.host}`}</code>.
          Mint a PAT above, then drop this into <code>~/.codex/config.toml</code> (or your Claude Code MCP config):
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>
          {mcpConfigSnippet(minted || 'amem_pat_…', `${window.location.protocol}//${window.location.host}`)}
        </pre>
        <ul className="dots" style={{ marginTop: 12 }}>
          {tokens.map((t) => (
            <li key={t.id}>
              <b>{t.name}</b> <span className="muted">{t.prefix}…</span>
              <span className="badge">{t.scopes.join(' ')}</span>
              <button className="btn" style={{ marginLeft: 8 }} onClick={() => void api.revokeToken(t.id).then(load)}>
                Revoke
              </button>
            </li>
          ))}
          {tokens.length === 0 && <li className="muted">No PATs (login first).</li>}
        </ul>
      </div>

      <div className="panel">
        <h3>Workspace members</h3>
        <p className="muted">Owner/admin can add users (they must already have an Amem login).</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="member@email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} />
          <button
            className="btn"
            onClick={() => {
              void (async () => {
                try {
                  await api.addMember(api.getWorkspace(), { email: memberEmail, role: 'member' });
                  setMemberEmail('');
                  setMembers(await api.listMembers(api.getWorkspace()));
                  setInfo('Member added');
                } catch (e) {
                  setError(String((e as Error).message || e));
                }
              })();
            }}
          >
            Add member
          </button>
        </div>
        <ul className="dots" style={{ marginTop: 12 }}>
          {members.map((m) => (
            <li key={m.userId} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {m.email} <span className="badge">{m.role}</span>
              </span>
              <button
                className="btn"
                onClick={() => {
                  void (async () => {
                    try {
                      await api.removeMember(api.getWorkspace(), m.userId);
                      setMembers(await api.listMembers(api.getWorkspace()));
                    } catch (e) {
                      setError(String((e as Error).message || e));
                    }
                  })();
                }}
              >
                Remove
              </button>
            </li>
          ))}
          {members.length === 0 && <li className="muted">No members loaded (login as owner/admin).</li>}
        </ul>
      </div>

      <div className="panel">
        <h3>OAuth (PKCE)</h3>
        <p className="muted">
          Authorization server metadata: <code>/.well-known/oauth-authorization-server</code>
          <br />
          Protected resource: <code>/.well-known/oauth-protected-resource/mcp</code>
          <br />
          Authorize: <code>/oauth/authorize</code> · Token: <code>/oauth/token</code> · DCR: <code>/oauth/register</code>
          <br />
          Public client id: <code>amem-web</code> (S256 PKCE required). Codex: <code>auth = &quot;oauth&quot;</code> + optional PAT
          header fallback.
        </p>
      </div>

      <div className="panel">
        <h3>Active sessions</h3>
        <p className="muted">
          Browser login sessions and OAuth token pairs for your account. Revoking a token pair burns its whole family
          (access + refresh). Refresh tokens rotate on every use; a replayed token revokes the family automatically.
        </p>
        <ul className="dots" style={{ marginTop: 12 }}>
          {sessions.map((s) => (
            <li key={s.id} className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span>
                <b>{s.kind === 'login' ? 'Login session' : `OAuth ${s.type ?? 'token'}`}</b>{' '}
                <span className="muted">{s.id}</span>
                {s.clientId && <span className="badge">{s.clientId}</span>}
                {s.scopes?.length ? <span className="badge">{s.scopes.join(' ')}</span> : null}
                <span className="muted">
                  {s.createdAt ? ` created ${new Date(s.createdAt).toLocaleString()}` : ''}
                  {s.usedAt ? ` · used ${new Date(s.usedAt).toLocaleString()}` : ''}
                </span>
              </span>
              <button
                className="btn"
                onClick={() => {
                  void (async () => {
                    try {
                      await api.revokeSession(s.id);
                      setInfo(`Session ${s.id} revoked.`);
                      setSessions(await api.sessions());
                    } catch (e) {
                      setError(String((e as Error).message || e));
                    }
                  })();
                }}
              >
                Revoke
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="muted">No active sessions (login first).</li>}
        </ul>
      </div>

      <div className="panel">
        <h3>AI Providers</h3>
        <p className="muted">
          Point Amem at an OpenAI-compatible LLM endpoint (DeepSeek, opencode, Ollama, …). The
          active provider powers automatic organization: distillation on ingest, link generation,
          and curation summaries. Keys are AES-256-GCM encrypted at rest and never returned by the
          API. Priority: active provider → <code>AMEM_LLM_*</code> env → offline (mock).
          Set an optional embedding model on the active provider to switch recall/graph to
          semantic API embeddings instead of offline hashing.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <span className="badge">
            mode: {aiStatus ? aiStatus.mode : '…'}
          </span>
          <span className="badge">
            embedding: {aiStatus ? aiStatus.embedding.mode : '…'}
            {aiStatus?.embedding.model ? ` · ${aiStatus.embedding.model}` : ''}
          </span>
          <span className="badge">
            OCR: {aiStatus?.ocr ? aiStatus.ocr.model : 'off (scanned PDFs skipped)'}
          </span>
          {aiStatus?.active && <span className="badge">active: {aiStatus.active.name}</span>}
          {aiStatus?.env && (
            <span className="badge">
              env: {aiStatus.env.model} @ {aiStatus.env.baseUrl}
            </span>
          )}
        </div>
        {aiStatus && !aiStatus.ocr && (
          <p className="muted" style={{ marginTop: 8 }}>
            OCR needs a vision-capable OpenAI-compatible endpoint (the active LLM provider may not
            support images). Configure one below, or set <code>AMEM_OCR_*</code> env vars (DB
            settings take priority).
          </p>
        )}

        <h4 style={{ marginTop: 16 }}>OCR endpoint (scanned PDFs)</h4>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <input
              style={{ flex: 1 }}
              placeholder="base URL (e.g. https://api.siliconflow.cn/v1)"
              value={ocrBaseUrl}
              onChange={(e) => setOcrBaseUrl(e.target.value)}
            />
            <input
              style={{ flex: 1 }}
              placeholder="model (vision-capable, e.g. Qwen/Qwen2.5-VL-72B-Instruct)"
              value={ocrModel}
              onChange={(e) => setOcrModel(e.target.value)}
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input
              style={{ flex: 2 }}
              type="password"
              placeholder={ocrSettings?.hasKey ? `api key (current: ${ocrSettings.keyPrefix}) — leave blank to keep` : 'api key'}
              value={ocrApiKey}
              onChange={(e) => setOcrApiKey(e.target.value)}
            />
            <input
              style={{ flex: 1 }}
              type="number"
              min={10}
              max={1000}
              placeholder="min chars (default 60)"
              value={ocrMinChars}
              onChange={(e) => setOcrMinChars(e.target.value)}
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={saveOcr} disabled={ocrBusy}>
              {ocrBusy ? 'Saving…' : ocrSettings ? 'Update OCR' : 'Save OCR'}
            </button>
            {ocrSettings && (
              <button onClick={clearOcr} disabled={ocrBusy} className="danger">
                Clear
              </button>
            )}
            <span className="muted">
              {ocrSettings
                ? `configured: ${ocrSettings.model} @ ${ocrSettings.baseUrl}`
                : 'not configured — scanned PDFs will be skipped'}
            </span>
          </div>
        </div>

        <h4 style={{ marginTop: 16 }}>Add / edit provider</h4>
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <select
              value={preset}
              onChange={(e) => {
                const p = PROVIDER_PRESETS.find((x) => x.name === e.target.value);
                setPreset(e.target.value);
                if (p) {
                  setProvName(p.name);
                  setProvBaseUrl(p.baseUrl);
                  setProvModel(p.model);
                }
              }}
              style={{ flex: 1 }}
            >
              <option value="">Quick-fill preset…</option>
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="muted">preset</span>
          </div>
          <input placeholder="name (e.g. DeepSeek)" value={provName} onChange={(e) => setProvName(e.target.value)} />
          <input
            placeholder="base URL (e.g. https://api.deepseek.com/v1)"
            value={provBaseUrl}
            onChange={(e) => setProvBaseUrl(e.target.value)}
          />
          <input
            placeholder="model (e.g. deepseek-chat)"
            value={provModel}
            onChange={(e) => setProvModel(e.target.value)}
          />
          <input
            placeholder="embedding model (optional) — e.g. text-embedding-v3"
            value={provEmbeddingModel}
            onChange={(e) => setProvEmbeddingModel(e.target.value)}
          />
          <input
            placeholder="embedding base URL (optional — separate /embeddings endpoint, e.g. http://localhost:11434/v1)"
            value={provEmbeddingBaseUrl}
            onChange={(e) => setProvEmbeddingBaseUrl(e.target.value)}
          />
          <input
            type="password"
            placeholder="embedding API key (optional — for the embedding endpoint)"
            value={provEmbeddingApiKey}
            onChange={(e) => setProvEmbeddingApiKey(e.target.value)}
          />
          <input
            type="password"
            placeholder="API key (leave blank to keep existing on edit)"
            value={provApiKey}
            onChange={(e) => setProvApiKey(e.target.value)}
          />
          <button className="btn primary" onClick={() => void createProvider()}>
            Save provider
          </button>
        </div>
        {PROVIDER_PRESETS.some((p) => p.note) && (
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {PROVIDER_PRESETS.find((p) => p.name === preset)?.note ??
              'Presets fill the form; edit any field before saving. Local gateways can be any OpenAI-compatible endpoint.'}
          </p>
        )}

        <ul className="dots" style={{ marginTop: 14 }}>
          {providers.map((p) => (
            <li key={p.id} style={{ display: 'grid', gap: 6 }}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <span>
                  <b>{p.name}</b>{' '}
                  <span className="muted">
                    {p.baseUrl} · {p.model}
                    {p.embeddingModel ? ` · embed ${p.embeddingModel}` : ''}
                    {p.embeddingBaseUrl ? ` · embeds via ${p.embeddingBaseUrl}` : ''}
                  </span>{' '}
                  {p.isActive && <span className="badge">active</span>}
                  <span className="badge">{p.hasKey ? `key ${p.keyPrefix}` : 'no key'}</span>
                  {p.hasEmbeddingKey && <span className="badge">embed key set</span>}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  {!p.isActive && (
                    <button
                      className="btn"
                      onClick={() => {
                        void (async () => {
                          try {
                            await api.activateProvider(p.id);
                            setProviders(await api.providers());
                            setAiStatus(await api.aiStatus());
                            setInfo(`Provider "${p.name}" activated — LLM rebuilt.`);
                          } catch (e) {
                            setError(String((e as Error).message || e));
                          }
                        })();
                      }}
                    >
                      Activate
                    </button>
                  )}
                  <button className="btn" onClick={() => void runProviderTest(p.id)}>
                    Test
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      void (async () => {
                        try {
                          await api.deleteProvider(p.id);
                          setProviders(await api.providers());
                          setAiStatus(await api.aiStatus());
                          setInfo(`Provider "${p.name}" deleted.`);
                        } catch (e) {
                          setError(String((e as Error).message || e));
                        }
                      })();
                    }}
                  >
                    Delete
                  </button>
                </span>
              </div>
              {provTest?.id === p.id && (
                <div className={provTest.ok ? 'okmsg' : 'err'} style={{ margin: 0 }}>
                  Test {provTest.msg}
                </div>
              )}
            </li>
          ))}
          {providers.length === 0 && (
            <li className="muted">
              No providers yet — add one above, or use <code>AMEM_LLM_BASE_URL</code> /{' '}
              <code>AMEM_LLM_MODEL</code> / <code>AMEM_LLM_API_KEY</code> env vars.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
