# 节点忽略标记 (ignore flag) 需求变更讨论

## 需求背景

飞书知识库中存在"内部草稿"类文档：作者需要在本地保留副本（避免 sync 阶段清理掉），但不希望发布到公开归档目录。当前的复制流程只判断 `human_path` + `downloaded_at` 是否齐备，无法表达"我有 human_path 但请别复制我"的语义。

约定：在飞书文档正文的 YAML 代码块中追加 `ignore: Y`，作为作者侧"不发布"的标记信号。该机制与现有 `slug` 解析共用同一 YAML 代码块，沿用其代码块移除规则。

## 讨论后的关键结论

- YAML 解析重构为通用 frontmatter 解析：`parseSlugFromContent` → `parseFrontmatterMeta`，同时返回 `slug` 和 `ignore` 字段
- `parseAndStripSlug` 重命名为 `parseAndStripFrontmatter`，移除整个 YAML 代码块，`ignore` 不出现在最终 .md 中
- `ignore` 仅识别字面量 `Y`（区分大小写）；其他值（`y`/`yes`/`true`/`N`/空/缺失）一律视为 `false`
- 新增 `nodes.is_ignore INTEGER NOT NULL DEFAULT 0` 列；下载管线每次解析都覆盖写 0/1（保证作者去除 `ignore: Y` 后下次 download 自动恢复复制）
- `copydocs` SQL 增加 `AND (is_ignore IS NULL OR is_ignore = 0)` 过滤
- sheet/file 节点不解析 `ignore`（与现有 `slug` 在这两类节点的解析边界一致）
- 被忽略文档的 download 行为完全不变：仍下载本地 .md、走图片处理、写 human_path、写 description、注入 frontmatter，仅在 copydocs 阶段被过滤

## 需求目标

支持作者通过 YAML 元数据标记"内部草稿"：标记为 `ignore: Y` 的文档在 `copydocs` 阶段被排除，但 `download` 流程的其他环节保持不变（保留本地副本、图片处理、引用解析、frontmatter 注入等）。

**边界**：
- 不为 sheet/file 节点解析 `ignore`（仅 doc/docx 走 frontmatter 解析路径）
- 不新增 CLI 参数
- 不变更 download 流水线语义（被忽略文档仍正常下载和处理）
- 不变更 sync 阶段的索引行为（含 `purgeOrphanNodes` 清理）

## 当前流程

```
download 流程（doc/docx 节点）:
  fetchDocContent → processDocContent:
    1. parseAndStripSlug(content)
       ├── 定位第一个 ```yaml 代码块
       ├── 提取 slug 字段 → 写 nodes.human_path
       └── 移除整个 YAML 代码块 → cleanedContent
    2. resolveCiteBlocks / resolveCalloutBlocks
    3. resolveDescription（基于 cleanedContent）
    4. updateNodeDescription
    5. buildFrontmatter → 输出 .md
    6. processImagesInFile
    7. markNodeDownloaded

copydocs 流程:
  SELECT file_path, human_path, title FROM nodes
   WHERE human_path IS NOT NULL AND human_path != ''
     AND file_path IS NOT NULL AND file_path != ''
     AND downloaded_at IS NOT NULL
  → for each: mkdirSync + Bun.write 到 aimDirectory/{human_path}.md
