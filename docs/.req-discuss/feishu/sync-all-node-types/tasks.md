# sync 同步所有类型节点 任务清单

> 基于 `discuss.md` 方案 A 拆解。所有路径相对仓库根目录 `/Users/duoli/Projects/duoli-wulicode/cmd4bun`。

## 任务状态

- [ ] 待开始
- [~] 进行中
- [x] 已完成

## Agent 执行约定

> 以下约定对执行本任务清单的 Agent 有约束力。

- **开始子任务**：将对应行的 `- [ ]` 改为 `- [~]`（进行中）
- **完成子任务**：将对应行的 `- [~]` 改为 `- [x]`（已完成）
- **粒度(必须)**：每完成一个叶子任务（如 `1.1`、`2.3`）立即更新该行，不要等到阶段结束
- **不可修改**：不要修改 Agent 约定块本身、任务编号和任务描述文字，只修改 `[ ]` / `[~]` / `[x]` 状态标记

## 1. API 常量改造（`src/feishu/api.ts`）

- [ ] **1.1** 删除 `SKIP_TYPES` 常量（`src/feishu/api.ts:33`）
- [ ] **1.2** `FETCHABLE_TYPES`（`src/feishu/api.ts:32`）加注释说明重定义为"可生成本地 Markdown 文件的类型白名单，仅用于 download 阶段"

## 2. sync 流程核心改造（`src/feishu/sync-flow.ts`）

- [ ] **2.1** `for await (const node of fetchAllNodes(...))` 循环（`src/feishu/sync-flow.ts:98-149`）重构：所有节点走同一 upsert 路径
  - 2.1.1 移除 `if (FETCHABLE_TYPES.has(node.obj_type))` / `else if (SKIP_TYPES.has(...))` 双重判断分支
  - 2.1.2 提取 `const isDownloadable = FETCHABLE_TYPES.has(node.obj_type)` 局部变量
  - 2.1.3 把 `file_path` 构建、`usedPaths` 重名处理、`oldNode.downloaded_at` 续传判断全部包在 `if (isDownloadable)` 内
  - 2.1.4 非 doc/docx 时：`$filePath = null`、`$downloadedAt = null`、`$updatedAtLastSyncedAt = null`、`$humanPath = null`
  - 2.1.5 仍调用 `upsertNodeStmt.run(...)`，只是字段值差异
- [ ] **2.2** 计数器重构（`src/feishu/sync-flow.ts:88-91, 151-152, 154`）：按 obj_type 分组计数
  - 2.2.1 移除 `let skipNodeCount = 0`
  - 2.2.2 新增 `const objTypeCounts = new Map<string, number>()`，每次循环 `objTypeCounts.set(node.obj_type, (objTypeCounts.get(node.obj_type) ?? 0) + 1)`
  - 2.2.3 输出文案（line 154）改为分类型列出格式，例如：`${space.name}: ${nodeCount} 节点 (${docNodeCount} 文档 [docx: N, doc: N], 其他类型 [sheet: N, bitable: N, ...])`
  - 2.2.4 `writeProgress` 逻辑调整，必要时抽辅助函数 `formatObjTypeCounts(objTypeCounts: Map<string, number>): string`
- [ ] **2.3** 总计输出（`src/feishu/sync-flow.ts:167`）同步调整为按类型分组的统计，例如：`共 ${totalNodes} 个节点 (${totalDocNodes} 文档, ${totalNodes - totalDocNodes} 其他类型)`

## 3. sync-updated-at 流程改造（`src/feishu/sync-updated-at-flow.ts`）

- [ ] **3.1** 移除顶部 `FETCHABLE_TYPES` 的 import（`src/feishu/sync-updated-at-flow.ts:6`）
- [ ] **3.2** 按空间分支 SQL（`src/feishu/sync-updated-at-flow.ts:52-69`）移除 `obj_type IN (${typesPlaceholder})` 过滤
  - 3.2.1 删除 `typesPlaceholder` 构造和 `FETCHABLE_TYPES` 注入到 `params` 的逻辑（line 55-58）
  - 3.2.2 SQL 改为 `WHERE space_id IN (${placeholders}) ${maxAgeFilter} ORDER BY priority DESC, node_token ASC`
  - 3.2.3 `params` 类型注解移除 `Array.from(FETCHABLE_TYPES)` 部分
