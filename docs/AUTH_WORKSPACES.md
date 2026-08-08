# Amem 认证(oauth) + Workspace 多项目隔离 + Scope 规范 — 设计文档

> 状态：Draft（已过 4 轮自审，见文末审计日志）
> 目标版本：0.2.0（Schema v2）。本文只描述设计；实现按文末分阶段计划推进。

## 1. 背景与动机

当前 Amem 只有可选的**单一静态 token**（`AMEM_API_TOKEN`）作为访问凭证：
- 任何拿到 token 的人都能读写全部数据，无法区分身份、无法按项目隔离。
- 没有用户、没有 Workspace、没有角色/scope、没有 OAuth，不符合 MCP/插件标准的认证流程。

需求（用户原话归纳）：
1. **OAuth 认证**：标准、可委托、可撤销的认证流程，防止“随机的人就能写入”。
2. **Scope 规范**：同一套 Amem 实例里管理多个独立知识域（公司项目A / 公司项目B / 个人项目…），互不泄漏。
3. **安全认证 + Workspace 管理**：明确的安全边界、用户/角色/项目管理能力。

本设计以 **MCP OAuth 规范（Authorization Code + PKCE for Public/Local Clients）**为蓝本，同时保持 CLI/Codex(stdio) 的无浏览器体验（Personal Access Token）。

## 2. 威胁模型与目标

### 威胁模型（按风险排序）
| # | 威胁 | 缓解 |
|---|------|------|
| T1 | 未授权者写入/窃取知识（开放写入） | 所有 REST/HTTP 端点强制 Bearer；MCP HTTP 走 OAuth；stdio 走 PAT |
| T2 | 跨项目泄漏（项目A 读/写到 项目B） | workspace_id 在存储层强制过滤（纵深防御，不只在路由层） |
| T3 | token 窃取/重放 | 短时 access token + refresh 轮换 + 重用检测（撤销整个 family）；token 只存哈希 |
| T4 | 授权码复用 / PKCE 缺失 | PKCE S256 必选（public client）；code 一次性、短 TTL、绑定 redirect_uri |
| T5 | 登录 CSRF / 会话劫持 | state + PKCE + SameSite=Lax + httpOnly cookie |
| T6 | 共享静态 token 泄露后无粒度 | 弃用全局 `AMEM_API_TOKEN`，改为可撤销、可限定 workspace/scope 的 PAT |
| T7 | 密码/哈希泄露 | argon2id 密码哈希；token 用 HMAC(K, token) 存储，K 来自 `AMEM_AUTH_SECRET` |

### 目标
- 默认**认证开启**；提供显式的“明文跳过”开关仅供首次引导/本地迁移。
- 最小权限：每个凭据（PAT / OAuth token）声明 scope + 可访问的 workspace 集合。
- 可审计：关键认证与管理动作写入审计表。
- 向后兼容：既有单用户数据库自动迁移进首个用户的 personal workspace。

### 非目标（留作后续）
- 企业 IdP 联邦登录（SAML/OIDC 委托）— 后续可加，不改变本设计的 token 模型。
- Device Authorization Grant（headless CLI 无浏览器时）— 列为 Phase 3+ 的 stretch。
- JWT 无状态 token — 自托管用**不透明 token + DB 校验**，天然可即时吊销，避免密钥分发问题。

## 3. 认证模型

两条凭据族，令牌统一为“不透明 + 哈希存储 + 可吊销”：

### 3.1 OAuth 2.1 授权服务器（交互式 / MCP HTTP）
提供标准端点（RFC 8414 metadata + RFC 6749/7636）：
- `GET /.well-known/oauth-authorization-server` → 元数据
- `GET /oauth/authorize`（鉴权/同意，基于 cookie 会话）
- `POST /oauth/token`（Authorization Code + PKCE(S256)；Refresh 轮换）
- `POST /oauth/revoke`
- （Phase 3 stretch）device authorization + verification

客户端类型：
- **public client**（MCP 桌面端/网页）→ 必须 PKCE S256，不使用 client_secret。
- **confidential client**（自建脚本/后端）→ 可选 client_secret（哈希存储）。
- 自带 Web UI 使用一个内置 public client（cookie 会话 + 可选 OAuth 自举）。