```

参考：
- `docs/feishu/overview.md`（nodes 表 schema）
- `docs/feishu/business.md`（飞书文档下载、复制文档章节）
- `docs/feishu/flows.md`（文档下载流程图）

## 影响分析

### 1. `src/feishu/utils/markdown.ts`（解析层）

- `parseSlugFromContent` 重构为 `parseFrontmatterMeta(content): { slug, ignore }`
  - `ignore` 仅当 YAML 块内 `ignore:` 字段值 trim 后严格等于 `Y`（区分大小写）时返回 `true`
  - 其他情况（其他值、缺失、解析失败）一律返回 `false`
- `parseAndStripSlug` 重命名为 `parseAndStripFrontmatter`，返回 `{ slug, ignore, cleanedContent }`
  - 移除规则与现有相同：定位第一个 YAML 代码块，整个移除
  - 移除后 `cleanedContent` 不含 `ignore` 标记（与 `slug` 标记同等处理）
- 函数直接重命名，不保留旧名兼容导出（项目内部 API）

### 2. `src/feishu/utils/index.ts`

- 导出同步替换：`parseSlugFromContent` → `parseFrontmatterMeta`、`parseAndStripSlug` → `parseAndStripFrontmatter`

### 3. `src/feishu/db.ts`（存储层）

- `DBNode` 接口新增 `is_ignore: number`（INTEGER, 默认 0）
- 新增 `updateNodeIgnore(db, nodeToken, ignore: 0 | 1)`：覆盖写，幂等
- 不变更 `needsDownload` / `getDownloadQueue` 等下载队列逻辑（被忽略文档仍走正常下载路径）

### 4. `src/feishu/migrations/015_add_is_ignore.sql`（新增迁移）

```sql
ALTER TABLE nodes ADD COLUMN is_ignore INTEGER NOT NULL DEFAULT 0;
```

- 复用 ALTER TABLE 迁移的"列已存在视为已应用"幂等规则
- 默认值 0 与"存量是 0"对齐，无需回填脚本

### 5. `src/feishu/download-flow.ts`（编排层）

- `processDocContent` 中 `parseAndStripSlug` 调用点改为 `parseAndStripFrontmatter`
- 拿到 `ignore` 后无条件调用 `updateNodeIgnore(db, node.node_token, ignore ? 1 : 0)`
  - **覆盖写语义**：作者去除 `ignore: Y` 后下次 download 自动回到 0
- **不短路 return**：继续走完 slug/frontmatter/description/图片处理全流程（按"不影响 download"的要求）
- 后续 frontmatter 注入、human_path 写入、description 缓存、downloaded_at 标记全部照旧

### 6. `src/feishu/sync-flow.ts`（同步层）

- `INSERT INTO nodes` 列清单追加 `is_ignore`（值 `0`），否则 sync 写入会因 NOT NULL 失败
- `ON CONFLICT ... DO UPDATE SET` 同步追加 `is_ignore=excluded.is_ignore`
- 续传判断（基于 `downloaded_at`/`updated_at`）不受影响
- `purgeOrphanNodes` 不需要改：被忽略文档若远端删了仍要被清理掉

### 7. `src/feishu/copy-docs-flow.ts`（消费侧）

- 当前 SQL 增加 `AND (is_ignore IS NULL OR is_ignore = 0)`
- "没有符合复制条件的文档" 提示文案更新为同时提及 `ignore` 过滤
- 不变更目标路径、不变更复制逻辑本身
- 输出沿用现有简单统计（复制 N、跳过 M），不在日志中单独展示"因 ignore 跳过"

### 8. 文档同步更新

- `docs/feishu/overview.md` `nodes` 表 schema 增加 `is_ignore` 列说明
- `docs/feishu/business.md` 在"飞书文档下载"章节追加 `ignore` 字段解析规则、明确默认值与边界
- `docs/feishu/flows.md` 下载流程图标注 `ignore` 解析点；copydocs 章节的 SQL 条件同步更新

### 9. 级联副作用

- **图片处理**：被忽略文档仍走 `processImagesInFile`，图片照常下载/上传 OSS（按"不影响 download"要求）
- **优先级副作用**：`incrementNodePriority` 在解析 `<cite>` 时若被引方 `human_path` 为空会触发。被忽略文档本身仍写 `human_path`，引用行为不变；作为被引方时仍可被其他人正常引用
- **description 缓存**：忽略文档仍走 `resolveDescription` + 写入 `nodes.description`，无副作用
- **frontmatter**：被忽略文档的 `og:url` 仍写入，指向 `aimUrl/{slug}.html`（公开归档不存在该文件，链接仅作为引用语义保留）
- **删除文档时同步**：若 `deleteNodeByToken` 删除一个 `is_ignore=1` 的节点（含下载失败清理路径），aimDirectory 下的副本 `human_path.md` 仍会被删除（现有逻辑基于 human_path 路径，与 is_ignore 无关）

### 10. 数据一致性与过渡

- **存量数据**：迁移默认 `0` → 历史文档默认视为不忽略，行为不变
- **重新下载语义**：覆盖写 0/1 确保作者去除 `ignore: Y` 后下次 download 时 `is_ignore` 自动回到 0
- **空 `ignore` 字段**：YAML 块中只有 `ignore:` 后面无值 → 视为 `false`
- **代码块无 slug**：原 `parseAndStripSlug` 在无 slug 时保留原内容；新 `parseAndStripFrontmatter` 行为对齐：仅当匹配到 YAML 代码块且包含 `slug` 或 `ignore` 字段之一时才移除，否则保留内容

### 11. 性能风险

- 零额外网络请求、零大表扫描
- 单条 UPDATE 写入 `is_ignore`，与现有 `updateNodeHumanPath` 并列，IO 影响可忽略
- `copydocs` SQL 增加一个条件，查询无明显性能变化

## 方案对比

### 方案 A：扩展 frontmatter 解析器 + 新增 is_ignore 列（推荐）

核心思路：把现有 `parseSlugFromContent` 重构为通用 `parseFrontmatterMeta`，同时返回 `slug` 和 `ignore`；新增 `is_ignore` 列并在下载管线覆盖写，`copydocs` SQL 过滤掉非零行。

优点：
- 与现有 slug 解析复用同一 YAML 扫描，避免重复解析
- "覆盖写 0/1" 保证作者去除 `ignore: Y` 后下次 download 自动恢复复制
- 实现简单、改动局部、风险低
- 与 `slug` 解析机制一致（同样移除代码块），文档作者体验统一

缺点：
- 函数重命名触及既有调用点（download-flow.ts、测试）
- DB schema 扩展需要新迁移文件

实施复杂度：低

### 方案 B：保留旧函数名 + 新增独立 `parseIgnoreFromContent`（不推荐）

核心思路：不动 `parseSlugFromContent` 名字，新增独立函数扫 YAML 块取 `ignore`。

缺点：
- 同一份内容被扫两次，性能略差
- 解析逻辑分散，未来加新字段难收敛
- 与已认可的"重命名为通用 frontmatter 解析器"方向相悖

实施复杂度：低

## 推荐方案

方案 A。一次改动收敛所有用户已确认的设计点（重命名、覆盖写、priority 后位置、复制时过滤），与既有架构契合度高、扩展点都在已熟悉的层（解析、DB、SQL 过滤）。

## 待确认事项

- 无

## 实施建议

1. `src/feishu/utils/markdown.ts`：新增 `parseFrontmatterMeta`，重命名 `parseAndStripSlug` → `parseAndStripFrontmatter`，同步更新 `utils/index.ts` 导出
2. `src/feishu/migrations/015_add_is_ignore.sql`：新增 ALTER TABLE 迁移
3. `src/feishu/db.ts`：`DBNode` 加 `is_ignore` 字段，新增 `updateNodeIgnore`
4. `src/feishu/download-flow.ts`：`processDocContent` 改用新解析器，覆盖写 `is_ignore`
5. `src/feishu/sync-flow.ts`：`INSERT`/`ON CONFLICT` 列清单追加 `is_ignore`
6. `src/feishu/copy-docs-flow.ts`：SQL 增加 `AND (is_ignore IS NULL OR is_ignore = 0)`，提示文案同步
7. 同步更新 `tests/` 下相关单测：旧函数名迁移到新名 + 新增 `ignore` 字段用例
8. 同步更新 `docs/feishu/{overview,business,flows}.md`

## 结论

这次变更的本质是把"内部草稿"语义扩展到现有的 frontmatter 元数据机制：在同一 YAML 代码块内复用 `slug` 的解析链路，新增 `ignore` 字段作为 copydocs 的额外过滤维度。被忽略文档保留所有 download 阶段的处理行为（本地副本、图片、frontmatter、description），仅在归档复制环节被排除，整体改动局部、风险低，与既有架构契合。