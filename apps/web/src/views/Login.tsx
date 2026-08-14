import { useEffect, useState } from 'react';
import { api, type Me } from '../api';

type Step = 'account' | 'workspace' | 'token';
type Mode = 'login' | 'bootstrap' | 'pat';

const STEP_LABELS: Array<{ id: Step; label: string }> = [
  { id: 'account', label: 'Account' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'token', label: 'Agent token' },
];

function codexSnippet(pat: string, baseUrl: string): string {
  return `# ~/.codex/config.toml — append inside the [mcp_servers] section
[mcp_servers.amem]
url = "${baseUrl}/mcp"
startup_timeout_sec = 20

[mcp_servers.amem.http_headers]
Authorization = "Bearer ${pat}"

# REST smoke test
# curl -H "Authorization: Bearer ${pat}" -H "X-Amem-Workspace: personal" ${baseUrl}/api/v1/me`;
}

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [step, setStep] = useState<Step>('account');
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('admin@localhost');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('Admin');
  const [patInput, setPatInput] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; slug: string; name: string; kind?: string }>>([]);
  const [activeWs, setActiveWs] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [minted, setMinted] = useState('');
  const [patName, setPatName] = useState('codex');
  const [copied, setCopied] = useState(false);

  const baseUrl = `${window.location.protocol}//${window.location.host}`;

  useEffect(() => {
    api.me().then(setMe).catch(() => undefined);
  }, []);

  const goStep = (s: Step) => {
    setError('');
    setInfo('');
    setStep(s);
  };

  const submitAccount = async () => {
    setError('');
    setInfo('');
    setBusy(true);
    try {
      if (mode === 'pat') {
        const t = patInput.trim();
        if (!t) throw new Error('请先粘贴 PAT');
        await api.usePat(t);
      } else if (mode === 'bootstrap') {
        await api.bootstrap(email, password, name || 'Admin');
      } else {
        try {
          await api.login(email, password);
        } catch {
          // First deploy has no users yet: fall back to bootstrapping admin.
          await api.bootstrap(email, password, name || 'Admin');
        }
      }
      const m = await api.me();
      setMe(m);
      setWorkspaces(m.workspaces || []);
      setActiveWs(m.workspace?.slug || api.getWorkspace());
      setStep('workspace');
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const activateWs = (slug: string) => {
    api.setWorkspace(slug);
    setActiveWs(slug);
    setInfo(`Workspace → ${slug}`);
  };

  const createWs = async () => {
    setError('');
    setInfo('');
    const slug = newSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!slug) {
      setError('请输入 workspace slug（如 acme）');
      return;
    }
    try {
      const w = await api.createWorkspace({ slug, name: newName.trim() || slug, kind: 'company' });
      api.setWorkspace(w.slug);
      setNewSlug('');
      setNewName('');
      setWorkspaces(await api.workspaces());
      setActiveWs(w.slug);
      setInfo(`已创建 workspace「${slug}」并激活`);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const mint = async () => {
    setError('');
    setInfo('');
    setBusy(true);
    setCopied(false);
    try {
      const ws = workspaces.find((w) => w.slug === activeWs) || workspaces[0];
      const out = await api.createToken({
        name: patName.trim() || 'codex',
        scopes: ['read', 'write'],
        workspaceIds: ws ? [ws.id] : undefined,
        ttlDays: 90,
      });
      setMinted(out.token);
      setInfo('PAT 已创建 —— 只显示一次，请立即复制保存');
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const finish = () => {
    if (activeWs) api.setWorkspace(activeWs);
    onAuthed();
  };

  const wsList = workspaces.length ? workspaces : me?.workspaces || [];

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.4 20.4 7v10L12 21.6 3.6 17V7z" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="12" cy="12" r="3.1" fill="currentColor" />
            <path d="M12 8.9v6.2M8.9 12h6.2" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
          </svg>
          <span className="brand">Amem</span>
          <span className="badge">SELF-HOSTED</span>
        </div>
        <p className="auth-sub">
          {me?.authEnabled === false
            ? '本地开放模式（未开启认证），直接进入即可。'
            : '连接你的 Agent 记忆库：登录账号 → 选择 Workspace → 为 Codex / Claude 生成访问令牌。'}
        </p>

        <div className="auth-steps" aria-hidden="true">
          {STEP_LABELS.map((s) => (
            <div key={s.id} className={`auth-step ${step === s.id ? 'on' : ''}`} title={s.label} />
          ))}
        </div>

        {error && <div className="err">{error}</div>}
        {info && <div className="okmsg">{info}</div>}

        {step === 'account' && (
          <>
            <div className="auth-modes">
              <button className={`auth-mode ${mode === 'login' ? 'on' : ''}`} onClick={() => setMode('login')}>
                登录
              </button>
              <button className={`auth-mode ${mode === 'bootstrap' ? 'on' : ''}`} onClick={() => setMode('bootstrap')}>
                首次设置
              </button>
              <button className={`auth-mode ${mode === 'pat' ? 'on' : ''}`} onClick={() => setMode('pat')}>
                使用 PAT
              </button>
            </div>
            {mode !== 'pat' ? (
              <>
                <label className="muted">Email</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', marginBottom: 8 }} autoFocus />
                {mode === 'bootstrap' && (
                  <>
                    <label className="muted">Name</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
                  </>
                )}
                <label className="muted">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ width: '100%' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitAccount();
                  }}
                />
              </>
            ) : (
              <>
                <label className="muted">PAT</label>
                <input
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  placeholder="amem_pat_…"
                  style={{ width: '100%' }}
                  autoFocus
                />
                <p className="muted" style={{ marginTop: 8 }}>
                  已有令牌请粘贴到此处（Codex / CLI 场景）。
                </p>
              </>
            )}
            <div className="auth-actions">
              <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => void submitAccount()}>
                {busy ? '连接中…' : mode === 'pat' ? '验证 PAT' : mode === 'bootstrap' ? '创建账号' : '登录'}
              </button>
              {me?.authEnabled === false && (
                <button className="btn" onClick={onAuthed}>
                  直接进入
                </button>
              )}
            </div>
          </>
        )}

        {step === 'workspace' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              选择数据分区。每个 Workspace 完全隔离；Zone 可再细分项目 / 个人区域。
            </p>
            <ul className="dots" style={{ marginTop: 0 }}>
              {wsList.map((w) => (
                <li key={w.id} onClick={() => activateWs(w.slug)} style={{ cursor: 'pointer' }}>
                  <b>{w.name}</b> <span className="badge">{w.slug}</span>
                  {w.kind && <span className="badge">{w.kind}</span>}
                  {activeWs === w.slug && <span className="badge">active</span>}
                </li>
              ))}
              {wsList.length === 0 && <li className="muted">还没有 Workspace，在下方创建一个。</li>}
            </ul>
            <div className="row" style={{ marginTop: 10 }}>
              <input placeholder="slug · 如 acme" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} style={{ flex: 1 }} />
              <input placeholder="名称（可选）" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
              <button className="btn" onClick={() => void createWs()}>
                创建
              </button>
            </div>
            <div className="auth-actions">
              <button className="btn primary" style={{ flex: 1 }} onClick={() => goStep('token')}>
                下一步：生成令牌
              </button>
              <button className="btn" onClick={finish}>
                直接进入
              </button>
            </div>
          </>
        )}

        {step === 'token' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              为 Codex / Claude Code 生成最小权限令牌（当前 workspace：
              <code>{activeWs || api.getWorkspace()}</code>，scopes：<code>read write</code>，90 天有效）。
            </p>
            <div className="row">
              <input value={patName} onChange={(e) => setPatName(e.target.value)} placeholder="令牌名称 · 如 codex" style={{ flex: 1 }} />
              <button className="btn primary" disabled={busy} onClick={() => void mint()}>
                {busy ? '生成中…' : minted ? '重新生成' : '生成 PAT'}
              </button>
            </div>
            {minted && (
              <>
                <pre className="auth-token" onClick={() => void copy()} title="点击复制">
                  {minted}
                  {copied && <span className="badge" style={{ float: 'right' }}>已复制</span>}
                </pre>
                <pre className="auth-snippet">{codexSnippet(minted, baseUrl)}</pre>
                <p className="muted" style={{ fontSize: 12 }}>
                  令牌只显示一次。把配置粘贴到 <code>~/.codex/config.toml</code> 后重启 Codex 即完成接入。
                </p>
              </>
            )}
            <div className="auth-actions">
              <button className="btn primary" style={{ flex: 1 }} onClick={finish}>
                完成，进入 Amem
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
