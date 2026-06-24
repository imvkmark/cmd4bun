# 下载文档时移除 slug 代码块 任务清单

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

## 1. 新增 parseAndStripSlug 工具函数

- [x] **1.1** 在 `src/feishu/utils.ts` 中新增 `parseAndStripSlug(content: string)` 函数。逻辑：定位第一个包含 `slug:` 字段的 YAML 代码块（```yaml），提取 slug 值，同时将该代码块整体从内容中移除，返回 `{ slug: string | null, cleanedContent: string }`。不修改原有 `parseSlugFromContent`（保持向后兼容，后续可在确认无外部引用后移除）
- [x] **1.2** `parseAndStripSlug` 移除规则：仅移除匹配到 slug 的第一个 YAML 代码块；文档中其他 YAML 代码块（不含 slug 的）原样保留

## 2. 提取 processDocContent 共享处理函数，统一下载入口

- [x] **2.1** 在 `src/feishu/download-flow.ts` 中新增 `processDocContent()` 内部函数，聚合完整的内容处理链路：调用 `parseAndStripSlug` 解析 slug 并清理内容 → 更新 `human_path`（DB）→ 生成/复用 `description` → 构建 frontmatter → 返回 `{ slug, processedContent }`
- [x] **2.2** 重构 `downNode()`：用 `processDocContent()` 替换当前的 slug 解析 + frontmatter 构建代码，消除重复逻辑
- [x] **2.3** 重构 `runDownload()` 内部 worker：将裸 `fetchDocContent` + `Bun.write` 替换为调用 `processDocContent()`，使批量下载获得 frontmatter 注入和 slug 清理能力
- [x] **2.4** 确保 `processDocContent` 在无 slug 时行为正确：不注入 frontmatter，直接写清理后的内容（相当于原样写入）

## 3. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循架构规则）
> 单元测试的标签使用中文

- [x] **3.1** `tests/feishu/utils.test.ts` — 新增 `parseAndStripSlug` 测试：有 slug 代码块时正确提取并移除、无 slug 代码块时返回 null 且内容不变、仅移除第一个含 slug 的代码块保留其他 YAML 块、slug 在第二个 YAML 块中的行为
- [x] **3.2** `tests/feishu/download-flow.test.ts` — 新增 `processDocContent` 测试：有 slug 时代码块被移除且 frontmatter 正确注入、无 slug 时内容原样保留、清理后内容不包含 slug 代码块、验证 og:url 等字段组装正确
- [x] **3.3** 运行 `bun test` 确保全部测试通过

## 4. 验证与审查

- [x] **4.1** 运行 `/code-review` skill 审查全部 diff，修复发现的问题
- [x] **4.2** 运行 `bun run build` 确保编译通过

## 5. 文档更新

- [x] **5.1** 更新 `docs/feishu/flows.md` — 下载流程图和详细流程中增加 slug 代码块移除步骤，反映 unified processing 链路

## 任务依赖关系

- 执行顺序：1（parseAndStripSlug）→ 2（processDocContent 统一入口）→ 3（单元测试）→ 4（验证审查）→ 5（文档更新）
- 依赖关系：任务 2.1、2.2、2.3 依赖任务 1 完成；任务 2.2 和 2.3 依赖 2.1；任务 3.1 依赖 1；任务 3.2 依赖 2.1
- 可并行：任务 2.2 和 2.3 可并行开发（均依赖 2.1 完成后）；任务 3.1 和 3.2 可并行编写
- 其他约束：`parseSlugFromContent` 暂保留不删，待确认无其他调用方可清理（保守策略，避免运行时错误）