### 3.2 Personal Access Token（Codex / CLI / curl / stdio MCP）
- 用户在 Web UI 或 `amem auth token create` 创建：`amem_pat_` 前缀、名称、scopes、可绑定的 workspace、有效期。
- 明文只在创建时展示一次；DB 只存 `HMAC-SHA256(AMEM_AUTH_SECRET, token)`。
- 校验：`Authorization: Bearer <pat>` 或 MCP stdio 环境变量 `AMEM_API_TOKEN`。
- 可随时 `revoke`；`last_used_at` 用于审计。

### 3.3 资源服务器校验（同一套逻辑）
- 解析 principal = `{ userId, realm: 'user' }`；legacy token 解析为 `realm:'legacy'`（见 §6.5 迁移）。
- 从 principal 得到可访问 workspace 集合与角色，再与凭据声明的 scopes 求交，得出**生效权限**：
  `effective = tokenScopes ∩ permission(user, workspace)`。
- 所有 read/write 数据端点把 `workspace`（默认 principal 的 personal workspace）作为强制上下文。

### 3.4 会话（Web UI）
- HttpOnly + SameSite=Lax cookie 会话（HMAC 签名，TTL 可配）。
- 登录可加 rate-limit（登录端点 + token 端点），防爆破。

## 4. Scope 规范（canonical）

统一为小写字符串，冒号分层：

| Scope | 含义 |
|-------|------|
| `read` | 读取 principal 有权限的全部 workspace |
| `write` | 在 principal 有权限的 workspace 内写单元/链接/导入 |
| `admin` | 管理用户、workspace、成员角色、token、OAuth client |
| `ws:<slug>:read` | 仅读取指定 workspace |
| `ws:<slug>:write` | 仅写入指定 workspace（隐含该 ws 的 read） |

规则：
- `ws:*` 是**工作区级最小权限**（公司项目A 的 PAT 只带 `ws:company-a:write`，就完全看不到公司项目B / 个人项目）。
- `read`/`write` 是全局门面；`admin` 独立。
- **MCP 工具 → scope 映射**（同 REST）：
  - 读工具（`recall`/`search`/`get_unit`/`list_units`/`get_graph`/`working_memory`/`stats`/`export`/`get_links`）→ 需 `read` 或 `ws:<x>:read`
  - 写工具（`ingest`/`save_unit`/`update_unit`/`delete_unit`/`link_units`/`import`）→ 需 `write` 或 `ws:<x>:write`
  - 治理工具（`review_unit`/`forget`/`curate`）→ 需 `write`（当前 workspace）
  - `admin` 作用在管理 API 上（users/workspaces/members/tokens/clients）
- OAuth 授权时按 client 声明 + 用户同意结果发放 scope；PAT 创建时由用户声明。

## 5. Workspace（项目）模型

- `Workspace` = 一个知识域（“公司项目A”“公司项目B”“个人项目”各一个）。
- 字段：`id`、`slug`(唯一，用于 URL/MCP 配置)、`name`、`kind('personal'|'company')`、`owner_user_id`、`created_at/updated_at`、`labels`(JSON)。
- **Personal workspace**：每个用户首次进入时自动创建（`kind=personal`）；只能自己访问。
- **Company workspace**：admin/owner 创建；通过 membership 添加用户。
- 成员角色：`owner > admin > member(读写) > reader(只读)`。
- 数据隔离：units/links/traces/sessions/sources/versions 全部带 `workspace_id`，**在 Storage 层过滤**（防御纵深：即使路由漏过滤，存储层也挡住）。

### 5.1 隔离的生效位置（三层）
1. 路由层：把 `workspace` 上下文传给 service。
2. Service 层：调用 storage 时显式带 `workspaceId`。
3. Storage 层：所有查询强制 `WHERE workspace_id = ?`（通过方法签名，非可变全局状态）。

### 5.2 兼容性
- 现有单用户库 → 迁移时创建缺省 personal workspace（slug=`personal`），旧数据全部归入。
- 未指定 workspace 的请求默认 principal 的 personal workspace。

## 6. 数据模型变更（Schema v2）

利用现有 `SCHEMA_VERSION` + `MIGRATIONS` 机制追加 `MIGRATIONS[1]`，全部 `IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS`（SQLite 3.35+ 支持 ADD COLUMN IF NOT EXISTS；better-sqlite3 自带版本满足）。

