# sync 同步所有类型节点 需求变更讨论

## 需求背景

当前 `cmd.feishu sync` 在 BFS 遍历飞书知识库节点时，仅把 `obj_type IN ('doc', 'docx')` 的节点写入 `nodes` 表，`sheet/bitable/mindnote/slides/file` 全部被静默跳过（仅计数不入索引）。`sync-updated-at` 同样按 `FETCHABLE_TYPES` 过滤，导致这些类型的远端编辑时间永远不会被拉取。

变更动机：

- **被引用方识别**：知识库里存在被 `<cite>` 引用的 sheet/bitable 节点，因它们不在 `nodes` 表中，下载流程的 `resolveCiteBlocks` 永远查不到 `human_path`，引用是死链。
- **后续扩展下载铺路**：先把索引层铺好（所有类型都有 `nodes` 行 + `updated_at`），未来扩展 `download` 支持更多类型时不需要再回头补索引。
- **完整审计视图**：通过 `nodes` 表能看到知识库的完整节点结构，便于排查/审计。

## 讨论后的关键结论

- **索引层放开**：`sync` 流程对所有 `obj_type` 节点都写入 `nodes` 表；只有 `FETCHABLE_TYPES`（doc/docx）会计算 `file_path`、做续传判断、生成本地 `.md` 文件
- **非 doc/docx 节点**：`file_path = NULL`、`downloaded_at = NULL`、`human_path = NULL`——只存元数据（标题、obj_token、obj_type、parent_node_token），不生成本地文件
- **`sync-updated-at` 放开**：移除 SQL 中的 `obj_type IN (...)` 过滤，对所有节点调用 `wiki +node-get` 拉取 `updated_at`。`fetchNodeMetaAsync` 内部已支持全部 7 种类型，无需 API 改动
- **`download` 不变**（**状态：已演进** — 此结论在后续 download 演进中已被部分推翻，详见下方"边界"段注释）：`getDownloadQueue` 仍带 `obj_type IN ('doc', 'docx')` 过滤，`fetchDocContent` 仍只为 doc/docx 实现
- **单节点下载加类型校验**：`downNode` 入口检查 `obj_type`，非 doc/docx 直接抛错退出，错误信息：`暂不支持下载 obj_type=X 的节点`
- **常量重定义**：`FETCHABLE_TYPES` 保留并重定义为"可生成本地 Markdown 文件的类型白名单"；`SKIP_TYPES` 删除（不再有 skip 路径）
- **输出文案分类型列出**：每个空间扫描后输出按 obj_type 分类的节点计数，便于排查

## 需求目标

让 `sync` 把飞书知识库中所有类型的节点都写入 `nodes` 表，让 `sync-updated-at` 也能为这些类型拉取远端 `updated_at`。但 `download` 仍然只下 `doc/docx`，非文档类节点只存元数据、不生成本地 `.md` 文件。

**边界**：
- `download` 不扩展类型支持（`fetchDocContent` 只为 doc/docx 实现）
  - **演进注**：此边界后续被部分放宽。`download` 在保留 `doc/docx` 写本地 Markdown 的同时，扩展支持 `file` / `sheet`（走 `downFileNode` / `downSheetNode` 走 OSS 通道写 `upload_url`，不生成本地文件）。`bitable` / `mindnote` / `slides` 仍未支持。详见 `src/feishu/download-flow.ts` 的 `downNode` 入口分发与 `src/feishu/db.ts` 的 `getDownloadQueue` SQL。
- 不为非 doc/docx 节点生成占位文件或 fake Markdown
- `FETCHABLE_TYPES` 保留但语义重定义为"可生成本地文件的类型白名单"
- `SKIP_TYPES` 删除
- 不引入新的 CLI flag
- 不修改 `db.ts` 的 `getDownloadQueue` SQL（download 行为不变）
- 不修改 `<cite>` 引用解析逻辑（被引方范围自然扩大到所有节点，未就绪时仍走 `priority +1`）

## 当前流程