- [ ] **3.3** 全量分支 SQL（`src/feishu/sync-updated-at-flow.ts:70-85`）移除 `obj_type IN (${typesPlaceholder})` 过滤
  - 3.3.1 删除 `typesPlaceholder` 构造（line 72-74）
  - 3.3.2 SQL 改为 `WHERE 1=1 ${maxAgeFilter} ORDER BY priority DESC, node_token ASC`
  - 3.3.3 `params` 调整为只剩 `maxAgeParam`
- [ ] **3.4** 函数顶部 JSDoc 注释（`src/feishu/sync-updated-at-flow.ts:13-14`）更新："全量：所有 obj_type IN ('doc','docx') 的节点" → "全量：所有节点"

## 4. download 流程入口校验（`src/feishu/download-flow.ts`）

- [ ] **4.1** 顶部 import 加入 `FETCHABLE_TYPES`（`src/feishu/download-flow.ts:10`）
- [ ] **4.2** `downNode` 函数（`src/feishu/download-flow.ts:81-86`）入口加类型校验
  - 4.2.1 在 `try` 之前加：`if (!FETCHABLE_TYPES.has(node.obj_type)) { throw new Error(\`暂不支持下载 obj_type=${node.obj_type} 的节点\`); }`
  - 4.2.2 校验失败时错误信息包含原始 `obj_type` 值便于排查

## 5. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循 `CLAUDE.md` 构建标准）
> 测试模式参考 `tests/feishu/sync-flow.test.ts` 现有的 `:memory:` SQLite + 直接 INSERT 测试数据模式（参考 `tests/feishu/db.test.ts:263-360` `purgeOrphanNodes`）
> 中文 test 标签（`describe` / `test` 名称）

- [ ] **5.1** `tests/feishu/sync-flow.test.ts` 新增 `describe('sync 同步所有类型节点', ...)` 套件
  - 5.1.1 验证 doc/docx 节点正常入索引，`file_path` 非 NULL
  - 5.1.2 验证 sheet/bitable/mindnote/slides/file 节点也入索引，`file_path` 为 NULL
  - 5.1.3 验证非 doc/docx 节点的 `downloaded_at` 为 NULL，`human_path` 为 NULL，`updated_at_last_synced_at` 为 NULL
  - 5.1.4 验证输出文案包含按 obj_type 分组的计数
- [ ] **5.2** `tests/feishu/sync-updated-at-flow.test.ts` 新增或补充测试
  - 5.2.1 验证全量分支 SQL 不再过滤 obj_type，返回所有类型的节点
  - 5.2.2 验证按空间分支 SQL 不再过滤 obj_type
  - 5.2.3 验证单节点分支 SQL 不变（仅查 `WHERE node_token=?`）
- [ ] **5.3** `tests/feishu/download-flow.test.ts` 新增 `describe('downNode 入口校验', ...)` 套件
  - 5.3.1 验证传入 doc/docx 节点正常进入下载流程（不抛错）
  - 5.3.2 验证传入 sheet 节点抛错：`暂不支持下载 obj_type=sheet 的节点`
  - 5.3.3 验证传入 bitable 节点抛错：`暂不支持下载 obj_type=bitable 的节点`
  - 5.3.4 验证传入 mindnote/slides/file 节点也抛错
- [ ] **5.4** `tests/feishu/api.test.ts`（如存在）补充或保留 `FETCHABLE_TYPES` 导出测试，确认 `SKIP_TYPES` 已删除（导入应失败或抛错）

## 6. 验证与代码审查

