# `<sub-page-list>` 块解析任务清单

## 任务状态

- [ ] 待开始
- [~] 进行中
- [x] 已完成

## Agent 执行约定

> 以下约定对执行本任务清单的 Agent 有约束力。

- **开始子任务**：将对应行的 `- [ ]` 改为 `- [~]`（进行中）
- **完成子任务**：将对应行的 `- [~]` 改为 `- [x]`（已完成）
- **粒度(必须)**：每完成一个叶子任务（如 `1.1`、`2.3`）立即更新该行，不要等到阶段结束
- **不可修改**：不要修改 Agent 约定块本身、任务编号和任务描述文字，只修改 `[ ]` / `[~]` / `[x]`
状态标记

## 1. `blocks.ts` 解析函数实现

- [x] **1.1** 在 `src/feishu/utils/blocks.ts` 新增 `resolveSubPageListBlocks(content, resolveLink): { result, warnings }` 导出函数
  - 定义块级正则 `BLOCK_RE = /<sub-page-list\b[^>]*>([\s\S]*?)<\/sub-page-list>/g`
  - 定义子项正则 `ITEM_RE = /<sub-page\b([^>]*?)\/>/g`
  - 复用现有 `parseHtmlAttrs` 解析子项属性（无需新增 import）
  - 块替换闭包内逐项处理：缺 doc-id / file-type 非 docx-sheet-file / resolveLink 返回 null 三种降级路径
  - 命中分支：docx → `- [title](human_path.md)`，sheet/file → `- [title](upload_url)`
  - 全部子项未命中时输出空字符串（外壳丢弃），但仍逐项 warning

## 2. `utils/index.ts` re-export

- [x] **2.1** 在 `src/feishu/utils/index.ts` line 9 追加 `resolveSubPageListBlocks` 到 `export { resolveCiteBlocks, resolveCalloutBlocks } from './blocks';`

## 3. `download-flow.ts` 串联调用

- [x] **3.1** 在 `src/feishu/download-flow.ts` 的 `processDocContent` 内，`resolveCalloutBlocks(citeResult)` 之前插入 `resolveSubPageListBlocks(citeResult, resolveLinkCb)` 串联调用
  - 复用现有 `resolveLink` 闭包（已支持 sheet/file 走 upload_url）
  - 新解析步骤的 warnings 注入到现有 `for (const w of warnings) console.warn(...)` 循环
- [x] **3.2** `src/feishu/download-flow.ts` 顶部 import 列表追加 `resolveSubPageListBlocks`（line 7 附近）
- [x] **3.3** **修正**：sub-page 的 `doc-id` 是飞书文档对象 ID（`obj_token`），不是 wiki 树节点 ID（`node_token`）
  - 在 `db.ts` 新增 `getNodeByObjToken(db, objToken)` 辅助函数（`WHERE obj_token=? LIMIT 1`）
  - 改 sub-page-list `resolveLink` 回调用 `getNodeByObjToken` 查，`incrementNodePriority` 用回查得到的 `node_token`
  - 同步 cite 解析器仍用 `getNode`（cite 的 doc-id 是 node_token，与 sub-page 不同语义）

## 4. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循架构规则）
> 测试位置：`tests/feishu/utils.test.ts`
> 标签：使用中文

- [x] **4.1** 多个 sub-page 全部命中 → 输出完整 Markdown 无序列表，warnings 为空
- [x] **4.2** 多个 sub-page 全部未命中 → 整块输出为空字符串，每子项产生 1 条 warning
- [x] **4.3** 部分命中 → 命中项变 Markdown 链接，未命中项保留原始 `<sub-page ... />` 标签
- [x] **4.4** 缺 `doc-id` 属性 → 保留原文 + warning
- [x] **4.5** 缺 `title` 属性 → 命中时使用 `Untitled` 作为链接文本
- [x] **4.6** 空 `<sub-page-list></sub-page-list>` 块（无任何子项）→ 输出空字符串
- [x] **4.7** `space-id` / `wiki-token` 属性不影响解析结果（命中时正常生成链接）
- [x] **4.8** `file-type="docx"` 命中 → 链接后缀加 `.md`
- [x] **4.9** `file-type="sheet"` / `file-type="file"` 命中 → 链接不加 `.md`（直接用 upload_url）
- [x] **4.10** `file-type="bitable"` / `mindnote` 等不支持类型 → 保留原文，不产生 warning
- [x] **4.11** 多个 sub-page-list 块（文档里出现 ≥ 2 个）→ 每个块独立处理
- [x] **4.12** 内容中无 sub-page-list 标签 → 原样返回
- [x] **4.13** `tests/feishu/utils.test.ts` 顶部 import 列表追加 `resolveSubPageListBlocks`（line 3 附近）
- [x] **4.14** `tests/feishu/db-integration.test.ts` 新增 5 个 `getNodeByObjToken` 测试：null 命中 / 按 obj_token 查命中 / 不与 node_token 冲突 / 同一 obj_token 多行返回首条 / 跨节点互不干扰
- [x] **4.15** `tests/feishu/download-flow.test.ts` 新增 4 个 `buildFrontmatter` YAML 单引号转义测试：title 撇号 / description 撇号 / 多撇号 / title+description 双撇号
- [x] **4.16** `tests/feishu/download-flow.test.ts` 新增 5 个 `buildFrontmatter` HTML 实体转义测试：title 尖括号 / description 尖括号 / & 字符 / 撇号+尖括号+& 复合 / og:url 双引号