```
runSync:
  Phase 1 扫描知识库元数据
    fetchSpaces() → 按 --spaces 过滤 targetSpaces
    for each space:
      fetchAllNodes(spaceId, name) → BFS 遍历节点树
        填 nodeMap、upsert nodes 行（仅命中 FETCHABLE_TYPES 的节点）
        else if SKIP_TYPES → 计数不入索引
      节点级 diff：DB 里有但 fetchAllNodes 没返回 → purgeOrphanNodes
    全量模式：清理已删空间

  Phase 2 清理过期本地 Markdown
    getAllIndexedFiles(DB) vs findMdFiles(outputDir)
    删除不在索引中的本地文件

runSyncUpdatedAt:
  查询队列 (3 种范围：单节点/按空间/全量)
    SQL: ... AND obj_type IN ('doc','docx') + ORDER BY priority DESC
  并发 fetchNodeMetaAsync (QPS=1.6)
    → fetchNodeMetaAsync 内部 validTypes 已包含全部 7 种类型
    → 但被 SQL 过滤拦截，sheet/bitable/mindnote/slides/file 永远不进队列
  updateNodeUpdatedAt → 写入 DB
```

参考：
- [docs/feishu/overview.md](../../../feishu/overview.md)
- [docs/feishu/business.md](../../../feishu/business.md)
- [docs/feishu/flows.md](../../../feishu/flows.md)
- `src/feishu/sync-flow.ts`
- `src/feishu/sync-updated-at-flow.ts`
- `src/feishu/api.ts`
- `src/feishu/db.ts`
- `src/feishu/download-flow.ts`

## 影响分析

### 1. `src/feishu/api.ts`

- 删除 `SKIP_TYPES` 常量（line 33）
- `FETCHABLE_TYPES` 保留，加注释说明重定义为"可生成本地 Markdown 文件的类型白名单"

### 2. `src/feishu/sync-flow.ts`（核心改造）

- `for await` 循环（line 98-149）重构：所有节点走同一 upsert 路径；只有 `isDownloadable = FETCHABLE_TYPES.has(node.obj_type)` 时才计算 `relPath`、做续传判断、生成 `file_path`
- 计数器拆为 `docNodeCount` + 按 obj_type 分组的计数（用 Map 或固定 7 个变量），便于按类型列出
- 输出文案（line 154）改为分类型列出，例如：
  ```
  ✓ Test Space: 100 节点 (70 文档 [docx: 60, doc: 10], 30 其他类型 [sheet: 20, bitable: 8, slides: 2])
  ```
- `upsertNodeStmt.run` 入参：非 doc/docx 时 `$filePath = null`；其他续传相关字段（`$downloadedAt`、`$updatedAtLastSyncedAt`、`$humanPath`）保持 `null`
- `upsertNodeStmt` 的 SQL 不需要改——SQLite schema 中 `file_path TEXT` 无 NOT NULL 约束，支持 NULL

### 3. `src/feishu/sync-updated-at-flow.ts`

- 3 处 SELECT SQL（line 55-58、72-75）移除 `obj_type IN (${typesPlaceholder})` 过滤，移除对应 `typesPlaceholder` 构造
- 函数注释（line 14）："全量：所有 obj_type IN ('doc','docx') 的节点" 改为 "全量：所有节点"
- `FETCHABLE_TYPES` 的 import 移除（不再使用）

### 4. `src/feishu/download-flow.ts`

- `downNode`（line 81-86）入口加 `FETCHABLE_TYPES` 校验：
  ```ts
  if (!FETCHABLE_TYPES.has(node.obj_type)) {
      throw new Error(`暂不支持下载 obj_type=${node.obj_type} 的节点`);
  }
  ```
- `FETCHABLE_TYPES` 的 import 新增（之前 sync-flow 用，download-flow 不需要；新增是因为 downNode 入口校验要用）

### 5. `src/feishu/db.ts`