### 6.1 新表
```sql
users(id TEXT PK, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      name TEXT, realm TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

workspaces(id TEXT PK, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
           kind TEXT NOT NULL CHECK(kind IN ('personal','company')),
           owner_user_id TEXT NOT NULL REFERENCES users(id),
           labels TEXT NOT NULL DEFAULT '{}',
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

workspace_members(workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                  user_id TEXT NOT NULL REFERENCES users(id),
                  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','reader')),
                  created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, user_id));

oauth_clients(client_id TEXT PK, client_name TEXT NOT NULL,
              client_secret_hash TEXT, redirect_uris TEXT NOT NULL DEFAULT '[]',
              grants TEXT NOT NULL DEFAULT '[]', scopes TEXT NOT NULL DEFAULT '[]',
              owner_user_id TEXT REFERENCES users(id), created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL);

oauth_codes(code_hash TEXT PK, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
            scopes TEXT NOT NULL DEFAULT '[]', redirect_uri TEXT NOT NULL,
            code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL DEFAULT 'S256',
            expires_at TEXT NOT NULL, used_at TEXT);

oauth_tokens(id TEXT PK, token_hash TEXT UNIQUE NOT NULL,
             client_id TEXT, user_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('access','refresh')),
             scopes TEXT NOT NULL DEFAULT '[]', workspace_ids TEXT NOT NULL DEFAULT '[]',
             expires_at TEXT NOT NULL, family_id TEXT NOT NULL, revoked_at TEXT);

api_tokens(id TEXT PK, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
           user_id TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]',
           workspace_ids TEXT NOT NULL DEFAULT '[]',
           created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT, revoked_at TEXT);

audit_log(id TEXT PK, actor_kind TEXT NOT NULL, actor_id TEXT,
          action TEXT NOT NULL, target TEXT, meta TEXT, created_at TEXT NOT NULL);
```
索引：`workspaces(slug)`、`workspace_members(user_id)`、`oauth_tokens(family_id)`、`api_tokens(user_id)`。

### 6.2 既有表加列（数据均指向个人/缺省 workspace）
`units.workspace_id`、`links.workspace_id`、`traces.workspace_id`、`sessions.workspace_id`、`sources.workspace_id`、`versions.workspace_id`（各建索引）。
- `units_fts` 通过 `JOIN units ON units.rowid = units_fts.rowid` 过滤 workspace，保证 FTS 也隔离。

### 6.3 关键算法
- **token 哈希**：`H = HMAC-SHA256(AMEM_AUTH_SECRET, token)`；校验用 constant-time compare。
- **密码哈希**：argon2id（`@node-rs/argon2`，与 better-sqlite3 同属预构建原生依赖，Docker 已可用）。
- **refresh 轮换**：每次 refresh 发新 access+refresh，旧 refresh 标记已用；若收到已用过的 refresh ⇒ 视为泄露，撤销整个 family。

### 6.4 配置变更（`.env.example` / `configFromEnv`）
| 变量 | 说明 |
|------|------|
| `AMEM_AUTH_ENABLED` | 默认 `true`；`false` = 明文跳过（仅供本地/迁移） |
| `AMEM_AUTH_SECRET` | 必填（启用认证时）；≥32 字节随机；用于 token HMAC 与会话签名 |
| `AMEM_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` | 首次启动创建 admin（若 auth 启用且无用户） |
| `AMEM_PAT_DEFAULT_TTL_DAYS` | 默认 90 |
| `AMEM_ACCESS_TOKEN_TTL` / `AMEM_REFRESH_TOKEN_TTL` | 默认 15m / 30d |
| `AMEM_COOKIE_SECURE` | 反代 TLS 后设 true |
| `AMEM_ALLOW_LEGACY_API_TOKEN` | 迁移期兼容旧单 token，默认 true（Phase 1 后默认 false） |

### 6.5 Legacy `AMEM_API_TOKEN` 迁移策略
- Phase 1 默认：`AMEM_API_TOKEN` 仍可用，映射为 `realm:'legacy'` principal → 拥有全 workspace 的读+写（不自动含 admin）。
- 用户首次以 admin 创建真正账号 + PAT 后，建议关闭 `AMEM_ALLOW_LEGACY_API_TOKEN`。
- 文档提供一键迁移指南。

## 7. API 变更

