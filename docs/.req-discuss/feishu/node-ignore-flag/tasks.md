# 节点忽略标记 (ignore flag) 任务清单

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

## 1. 解析层重构 (`src/feishu/utils/markdown.ts`)

- [x] **1.1** 新增 `parseFrontmatterMeta(content): { slug, ignore }`，沿用现有 `parseSlugFromContent` 的扫描规则；`ignore` 仅在 YAML 块内 `ignore:` 字段值 trim 后严格等于 `Y`（区分大小写）时返回 `true`，其他情况一律返回 `false`
- [x] **1.2** 将 `parseAndStripSlug` 重命名为 `parseAndStripFrontmatter`，返回 `{ slug, ignore, cleanedContent }`；移除规则与现有相同（定位第一个 YAML 代码块、整个移除、清理连续空行）
- [x] **1.3** 同步更新 `src/feishu/utils/index.ts` 导出（替换 `parseSlugFromContent`/`parseAndStripSlug` 为新名），删除旧名导出

## 2. DB 迁移与 schema 扩展

- [x] **2.1** 新增 `src/feishu/migrations/015_add_is_ignore.sql`，内容为 `ALTER TABLE nodes ADD COLUMN is_ignore INTEGER NOT NULL DEFAULT 0;`
- [x] **2.2** `src/feishu/db.ts`：`DBNode` 接口新增 `is_ignore: number` 字段（INTEGER, 默认 0）
- [x] **2.3** `src/feishu/db.ts`：新增 `updateNodeIgnore(db: Database, nodeToken: string, ignore: 0 | 1): void` 函数，使用 `UPDATE nodes SET is_ignore=? WHERE node_token=?`

## 3. 下载编排层改造 (`src/feishu/download-flow.ts`)

- [x] **3.1** `processDocContent` 中 `parseAndStripSlug` 调用点改为 `parseAndStripFrontmatter`，解构 `slug`/`ignore`/`cleanedContent`
- [x] **3.2** 在 `processDocContent` 中拿到 `ignore` 后无条件调用 `updateNodeIgnore(db, node.node_token, ignore ? 1 : 0)`（覆盖写 0/1，保证取消忽略语义生效）
- [x] **3.3** 确认 `processDocContent` 不短路 return：`ignore` 为 true 时仍继续走 slug/frontmatter/description/图片处理全流程

## 4. 同步层 schema 对齐 (`src/feishu/sync-flow.ts`)

- [x] **4.1** `INSERT INTO nodes` 列清单追加 `is_ignore`（值 `0`）
- [x] **4.2** `ON CONFLICT(node_token) DO UPDATE SET` 子句同步追加 `is_ignore=excluded.is_ignore`

## 5. 复制消费侧过滤 (`src/feishu/copy-docs-flow.ts`)

- [x] **5.1** 当前 SQL 增加 `AND (is_ignore IS NULL OR is_ignore = 0)` 过滤
- [x] **5.2** "没有符合复制条件的文档" 提示文案更新为同时提及 `ignore` 过滤

## 6. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循架构规则）
> 测试文件位于 `tests/feishu/` 目录，使用 `bun:test` 框架，标签使用中文

- [x] **6.1** `tests/feishu/utils.test.ts`：将旧 `parseSlugFromContent`/`parseAndStripSlug` 用例迁移到 `parseFrontmatterMeta`/`parseAndStripFrontmatter` 新函数名
- [x] **6.2** `tests/feishu/utils.test.ts`：新增 `parseFrontmatterMeta` 对 `ignore` 字段的覆盖（标签：解析 ignore 字段）：值 `Y` → true；值 `y`/`yes`/`true`/`N`/`no`/`false`/空/缺失 → false
- [x] **6.3** `tests/feishu/utils.test.ts`：新增 `parseAndStripFrontmatter` 验证 YAML 代码块移除行为（标签：移除 YAML 代码块）：移除后 `cleanedContent` 不含 `ignore` 标记
- [x] **6.4** `tests/feishu/db.test.ts`：新增 `updateNodeIgnore` 测试（标签：写入 is_ignore）：验证写入 1 / 写入 0 / 覆盖写语义（先写 1 后写 0 应读到 0）
- [x] **6.5** `tests/feishu/db-integration.test.ts` 或 `tests/feishu/copy-docs.test.ts`：新增 copydocs SQL 过滤测试（标签：copydocs 过滤 is_ignore）：插入 `is_ignore=1` 和 `is_ignore=0` 两条记录，断言 SQL 只返回后者
- [x] **6.6** `tests/feishu/init-db.test.ts`：验证 `015_add_is_ignore.sql` 迁移幂等执行后 `nodes.is_ignore` 列存在、默认 0（标签：迁移 is_ignore 列）

## 7. 验证与审查

- [x] **7.1** 运行 `bun test` 确认全部用例通过
- [x] **7.2** 运行 `bun run lint` 确认代码风格符合规范
- [x] **7.3** 运行 `/code-review` skill 审查全部 diff，修复发现的问题

## 8. 文档更新

- [x] **8.1** 更新 `docs/feishu/overview.md` `nodes` 表 schema：新增 `is_ignore INTEGER` 列说明（默认 0，下载管线解析 YAML `ignore: Y` 字段写入，copydocs 过滤掉非零行）
- [x] **8.2** 更新 `docs/feishu/business.md`：在"飞书文档下载"章节追加 `ignore` 字段解析规则、明确默认值（`Y` 才算忽略）与边界（仅 doc/docx）；更新"复制文档"章节文案提及 `is_ignore` 过滤
- [x] **8.3** 更新 `docs/feishu/flows.md`：下载流程图标注 `parseAndStripFrontmatter` 与 `updateNodeIgnore` 步骤；copydocs 章节的 SQL 条件同步更新

## 任务依赖关系

- **执行顺序**：1 (解析层) → 2 (DB 层) → 3 (下载编排) / 4 (同步层) / 5 (复制消费侧) 三者可并行 → 6 (测试) → 7 (验证与审查) → 8 (文档)
- **依赖关系**：
  - 任务 3 依赖任务 1、2 完成（解析函数 + DB 函数）
  - 任务 4 依赖任务 2 完成（DB schema 扩展）
  - 任务 5 依赖任务 2 完成（依赖 `is_ignore` 列存在）
  - 任务 6 依赖任务 1、2、3、4、5 全部完成
  - 任务 7 依赖任务 6 完成
  - 任务 8 可与任务 6、7 并行（在代码稳定后启动即可）
- **其他约束**：
  - `parseAndStripSlug` 重命名后，所有旧调用点必须在同一变更中迁移完毕，禁止保留兼容导出
  - 迁移文件按序号递增，文件名格式 `015_add_is_ignore.sql`，需保证排序在 `014_drop_downloaded.sql` 之后