- `getDownloadQueue`（line 117-127）：SQL 仍带 `obj_type IN ('doc', 'docx')`——这是 download 的过滤，**保持不动**
- `getAllIndexedFiles`（line 156-159）：非 doc/docx 节点的 `file_path` 是 NULL，Set 自然不收录，`Phase 2` 的"本地文件 vs 索引"diff 不受影响

### 6. 文档

- `docs/feishu/business.md` line 96："只同步文档类节点（doc/docx）：其他类型需要专门的读取逻辑" 改为 "`sync` 同步所有类型；`download` 仅处理 doc/docx"
- `docs/feishu/business.md` 待确认项（line 212）："cmd.feishu 对 sheet、bitable、mindnote、slides、file 的长期策略是跳过还是扩展为可同步类型" 更新为 "已采纳：索引层同步所有类型；下载层仍仅 doc/docx"
- `docs/feishu/flows.md` 索引同步详细流程（line 73-113）：更新过滤流程图，移除 `if FETCHABLE_TYPES.has` 分支
- `docs/feishu/overview.md` 边界说明（line 67-68）+ `nodes` 表 `obj_type` 字段说明

### 7. 级联副作用

- **`<cite>` 引用查找（`utils/blocks.ts` + `download-flow.ts`）**：被引方范围扩大。`sheet`/`bitable` 等的 `human_path` 为空，触发 `incrementNodePriority +1`——符合"被引方未就绪"的现有语义（见 [node-priority 讨论](../node-priority/discuss.md)）
- **`download --node-token <sheet_token>`**：单节点模式不再隐式只接受 doc/docx。`downNode` 入口校验后报错退出，错误信息明确
- **`copy-docs`**：仅拷已下载的 doc/docx 文件，不影响
- **`cleanupGlobalOrphans`**：兜底逻辑不变
- **`purgeOrphanNodes`**：用 `file_path` 删本地文件，非 doc/docx 没有 `file_path`，仅删 DB 行——符合预期

### 8. 数据一致性与过渡

- **存量 DB**：现有 `nodes` 表只有 doc/docx 行。新一次 `sync` 用 `INSERT ... ON CONFLICT DO UPDATE` 自然补齐其他类型，不破坏存量行
- **不需要迁移脚本**：只是新增行，不改 schema
- **`file_path = NULL`**：建议存 NULL（SQLite schema 允许），而不是空字符串——避免 `getAllIndexedFiles` 的 Set 把空串误判为有效路径导致 Phase 2 误删
- **失败回滚**：与现有风格一致，sync 不在事务里，单步失败靠下次 sync 兜底

### 9. 性能风险

- **sync BFS 扫描量级**：不变（`nodeMap.set` 原本就无条件执行）
- **sync-updated-at API 调用量**：显著增加。例如一个知识库 1000 个节点里有 300 个 sheet，原本只调 700 次现在调 1000 次——增加约 43%
- **QPS limiter 1.6 req/s 保持不变**：总时长正比增加，但通过 `--max-age` 增量同步可缓解

## 方案对比

### 方案 A（推荐）：放开 sync + sync-updated-at，download 加入口校验

**核心思路**：保留 `FETCHABLE_TYPES` 常量但重定义为"可生成本地 Markdown 文件的类型白名单"。`sync-flow.ts` 对所有节点走同一 upsert 路径，仅在写入字段时区分；`sync-updated-at-flow.ts` 移除 `obj_type` 过滤；`downNode` 入口校验类型，非 doc/docx 直接报错退出。

**优点**：
- 改动收敛在 4 个源文件 + 3 个文档
- `FETCHABLE_TYPES` 不删除，仍是 download 的过滤依据
- 完全兼容存量 DB（自然增量补齐）
- `<cite>` 引用查找范围自然扩大
- 不动 `download` 主流程

**缺点**：
- `file_path = NULL` 是 SQL 层"软约定"，需要在代码里仔细写字段处理
- `downNode` 入口加校验是个新模式（但只是几行）

**实施复杂度**：低

### 方案 B：激进路径——删除两个常量，download 也跟着放开

**核心思路**：彻底删除 `FETCHABLE_TYPES` / `SKIP_TYPES`，所有 SQL 都不带类型过滤。download 也尝试处理所有类型。