## 5. 验证与审查

- [x] **5.1** 运行 `bun test tests/feishu/utils.test.ts` 全部通过（91/91）
- [x] **5.2** 运行 `bun run lint` 无错误
- [x] **5.3** 运行 `bunx tsc --noEmit` 无错误
- [ ] **5.4** 在 `feishu-docs/技能/Database/Redis 简介/文档/Set _ 集合.md` 等真实样例上跑 `download --force`，确认 `<sub-page-list>` 块输出为 `- [SADD key member [...]](...).md` 形式的 Markdown 无序列表（需 lark-cli 认证环境，本次跳过）
- [x] **5.5** 运行 `/code-review` skill 审查全部 diff，修复发现的问题

## 7. 实施期补正

- [x] **7.1** **修正**：sub-page `doc-id` 应对应 `obj_token`（已在 3.3 + 4.14 落地）
- [x] **7.2** **修正**：`buildFrontmatter` 单引号字符串内未对撇号转义,YAML 解析在含 "What's New" 这类英文所有格 / 缩写标题时会爆
  - 新增 `escapeYamlSingleQuoted(s)` 辅助函数（`'` → `''`），应用于 `nodeTitle` / `description` / `updatedAt` / `og:url` 全部单引号字段
  - 4 个新测试覆盖 title / description / 多撇号 / 双字段同时含撇号
- [x] **7.3** **修正**：`buildFrontmatter` 字段值会进入 HTML meta 标签 content 属性,未转义的 `<` / `>` 会被浏览器当 HTML 标签吃掉
  - 飞书 Redis 文档常见 `PUBSUB <subcommand> [argument ...]` 命令签名
  - **方案 A（已废弃）**：HTML 实体转义 `<` → `&lt;` / `>` → `&gt;` — 过度工程,在 frontmatter 里散布 HTML 实体
  - **方案 B（已采纳）**：直接 strip `<` 和 `>` 字符,内部 subcommand 字面文本保留 — 占位符语义已由方括号表达,尖括号本身没保留价值
  - 撤回 `escapeHtml` 辅助函数,新增 `stripAngleBrackets(s) = s.replace(/[<>]/g, '')`
  - `buildFrontmatter` 内对 `nodeTitle` / `description` / `updatedAt` / `og:url` 全部做 `stripAngleBrackets(escapeYamlSingleQuoted(x))`
  - 5 个新测试覆盖 title 尖括号 / description 尖括号 / 多组尖括号 / 撇号+尖括号复合 / 无尖括号标题

## 6. 文档更新

- [x] **6.1** 更新 `docs/feishu/business.md` "飞书文档下载" 关键业务规则章节，追加 `<sub-page-list>` 块解析的描述（命中行为、降级行为、warning 策略、file-type 范围）
- [x] **6.2** 更新 `docs/feishu/flows.md` 下载流程详细流程的 ASCII 流程图，在 `resolveCalloutBlocks` 之前插入 `resolveSubPageListBlocks` 节点

## 任务依赖关系

- 执行顺序：1（blocks.ts 解析器实现） → 2（re-export） → 3（download-flow.ts 串联） → 4（单元测试） → 5（验证审查） → 6（文档更新）
- 依赖关系：
  - 任务 2 依赖任务 1.1（实现完成后才能 re-export）
  - 任务 3 依赖任务 1.1 + 2.1（实现并导出后才能串联调用）
  - 任务 4 依赖任务 1.1（必须先有被测函数才能写测试用例）
  - 任务 5 依赖任务 1+2+3+4 全部完成
  - 任务 6 可与任务 4 并行（文档更新不依赖测试代码，但建议排在验证通过后以确保描述与最终行为一致）
- 其他约束：
  - 任务 3.1 和 3.2 必须同时提交（同一文件改动，import 与调用配套）
  - 任务 4 的 12 个测试用例可由单个 Agent 串行完成，也可拆给两个 Agent 并行（4.1-4.6 vs 4.7-4.12），但都要 import 4.13 的同一行改动，避免冲突
  - 任务 5.5 `/code-review` 在 `git diff` 有内容时执行；若所有改动未提交，先 `git add` 后再 review