### 7.1 认证管理（REST，需 user 登录/admin）
- `POST /api/v1/auth/login`（email+password → session cookie）
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/tokens`（创建 PAT，返回一次明文）→ `{token, scopes, workspaceIds, name, expiresAt}`
- `GET /api/v1/auth/tokens`、`DELETE /api/v1/auth/tokens/:id`
- `GET /api/v1/me`（当前 principal 概览 + 可访问 workspace + 生效 scopes）

### 7.2 OAuth 端点（公开）
- `GET /.well-known/oauth-authorization-server`
- `GET /oauth/authorize` → 登录/同意后 302 到 redirect_uri（含 code）
- `POST /oauth/token`（code→token、refresh→token）
- `POST /oauth/revoke`
- MCP HTTP 客户端用 OpenAPI/MCP SDK 能力自动发现上述端点。

### 7.3 Workspace 管理（需对应角色）
- `GET /api/v1/workspaces`；`POST /api/v1/workspaces`
- `GET/PATCH/DELETE /api/v1/workspaces/:id`
- `GET /api/v1/workspaces/:id/members`；`PUT/DELETE /api/v1/workspaces/:id/members/:userId`（角色变更）
- 数据端点统一支持 `?workspace=<id|slug>`（默认 principal.personal）。

## 8. MCP 集成（stdio 与 HTTP 的两条路径）

### 8.1 stdio（本机，Codex/Claude Code）
- 本机默认可信传输；用 **PAT + workspace** 明确身份与项目：
```toml
[mcp_servers."amem"]
type = "stdio"
command = "node"
args = [".../packages/mcp/dist/cli.js"]
[mcp_servers."amem".env]
AMEM_API_TOKEN = "amem_pat_..."
AMEM_WORKSPACE = "company-a"      # slug；省略 = 个人 workspace
AMEM_DB_PATH = ".../amem.db"
```
- 每个工具执行前做与 REST 相同的 scope/workspace 校验（`ingest` 需 `ws:company-a:write`；`recall` 需对应 read）。

### 8.2 HTTP（streamable，远程/局域网）
- 服务端在 MCP capabilities 暴露 `authorizationServer` 指向 `/.well-known/oauth-authorization-server`（MCP 修订版规范），支持 Authorization Code + PKCE。
- 工具与 stdio 完全一致；token 由授权服务器发放、资源服务器校验。

## 9. 安全要点（实现验收标准）
- [x] public client 强制 PKCE S256；错误 PKCE 必拒绝（`verifyPkce`，测试覆盖）。
- [x] 授权码一次性、TTL≤10min、绑定 redirect_uri；复用即作废（`consumeOauthCode`，测试覆盖）。
- [x] refresh 轮换 + family 重用检测（测试覆盖）。
- [x] 所有 token 只存 HMAC 哈希；PAT 前缀可扫描（`amem_pat_`）。
- [x] workspace 过滤至少两层（路由 scope 校验 + 存储层 ALS 过滤，测试覆盖）。
- [x] 登录/token 端点限流（`packages/server/src/rateLimit.ts`，滑窗按 IP+端点）；constant-time 比较。
- [x] cookie：httpOnly、SameSite=Lax、可选 Secure（`AMEM_COOKIE_SECURE`）。
- [x] 审计日志：登录成功/失败（`auth_login` / `auth_login_failed`）、token 创建/吊销、成员/角色变更（`events` 表）。
- [x] 旧的全局 `AMEM_API_TOKEN` 迁移后默认关闭（auth 开启时未显式设置即拒绝 legacy token）。

## 10. 测试计划（新增用例覆盖设计）
- Auth 单元：token hash/校验、scope 交集、constant-time。
- OAuth 集成（Fastify inject）：metadata、authorize+PKCE 成功、PKCE 不匹配 400、code 复用 401、refresh 轮换成功、refresh 重用→整 family 吊销、revoke。
- PAT：创建只返回一次明文、Bearer 校验、过期/吊销、scope 不足 403、跨 workspace 403（`ws:company-a` 读不到 `company-b`）。
- Workspace：CRUD、成员角色、owner 删除、个人 workspace 自动创建、旧库迁移（数据进入 personal）。
- 回归：现有 42 个测试在 auth 关闭（测试模式默认）下全绿；开启 auth 的专用 suite 独立跑。

## 11. 分阶段实现计划

| 阶段 | 内容 | 验收 | 预估 |
|------|------|------|------|
| **P0 数据层** | Schema v2（用户/workspace/members/oauth/tokens/audit + workspace_id 列）＋Workspace-scoped Storage 接口改造＋单库迁移 | db 测试覆盖迁移幂等 + workspace 过滤 | 小 |
| **P1 身份** | 用户/登录会话/PAT（创建·列表·吊销）＋REST+stdio 全量 bearer 与 workspace 解析 ＋ legacy token 兼容 | 新 auth 测试 + 全回归绿 | 中 |
| **P2 OAuth** | 授权服务器（metadata/authorize+PKCE/token/refresh 轮换+重用检测/revoke）＋Web 登录/同意页 ＋ MCP HTTP 接 OAuth | OAuth 安全测试全过 | 大 |
| **P3 治理** | Workspaces CRUD/成员/角色、MCP 工具 scope 面板、Web UI 管理页、docs+`.env.example`+docker env、迁移指南 | 完整手测路径 + 文档 | 中 |

## 12. 审计日志（Paul 式… 本机自审 ≥3 轮）

### 审计 #1（范围/完整性）
- 发现：① 漏了 OAuth 重复发 refresh 的 family 设计细节 → 已补 §6.3；② 原设计漏了 FTS 隔离 → 已补 §6.2；③ legacy token 会静默扩大面 → 增加 `AMEM_ALLOW_LEGACY_API_TOKEN` 开关并默认迁移后关（§6.5）。
- 决议：接受 T3/T4 缓解即为验收项（§9）。

### 审计 #2（实现可行性与向后兼容）
- 发现：① `Storage` 接口是全量方法签名改造，属于 public API 破坏 → 保留旧签名并新增 `workspaceId` 可选参数（默认 personal），避免每个调用点都改；② `configFromEnv` 的 `apiToken` 字段保留为 legacy 兼容；③ 测试模式（FakeStorage）需同步补 `workspaceId` 支持，避免 42 个回归全崩。
- 决议：Storage 层向前兼容 + 测试最小改动。

### 审计 #3（安全纵深 + 部署）
- 发现：① 密码哈希选型：`@node-rs/argon2` 原生依赖与 better-sqlite3 同类，Docker 构建已验证原生依赖可行 → 选定 argon2id；② token 端点需要限流，避免离线爆破纯文本 PAT（虽然只存 HMAC，但枚举 64bit+ 前缀空间不现实 → 限流仍必要）；③ 反向代理后需 `AMEM_COOKIE_SECURE` 与可信代理头，文档已列入；④ `AMEM_AUTH_SECRET` 变更会使所有旧 token 失效 → 文档明示“更换 secret = 全员重新登录”。
- 决议：采纳全部；新增 `audit_log` 表（原设计只靠 jobs 太隐晦）。

### 审计 #4（范围收敛与优先级）
- 发现岗位：company 多用户邀请、device flow、OIDC 联邦、按资源粒度的 MCP OAuth scopes（resource-scoped requests）都属“锦上添花”，会显著拉长首个可用版本。
- 决议：全部移入后续 backlog；首个发布版 = P0–P3 已验证可行闭环。§10 测试计划足以支撑“能用于真实生产”的验收标准。

---

## 附录 A · `amem setup` 安装向导设计

> 追加于 0.2 计划。目标：用户用一条命令/一个页面，完成 Amem 与 Codex / Claude Code 的集成（MCP + hook + 提示文件 + workspace + 最小权限 PAT），可验证、可卸载。

### A.1 目标与原则
- **一个核心逻辑，三种前端**：`@amem/setup` 只做纯逻辑（detect / plan / apply / verify / uninstall），CLI、Web、未来 Desktop App 都是它的前端。
- **按“谁拥有配置”分权**（安全边界）：
  - Amem 自己的配置（用户/workspace/PAT/OAuth/供应商/阈值/备份）→ **Web/App 管理台**。
  - 外部工具的文件（`~/.codex/config.toml`、`~/.codex/hooks.json`、`~/.claude.json`、`.mcp.json`、`AGENTS.md`/`CLAUDE.md`）→ **只能本机改，由 CLI 或本地桥驱动**；**远程 Web 禁止直接写用户本机文件**（生成可执行脚本下发）。
- 默认**hybrid 记忆模式**：hook 每轮自动 ingest + MCP 工具手动补细节。

### A.2 三种前端与职责
| 表面 | 能做什么 | 实现 |
|------|----------|------|
| `amem setup`（CLI） | 接入/移除 Codex·Claude：写/删 MCP 配置、hooks、提示文件；自动建 workspace + 发最小权限 PAT（`ws:<slug>:write`）；`--check` 验证、`--uninstall` 撤销 | 薄包装 `@amem/setup` |
| Web setup | 首启建 admin、workspace/成员/角色、PAT、OAuth client、供应商、备份导出；集成状态页（已接/未接，基于 hook 心跳与 last_seen）+ 一键复制脚本/命令 | 复用核心只读/出配置部分 |
| 未来 Desktop App | 同时具备两者能力（有本机文件访问权），但**一律经本地桥（本机绑定的 local API）调同一核心**，不在 App 内另写一份 | 本地桥 API + 同一核心 |

### A.3 `@amem/setup` 核心（纯逻辑，可测试）
```
detect()   -> { codex: { mcp?, hooks? }, claude: { mcp?, hooks? } }   // 现状探测
plan()     -> Change[]                                                // 预览将要写什么（类似 terraform plan）
apply()    -> Result[]                                                // 幂等应用
verify()   -> { toolsLoaded, canIngest }                              // 握手 + 试写一条 + 回读
uninstall()-> Result[]                                                // 干净撤销，不碰用户已有项
```
- 所有改动为纯函数（输入：当前文件内容 + 目标；输出：新内容），单元可测。
- **幂等**：重复运行不产生重复条目；**不覆盖**：合并 `hooks.json` 时保留用户已有 hook（如现有 `PreToolUse/Bash → rtk-rewrite.sh`）。

### A.4 各落盘目标
- **Codex 全局**：追加 `[mcp_servers."amem"]` 到 `~/.codex/config.toml`；合并 `~/.codex/hooks.json` 加 `Stop`；`[hooks.state]` 信任哈希登记。
- **Codex 项目**：`./.codex/hooks.json`（Stop hook）+ 写入 `./AGENTS.md`“每轮结束用 amem ingest 提炼要点”。
- **Claude Code 全局**：`claude mcp add amem`（存 `~/.claude.json`）；hooks 进 `~/.claude/settings.json`。
- **Claude Code 项目**：`./.mcp.json` + `.claude/settings.json` hooks + `./CLAUDE.md` 提示。
- hook 脚本统一入口：`amem-hook`（本机 `POST /api/v1/ingest` 或 MCP），按 **cwd/项目名 → workspace** 分流，过滤噪音。

### A.5 CLI 签名与交互流程
```
amem setup --target codex|claude|all --scope global|project \
           --mode auto|manual|hybrid --workspace <slug> [--dir <path>]