- [ ] **6.1** 运行 `bun run lint`，修复全部 lint 错误
- [ ] **6.2** 运行 `bun test`，重点验证 `tests/feishu/sync-flow.test.ts` / `tests/feishu/sync-updated-at-flow.test.ts` / `tests/feishu/download-flow.test.ts` 全部通过
- [ ] **6.3** 运行 `bun run build`，确认产物正常
- [ ] **6.4** 运行 `/code-review` skill 审查全部 diff，修复发现的问题
- [ ] **6.5** （可选）手动跑 `cmd.feishu sync` 验证：DB 里出现 sheet/bitable 行，`file_path` 为 NULL
- [ ] **6.6** （可选）手动跑 `cmd.feishu sync-updated-at` 验证：非 doc/docx 节点的 `updated_at` 被填充
- [ ] **6.7** （可选）手动跑 `cmd.feishu download --node-token <sheet_token>` 验证：报 `暂不支持下载 obj_type=sheet 的节点`

## 7. 文档更新

- [ ] **7.1** 更新 `docs/feishu/overview.md`
  - 7.1.1 `nodes` 表 `obj_type` 字段说明补充："sync 阶段同步所有类型，非 doc/docx 的 `file_path` 为 NULL"
  - 7.1.2 边界说明（line 67-68）补充："sync 索引所有节点；download 仅处理 doc/docx"
- [ ] **7.2** 更新 `docs/feishu/business.md`
  - 7.2.1 "飞书文档下载" 章节（line 96）"只同步文档类节点（doc/docx）..." 改为 "`sync` 同步所有类型；`download` 仅处理 doc/docx"
  - 7.2.2 待确认项（line 212）"cmd.feishu 对 sheet、bitable、mindnote、slides、file 的长期策略..." 更新为"已采纳：索引层同步所有类型；下载层仍仅 doc/docx"
- [ ] **7.3** 更新 `docs/feishu/flows.md`
  - 7.3.1 索引同步详细流程（line 73-113）过滤流程图：移除 `if FETCHABLE_TYPES.has` 分支，更新为"所有节点 upsert，仅 doc/docx 计算 file_path"
  - 7.3.2 sync-updated-at 详细流程（line 130-157）队列构建部分：移除 `AND obj_type IN (...)` 过滤

## 任务依赖关系

- **执行顺序**：1（API 常量）→ 2（sync）→ 3（sync-updated-at）→ 4（download）→ 5（测试）→ 6（验证与审查）→ 7（文档）
- **依赖关系**：
  - 2 依赖 1（SKIP_TYPES 删除后 sync-flow 不能再引用）
  - 3 依赖 1（FETCHABLE_TYPES import 移除）
  - 4 依赖 1（FETCHABLE_TYPES import 新增）
  - 5 依赖 2、3、4（要等被测代码就位）
  - 6 依赖 5
  - 7 可与 6 并行（文档独立于代码细节，但建议在代码冻结后写）
- **可并行**：
  - 1 的 1.1 / 1.2 在同一文件但不同行，可顺序处理
  - 2 的 2.1 / 2.2 / 2.3 在同一文件，2.1 是核心重构，2.2 / 2.3 依赖 2.1 完成
  - 3 的 3.2 / 3.3 在同一文件但 SQL 分支独立，3.4 是注释可并行
  - 4 的 4.1 / 4.2 在同一文件但不同位置
  - 5 的 5.1 / 5.2 / 5.3 / 5.4 在不同测试文件，完全可并行
  - 7 的 7.1 / 7.2 / 7.3 在不同文档章节，可完全并行
- **必须串行**：
  - 1 → 2：sync-flow 不再能引用 SKIP_TYPES
  - 1 → 3.1：FETCHABLE_TYPES import 移除后才能改 SQL
  - 2 → 5.1：被测 sync 流程改了才能测
  - 3 → 5.2：被测 SQL 改了才能测
  - 4 → 5.3：被测 downNode 入口校验加了才能测
- **其他约束**：
  - `tests/feishu/db.test.ts` 无需新增/修改——`getDownloadQueue` SQL 不动
  - `tests/feishu/utils.test.ts` 无需新增/修改——`<cite>` callback 逻辑不变
  - 5.1 与 5.2 / 5.3 / 5.4 可并行（不同 describe 块或不同文件）
  - 6.4 必须在 6.1 / 6.2 / 6.3 通过后再跑
  - 6.5 / 6.6 / 6.7 是手动验证，可以异步穿插在 6.4 前后