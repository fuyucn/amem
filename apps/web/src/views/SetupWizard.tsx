import { useEffect, useState } from 'react';
import { api, type Me } from '../api';

type Step = 'check' | 'account' | 'workspace' | 'pat' | 'config';

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: 'Read units, graph, recall',
  write: 'Create/update units, ingest',
  admin: 'Manage workspaces, members, tokens',
};

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

export function SetupWizard() {
  const [step, setStep] = useState<Step>('check');
  const [me, setMe] = useState<Me | null>(null);
  const [tokens, setTokens] = useState<Array<{ id: string; name: string }>>([]);
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [email, setEmail] = useState('admin@localhost');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('Admin');
  const [wsSlug, setWsSlug] = useState('');
  const [wsName, setWsName] = useState('');
  const [pat, setPat] = useState('');
  const [patName, setPatName] = useState('codex');
  const [scope, setScope] = useState('read write');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const baseUrl = `${window.location.protocol}//${window.location.host}`;

  const load = async () => {
    setError('');
    try {
      const m = await api.me();
      setMe(m);
      if (m.user) setEmail(m.user.email);
      setStep(m.user ? 'workspace' : 'account');
      try {
        setTokens(await api.tokens());
      } catch {
        setTokens([]);
      }
      try {
        setProviders(await api.providers());
      } catch {
        setProviders([]);
      }
    } catch {
      setStep('account');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const ensureAccount = async () => {
    setError('');
    setInfo('');
    if (!password) {
      setError('Password required');
      return;
    }
    try {
      await api.login(email, password);
      setInfo('Signed in.');
    } catch {
      try {
        await api.bootstrap(email, password, name || 'Admin');
        setInfo('Admin account created.');
      } catch (e) {
        setError(String((e as Error).message || e));
        return;
      }
    }
    await load();
    setStep('workspace');
  };

  const ensureWorkspace = async () => {
    setError('');
    if (!wsSlug) {
      setStep('pat');
      return;
    }
    try {
      const slug = wsSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) throw new Error('Invalid slug');
      await api.createWorkspace({ slug, name: wsName || slug, kind: 'company' });
      api.setWorkspace(slug);
      setInfo(`Workspace "${slug}" created and active.`);
      setStep('pat');
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const mintPat = async () => {
    setError('');
    setPat('');
    try {
      const ws = me?.workspaces?.find((w) => w.slug === api.getWorkspace()) || me?.workspaces?.[0];
      const out = await api.createToken({
        name: patName || 'codex',
        scopes: scope.split(/\s+/).filter(Boolean),
        workspaceIds: ws ? [ws.id] : undefined,
      });
      setPat(out.token);
      setInfo('PAT minted — copy it now, it will not be shown again.');
      setStep('config');
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const checks: Array<{ label: string; done: boolean; detail: string }> = [
    { label: 'Admin account', done: Boolean(me?.user), detail: me?.user ? me.user.email : 'Create or sign in' },
    {
      label: 'Workspace',
      done: Boolean(me?.workspace),
      detail: me?.workspace ? `${me.workspace.name} (${me.workspace.slug})` : 'Create a workspace',
    },
    { label: 'PAT for agents', done: tokens.length > 0, detail: tokens.length > 0 ? `${tokens.length} token(s) minted` : 'Mint a personal access token' },
    { label: 'AI provider', done: providers.length > 0, detail: providers.length > 0 ? providers[0]!.name : 'Optional — add in Settings' },
  ];

  return (
    <div className="grid">
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Setup wizard</h2>
        <p className="muted">
          One-time guided onboarding: admin account → workspace → PAT → MCP/REST configuration.
          Everything stays on this machine. For day-to-day administration (tokens, members, AI
          providers, OAuth) use{' '}
          <a
            href="/settings"
            onClick={(e) => {
              e.preventDefault();
              window.history.pushState(null, '', '/settings');
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
          >
            Settings
          </a>
          .
        </p>
        <div className="panel" style={{ background: 'var(--panel2)', marginTop: 10 }}>
          <h4 style={{ marginTop: 0 }}>Setup status</h4>
          {checks.map((c) => (
            <div key={c.label} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span>
                <span className={c.done ? 'okmsg' : 'muted'} style={{ margin: 0 }}>{c.done ? '✓' : '○'}</span>{' '}
                <b>{c.label}</b> <span className="muted">— {c.detail}</span>
              </span>
            </div>
          ))}
        </div>
        {error && <div className="err">{error}</div>}
        {info && <div className="okmsg">{info}</div>}
        <div className="row" style={{ margin: '10px 0' }}>
          {(['check', 'account', 'workspace', 'pat', 'config'] as Step[]).map((s, i) => (
            <span key={s} className="badge" style={{ background: step === s ? 'var(--accent)' : undefined, color: step === s ? '#fff' : undefined }}>
              {i + 1}. {s}
            </span>
          ))}
        </div>
      </div>

      {step === 'account' && (
        <div className="panel">
          <h3>1 · Admin account</h3>
          <label className="muted">Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <label className="muted">Name (only used when bootstrapping)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <label className="muted">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => void ensureAccount()}>
            Login or bootstrap admin
          </button>
        </div>
      )}

      {step === 'workspace' && (
        <div className="panel">
          <h3>2 · Workspace</h3>
          <p className="muted">
            Workspaces isolate projects (e.g. <code>company-a</code>, <code>personal</code>). Leave slug empty to keep using{' '}
            <code>{api.getWorkspace()}</code>.
          </p>
          <div className="row">
            <input placeholder="company-a" value={wsSlug} onChange={(e) => setWsSlug(e.target.value)} />
            <input placeholder="name" value={wsName} onChange={(e) => setWsName(e.target.value)} />
            <button className="btn primary" onClick={() => void ensureWorkspace()}>
              {wsSlug ? 'Create workspace' : 'Use current workspace'}
            </button>
          </div>
        </div>
      )}

      {step === 'pat' && (
        <div className="panel">
          <h3>3 · Personal Access Token</h3>
          <label className="muted">Name</label>
          <input value={patName} onChange={(e) => setPatName(e.target.value)} style={{ marginBottom: 8 }} />
          <label className="muted">Scopes</label>
          <div className="row" style={{ marginBottom: 8 }}>
            {Object.entries(SCOPE_DESCRIPTIONS).map(([s, desc]) => (
              <label key={s} className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  checked={scope.split(/\s+/).includes(s)}
                  onChange={(e) => {
                    const current = scope.split(/\s+/).filter(Boolean);
                    const next = e.target.checked ? [...current, s] : current.filter((x) => x !== s);
                    setScope(next.join(' '));
                  }}
                />
                <span>{s}</span>
                <span className="muted">— {desc}</span>
              </label>
            ))}
          </div>
          <button className="btn primary" onClick={() => void mintPat()}>
            Mint PAT
          </button>
          {pat && (
            <pre style={{ marginTop: 10, whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>
              {pat}
            </pre>
          )}
        </div>
      )}

      {step === 'config' && (
        <div className="panel">
          <h3>4 · Connect Codex / Claude Code</h3>
          <p className="muted">
            Base URL: <code>{baseUrl}</code>. Active workspace: <code>{api.getWorkspace()}</code>. PAT:
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>
            {pat}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>
            {mcpConfigSnippet(pat, baseUrl)}
          </pre>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setStep('pat')}>
              ← Back
            </button>
            <button className="btn" onClick={() => void load()}>
              Restart wizard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