amem setup --check    # 验证并返回“通了没”
amem setup --uninstall --target codex --scope project --dir .
```
向导流程：选择目标/范围/模式 → 自动建 workspace（若缺）+ 发 PAT（最小权限）→ 预览改动（`--dry-run`）→ 应用 → `--check` 验证 → 打印一句“已接入”。

### A.6 Web 集成页
- 状态：Codex/Claude 是否已接（hook 心跳 `last_seen`）、MCP 是否注册、能否写入。
- 操作：生成 `amem setup --target … --scope … --workspace …` 一行命令或下载脚本；不做远程写本机文件。

### A.7 未来 App 的本地桥
- 预留 `POST /local/setup/plan|apply|verify|uninstall`（仅绑定 `127.0.0.1` + 本地 PAT 鉴权）。
- App 只调本地桥，不直改文件；桥内部复用 `@amem/setup`。

### A.8 测试计划
- 核心单测：detect/plan/apply 幂等、不覆盖用户已有 hook、合并正确性。
- 集成：临时 HOME 下完整装/卸载 Codex 与 Claude 配置；`--check` 握手。
- 安全：hook 只发当轮输入+回复（不 dump 全文）；PAT 默认 `ws:<slug>:write` 最小权限；本地桥拒绝非回环来源。

### A.9 阶段归属
- 加入 0.2 计划为 **P4（setup 向导）**：依赖 P0–P3（auth/workspace 先行），依次交付 `@amem/setup` 核心 → CLI → Web 集成页 → 本地桥（App 预留）。
