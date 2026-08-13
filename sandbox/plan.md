# Zone（项目分区）子系统 — 实施计划

## Objective
在 Amem 现有 `account → workspace → 记忆/知识` 之上增加 **zone** 层：自动把不同项目/域的知识分入对应 zone（`personal` / `shared` / `project` / `inbox`），zone 级 ACL 隔离（同 workspace 下不同用户访问不同 zone，存储层强制），recall/search 自动路由到最相关 zone（默认严格隔离、不穿台），并支持 PDF/md/txt 文件导入自动成知识。

## End state（Definition of Done）
- Schema v15：`zones` / `zone_members` 表 + `units.zone_id`，迁移平滑、默认 zone 种子（每 workspace `z_inbox` + `z_shared`，每成员 `z_personal_<userId>`）。
- 写入自动分区：显式 zone > 规则 > 嵌入质心 > LLM > inbox；周期重算质心并提议新 zone（UI 确认）。
- Zone ACL 存储层强制（`accessibleZoneIds`）：A/B 个人 zone 互不可见、shared 全成员可见；token scope 保持 workspace 级。
- recall / search / recall_layered：支持 `zone` 参数与 `crossZone`（默认 false），结果带 zone 标注。
- REST `/api/v1/zones*` + MCP 工具（`AMEM_WORKSPACE` / `AMEM_ZONE`）可用。
- Web：zones 管理页、zone 筛选器、Review 文件导入、单元 zone 徽标/迁移。
- 现有全部测试保持绿；docker compose 含新环境变量。

## Non-goals
- 不做跨 workspace 共享；不做 docx/pptx 解析；不在 PAT scope 增加 zone 级 scope；不做 zone 自动合并/分裂重写；不改动现有 `labels.category` 分类体系。

## Environment
- pnpm monorepo：`apps/web`（React+Vite）、`packages/core` / `db` / `server` / `mcp`，全 vitest。
- 关键锚点：`packages/db/src/schema.ts`（SCHEMA_VERSION=14 → 15）、`packages/db/src/storage.ts`（`SqliteStorage` + `currentWorkspaceId()`）、`packages/core/src/requestContext.ts`（ALS 上下文）、`packages/core/src/recall.ts` / `layeredRecall.ts` / `classify.ts` / `importer.ts`、`packages/server/src/server.ts`（`/api/v1` 插件）+ `authContext.ts`、`packages/mcp/src/tools.ts` / `server.ts`、`apps/web/src/api.ts` / `router.ts` / `views/*`。
- 测试命令：`pnpm test`（等价逐包 vitest run），冒烟 `tools/smoke.mjs`。

## Components
| id | name | 说明 |
|---|---|---|
| c1 | zones-data | Schema v15 + 迁移 + 默认种子 |
| c2 | zone-acl | 成员 ACL + 请求上下文 zoneIds + 存储层过滤 |
| c3 | zone-assign | 自动分区引擎（规则/质心/LLM/inbox）+ 提议 |
| c4 | recall-scope | recall/search 路由 + crossZone + 标注 |
| c5 | file-ingest | PDF/md/txt 导入管线 |
| c6 | api-mcp | REST /zones* + MCP zone 面 |
| c7 | web-zones | 管理页 + 筛选器 + 导入 UI |
| c8 | docs-verify | 文档 + docker env + 全量验证 |

## Tasks（按执行顺序）
| id | title | serves | depends_on | est. LOC |
|---|---|---|---|---|
| T1 | Schema v15：zones/zone_members + units.zone_id + 种子 | c1 | — | 240 |
| T2 | Zone 存储方法：SqliteStorage + Storage 接口 | c1, c2 | T1 | 300 |
| T3 | 请求上下文 zone 过滤（存储层强制 ACL） | c2 | T2 | 260 |
| T4 | zones 服务 + 自动分区引擎 | c3 | T3 | 320 |
| T5 | recall/search zone 路由与标注 | c4 | T3, T4 | 260 |
| T6 | REST /zones* 路由 + 鉴权上下文 zone 解析 | c6 | T3, T4 | 260 |
| T8 | 文件导入管线（pdf/md/txt） | c5 | T4 | 320 |
| T7 | MCP zone 工具面 | c6 | T5, T6 | 220 |
| T9 | Web zones 管理页 | c7 | T6 | 380 |
| T10 | Web zone 筛选器 + 单元徽标/迁移 | c7 | T9 | 260 |
| T11 | Web Review 文件导入 UI | c7 | T8, T9 | 180 |
| T12 | 文档 + docker env + 全量验证 | c8 | T10, T11 | 150 |

总计 ≈ 3150 LOC，12 个 PR 级任务。

## 关键设计决策
- **Zone = workspace 内的子 workspace（项目空间）**：组织维度（知识自动关联到项目）+ 权限维度（同 workspace 下 A/B 访问不同 zone）。
- **权限只走 `zone_members` + personal 归属 + shared 全员**，PAT token scope 保持 workspace 级（`ws:<slug>:read/write`），避免 scope 爆炸。
- **种子 zone id 用确定性格式**：`z_inbox_<workspaceId>` / `z_shared_<workspaceId>` / `z_personal_<userId>`（`zones.id` 是全局 PK，禁止裸 `z_inbox`）；迁移后对悬空 `zone_id` 的旧 units 回填到本 workspace 的 inbox 行（幂等）。
- **inbox/shared 可见性**：`z_inbox`/`z_shared` 显式 `visibility='workspace'`；`getZoneAccess` 规则 = 个人自有（owner）+ `visibility='workspace'`（含 inbox/shared）+ 显式 `zone_members` 三类，保证迁移后的 legacy units 对全成员可见。
- **存储层强制**：`RequestContext.zoneIds` 由 authContext 注入，storage 查询统一追加 `zone_id IN (...)`；legacy（无 userId）默认全 zone 兼容。links 无 zone_id，过滤用"任一端可达（OR 子查询）"语义；assets 在自身 visibility 之上 AND zone 过滤。
- **自动分区优先级**：显式 zone > 规则（tags/source kind/category）> 嵌入质心（cosine > 0.6，offline 跳过）> LLM 一次性分类 > `z_inbox` 兜底。
- **recall 不穿台**：默认 `crossZone=false`，仅可访问 zone 内检索；自动路由命中高分 zone 时用 `runWithRequestContextAsync` 收窄到单 zone。
- **文件导入**：上传 → 提取文本（pdf-parse / 直接读文本）→ 分块（1500 字符/150 重叠）→ 按 content_hash 去重建 source + trace + pending units → 自动 zone → Review 确认。
- **MCP 作用域**：`AMEM_ZONE` → `ctx.zoneIds` → 存储层过滤，未加显式 zone 参数的读工具（get_graph/working_memory/get_unit 等）自动生效；`link_units` 校验端点 unit 可达。

## Risks / Open questions
1. 已有 units 迁移后全部进 `z_inbox` 再跑一次 auto-assign（默认）；回填与可见性已由 T1/T4 覆盖。
2. embedding offline 时质心路由降级为 规则+关键词+LLM（默认）。
3. 新聚类 zone 需 UI 人工确认后生效（默认）。

## How to execute
以 `sandbox/tasks.json` 为准，按 `order` 逐任务执行（每任务含 files/subtasks/tests/acceptance_criteria）；每个任务保持现有测试全绿，最后 T12 统一跑 `pnpm test` + `pnpm build` + `tools/smoke.mjs` + docker compose 冒烟。
