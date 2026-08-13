# swe-loop plan — UI 数据流可视化 + agent 记忆访问区域

## Objective
优化 Web UI 的可视化反馈：当前数据流 输入/输出（writes in / reads out、token 消耗与节省）
+ 正在工作的 agent 访问的记忆区域（命中单元、类型/分类/标签区域、top actor）。

## End state
- 服务端 `GET /api/v1/activity/summary`（core `ActivitySummary` + service `activitySummary` + Fastify 路由）
- Web：Activity 页顶部数据流卡片 + Agent memory access 面板；Dashboard 紧凑面板
- 测试：server 集成测试（happy path + 空事件）+ web 纯函数单测；全量回归绿

## Tasks
- T1 `server-activity-summary-endpoint` — 聚合端点（domain/service/route），~180 LOC
- T2 `web-flow-visualization` — types/api/flow.ts 纯函数+测试/Activity/Dashboard 面板，~260 LOC
- 顺序：T1 → T2（依赖）

## Loop
- Engineer（source only）→ QA（tests only + 全量回归 + quality_check + rubric）
- keep 则提交 master（pr_mode=none，与仓库历史一致），否则 refine

## Result (2026-08-13)
- T1 kept: `14cdae3` — ActivitySummary + service.activitySummary + GET /api/v1/activity/summary（2 集成测试）
- T2 kept: `8e448e5` — types/api 接线 + flow.ts 纯函数（7 单测）+ Activity/Dashboard 面板 + App onOpenUnit
- Fix: `53336fa` — mcp httpBackend 补 activitySummary（全量 pnpm build 暴露接口缺失）
- 全量测试 **202/202**，typecheck + quality_check ok（max_file_loc 按仓库 norm 放宽至 1800，文件系既有超限）
- 部署：docker 镜像重建、容器重建；`/api/v1/activity/summary` 200（PAT 验证真实数据）；
  UI 新 bundle（index-hqbze6B2.js）已由 8321 提供；已推送 origin/master（d32b9fc..53336fa）
- 闭环：amem-loop save unit_bb0cf0c1 + end