**优点**：
- 概念最干净

**缺点**：
- 需要扩展 `fetchDocContent` 适配 sheet/bitable/mindnote/slides/file 的读取——这是全新需求
- 删常量后 `getDownloadQueue` 也要改 SQL
- 超出了"先放开索引"的需求范围

**实施复杂度**：高

**不推荐理由**：本轮需求明确说"download 仍只下 doc/docx"。

## 推荐方案

**方案 A：放开 sync + sync-updated-at，download 加入口校验**

理由：

- 严格对齐你需求里的"sync 同步所有类型 + sync-updated-at 同步所有类型 + download 仅 doc/docx"
- 改动面最小（4 个源文件 + 3 个文档）
- 现有 `getDownloadQueue` 保持原样，download 主流程零改动
- `downNode` 入口校验给单节点模式一个明确的边界
- `<cite>` 引用查找自然受益（被引方识别范围扩大）
- 存量 DB 自然升级，不需要迁移脚本

## 待确认事项

- [x] 范围 —— ✅ 索引层 + sync-updated-at
- [x] file_path 字段处理 —— ✅ NULL（SQLite schema 允许）
- [x] 单节点下载非 doc/docx 处理 —— ✅ downNode 入口校验并报错：`暂不支持下载 obj_type=X 的节点`
- [x] 输出文案格式 —— ✅ 按 obj_type 分类型列出，例如 `70 文档 [docx: 60, doc: 10], 30 其他类型 [sheet: 20, bitable: 8, slides: 2]`
- [x] SKIP_TYPES —— ✅ 删除（不再有 skip 路径）
- [x] `<cite>` 引用查找 —— ✅ 自然扩大，未就绪时走 `priority +1`
- [x] `--max-age` 增量同步 —— ✅ 已有逻辑不变，可缓解 sync-updated-at 调用量增加

## 实施建议

按优先级：

1. **`src/feishu/api.ts`**：删除 `SKIP_TYPES`；`FETCHABLE_TYPES` 加注释说明重定义
2. **`src/feishu/sync-flow.ts`**：`for await` 循环重构（所有节点走 upsert，仅 isDownloadable 才算 file_path）；计数器按 obj_type 分组；输出文案改格式
3. **`src/feishu/sync-updated-at-flow.ts`**：3 处 SELECT SQL 移除 `obj_type IN (...)` 过滤；移除 `FETCHABLE_TYPES` import；注释更新
4. **`src/feishu/download-flow.ts`**：`downNode` 入口加 `FETCHABLE_TYPES` 校验并抛错；新增 `FETCHABLE_TYPES` import
5. **测试**：补充 sync-flow 单元测试，验证"非 doc/docx 节点也入索引且 file_path 为 NULL"
6. **文档**：更新 `docs/feishu/business.md`、`flows.md`、`overview.md`
7. **验证**：
   - `bun run lint`
   - `bun test`
   - 手动跑 `cmd.feishu sync` 验证：DB 里出现 sheet/bitable 行，`file_path` 为 NULL
   - 手动跑 `cmd.feishu sync-updated-at` 验证：非 doc/docx 节点的 `updated_at` 被填充
   - 手动跑 `cmd.feishu download --node-token <sheet_token>` 验证：报 `暂不支持下载 obj_type=sheet 的节点`

## 结论

这次变更的本质是把"索引"和"下载"两个概念的边界彻底拆开——索引层是飞书节点结构的镜像（应当完整）；下载层是文档处理管线（按当前实现能力支持 doc/docx）。改动收敛在 4 个源文件：`api.ts` 删 `SKIP_TYPES` 并重定义 `FETCHABLE_TYPES`；`sync-flow.ts` 让所有节点入索引；`sync-updated-at-flow.ts` 放开 SQL 过滤；`download-flow.ts` 加单节点入口校验。存量 DB 自然增量补齐，不需要迁移脚本。下游 `<cite>` 引用查找范围自然扩大，未就绪被引方走现有 `priority +1` 语义。