# Zones — 知识分区与隔离

Amem 的存储层级是 **Account → Workspace → Zone → Unit（记忆/知识）**。
Zone 是 workspace 内的**逻辑分区**：一个公司 workspace 下可以有
`backend`、`frontend`、`research` 等 project zone，也有每个成员一个
`personal` zone、以及全 workspace 可见的 `inbox` / `shared`。

Zone 解决三个问题：

1. **自动分区** — 新写入的知识自动归属到最相关的分区，而不是堆在一起。
2. **访问隔离** — 同 workspace 下不同账号看到不同的 zone（A 的个人 zone
   B 不可见，shared 全成员可见，project zone 按成员 ACL）。
3. **上下文路由** — recall/search 默认只在可访问且最相关的 zone 内检索，
   避免无关项目污染上下文、浪费 token。

## Zone 类型

| kind | 可见性 | 说明 |
|------|--------|------|
| `inbox` | workspace | 每个 workspace 一个；自动分区未命中时的兜底（等待整理） |
| `shared` | workspace | 全 workspace 成员可读写 |
| `personal` | private | 每个成员一个；仅本人可见（owner_user_id） |
| `project` | members | 显式成员 ACL（owner/editor/reader），如 `backend`、`research` |

每个 workspace 创建时自动 seed `inbox` / `shared` / 每个成员的 `personal`。

## 自动分区（写入路由）

新 unit 写入时的分区解析顺序：

1. **显式 zone**（`zone` / `zoneId` 参数，id 或 slug）— 最高优先；若请求
   上下文已锁定 zone 集合，目标不在其中则 **403**（防止写入他人分区）。
2. **会话 zone 作用域**（`AMEM_ZONE` 环境变量 / `x-amem-zone` 请求头）—
   调用方显式声明工作在哪个分区，未带 zone 的新写入直接进入该分区。
3. **规则**（tags / category / title 与 zone slug/name 的匹配，阈值 3 分）。
4. **嵌入质心**（`embeddingMode=api` 时，对 zone 质心做 cosine ≥ 0.6）。
5. **LLM 分类**（配置了 LLM 时，best-effort，失败不阻塞写入）。
6. **inbox 兜底** — 未命中的记忆进入 inbox，等待后续整理/人工确认。

更新已有 unit 时保持原 zone；只有新建写入才参与自动分区。

## 读取路由（recall / search）

- 默认（`crossZone` 未开启）：recall 自动路由到当前会话最相关的 zone
  （基于查询与 zone 描述的匹配），**不做跨分区检索** — 公司 A 的会话
  不会把公司 B 的记忆塞进上下文。
- `crossZone: true`：跳过自动路由，在**所有可访问**的 zone 内检索
  （适合跨项目综合类问题）。
- `zone` 参数：显式钉在某个分区。
- 带 zone 作用域的请求（`AMEM_ZONE` / `x-amem-zone`）其**所有**读工具
  （`get_graph`、`working_memory`、`list_units`、`get_unit`、`activity`、
  `stats` 等）都在该分区内过滤 — 由存储层强制，不是靠每个工具加参数。

结果中的每个 unit 都带 `zoneId`，可据此在 UI 上着色/分组。

## 访问控制（ACL）

zone 级 ACL 在**存储层强制**（SQL 层 `zone_id IN (...)` 过滤），不是 UI
层面的隐藏。可访问集合：

1. 自己的 `personal` zone（owner）。
2. 所有 `visibility='workspace'` 的 zone（inbox / shared）。
3. 自己是成员的 `project` zone。

无用户身份（legacy/anonymous）时只看到 workspace 可见 zone（向后兼容）。
`x-amem-zone` / `AMEM_ZONE` 指向不可访问或不存在 zone 时**直接拒绝**
（403 / 启动失败），绝不静默回退到全量可见。

## 环境变量与请求头

| 配置 | 生效范围 | 说明 |
|------|----------|------|
| `AMEM_WORKSPACE` | MCP stdio（server 进程） | 默认 workspace slug，默认 `personal` |
| `AMEM_ZONE` | MCP stdio（server 进程） | 默认 zone（id 或 slug）；设置后所有工具在该 zone 内读写；解析失败则启动即报错 |
| `x-amem-workspace` | REST 请求头 | 选择 workspace |
| `x-amem-zone` | REST 请求头 | 单请求的 zone 作用域；不可访问 → 403 |

Docker compose 会把 `.env` 中的 `AMEM_WORKSPACE` / `AMEM_ZONE` 透传给容器。

## API 参考

- `GET /api/v1/zones` — 当前用户可访问的 zone（含成员数/单元数）
- `POST /api/v1/zones` — 创建 project zone（`{ slug, name, kind, visibility }`）
- `PATCH /api/v1/zones/:id` — 改名/描述
- `DELETE /api/v1/zones/:id` — 删除（非空 409，需先迁移单元）
- `GET/POST/DELETE /api/v1/zones/:id/members` — 成员管理
- `POST /api/v1/zones/recompute` — 重算各 zone 嵌入质心
- `POST /api/v1/zones/proposals` — 质心聚类提议新 zone（人工确认）
- `POST /api/v1/units/:id/zone` — 把单元迁移到另一个 zone

`/ingest`、`/recall`、`/recall/layered`、`/search`、`/units` 接受 `zone`
参数；recall 系与 search 另接受 `crossZone`。

## 文件导入

- `POST /api/v1/ingest/file` — 单文件导入（Web Review 上传区使用）：
  `{ filename, contentBase64, extract?, zone? }`。`.pdf` 走 unpdf 文本层
  提取（扫描件自动降级 OCR，需配置 `AMEM_OCR_*`）；md/txt 作为文本 trace
  直接蒸馏成 unit。zone 缺省时按自动分区规则落位（inbox）。
- `POST /api/v1/import/pdf` — 等价 PDF 专用端点（JSON base64）。
- `POST /api/v1/import/directory` — 服务端路径批量导入 md/txt。
- 结果返回 `ImportSourcesResult`（units/traces/links/sources/files +
  ocrPages），Review 页即时显示批次反馈。

## MCP 参考

- `ingest` / `save_unit` / `list_units`：`zone`（id 或 slug）
- `recall` / `recall_layered` / `search`：`zone` + `crossZone`
- 其余读工具通过 `AMEM_ZONE` → 请求上下文 → 存储层过滤自动生效

## 自动整理

- `POST /api/v1/zones/recompute`（或后台任务周期）重算 zone 质心，
  让嵌入路由持续准确。
- 质心聚类发现的密集新簇会作为 **proposal** 出现在 Web 管理页，
  人工确认后生成新 project zone。
- inbox 中的未分类记忆可通过 Web UI 或 `POST /api/v1/units/:id/zone`
  一键迁移到正确分区。

## 数据模型

`zones`（id, workspace_id, slug, name, kind, owner_user_id, visibility,
embedding_centroid, auto, status, created_at, updated_at，
UNIQUE(workspace_id, slug)）+ `zone_members`（zone_id, user_id, role,
created_at）+ `units.zone_id` 索引。详见 `docs/DATA_MODEL.md`。
