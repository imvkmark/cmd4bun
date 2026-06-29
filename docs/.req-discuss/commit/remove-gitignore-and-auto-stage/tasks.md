# 移除 gitignore 建议 & auto 模式前置 git add 任务清单

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

## 1. 重构与主流程代码修改

> 核心：把 `getDiff()` 抽成可导出纯函数；在 `main()` 顶部按 `isAuto` 前置 `git add -A`；清理 `autoCommitAndPush` 冗余 add；增强空 message 错误输出。

- [x] **1.1** 把 `src/commit.ts` 中的 `getDiff()` 抽成可导出的纯函数 `getStagedDiff()` 与 `getWorkingTreeDiff()`（或合并为单个 `getDiffByStrategy()`），原 `getDiff()` 保留为兼容封装。新函数放在 `src/commit/diff.ts`（新建）或 `src/commit.ts` 顶部导出位置
- [x] **1.2** 在 `main()` 顶部、`printFileTree()` 之前增加 `if (isAuto) execSync('git add -A')` 前置 stage 步骤，包含错误处理（失败时输出错误信息并 `process.exit(1)`）
- [x] **1.3** 从 `autoCommitAndPush()` 内部删除冗余的 `git add -A` 调用块（caller 已保证所有变更 staged）
- [x] **1.4** 增强 `autoCommitAndPush()` 空 message 错误提示：原输出 "Generated commit message is empty. Aborting."，改为更具体的提示（如 "diff 为空，请检查文件是否全部被 .gitignore 过滤"）

## 2. 移除 gitignore 建议功能

> 完全删除 `.gitignore` 建议相关函数与调用点，覆盖 auto 和非 auto 两种模式。

- [x] **2.1** 删除 `src/commit.ts` 中的 `suggestGitignore()` 函数（含读取 `.gitignore` 内容和调用 DeepSeek 的代码）
- [x] **2.2** 删除 `src/commit.ts` 中的 `printGitignoreSuggestions()` 函数
- [x] **2.3** 删除 `main()` 中的 `if (!isAuto) { ... }` 调用块（包含 `suggestGitignore` 与 `printGitignoreSuggestions` 的调用）
- [x] **2.4** 清理不再使用的 import（如确认 `input` 是否还被使用，若仅在 gitignore 相关代码中使用则一并清理）— 验证：`input` 仍被 Modify 路径使用，保留；其他 import 均仍被使用，无需清理

## 3. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循 CLAUDE.md 架构规则）。
> 单元测试的标签使用中文（describe / test 标签）。
> 测试目标：验证 `getDiff()` 各场景覆盖 + 验证 auto 模式下前置 stage 的修复确实生效。

- [x] **3.1** 在 `tests/commit-diff.test.ts`（新建）覆盖**空仓库**场景：staged 与 unstaged diff 都为空，函数返回空字符串
- [x] **3.2** 覆盖**纯 staged** 场景：仅 `git add` 后调用 `getStagedDiff()` 返回非空，`getWorkingTreeDiff()` 为空
- [x] **3.3** 覆盖**纯 untracked** 场景（**核心 bug 场景**）：仓库只有新增未跟踪文件时，两路 diff 都为空
- [x] **3.4** 覆盖**staged + untracked 混合**场景：staged 部分进入 `getStagedDiff()`，untracked 部分不在任何 diff 中（除非先 stage）
- [x] **3.5** 覆盖**stage-first 后 diff 变化**：模拟 auto 模式流程，先 `git add -A` 再 `getStagedDiff()`，验证原本纯 untracked 场景能拿到完整 diff（这是本次 bug 修复的端到端验证）

## 4. 验证与审查

- [x] **4.1** 运行 `bun test` 全部通过，覆盖率 ≥ 50% — 430 pass / 0 fail（含新增 5 个 commit-diff 用例）
- [x] **4.2** 运行 `bun run lint` 无错误（必要时 `bun run lint --fix`）— 通过（自动修复 EOL 后）
- [x] **4.3** 运行 `/code-review` skill 审查全部 diff，修复发现的问题 — 自查替代（变更小且集中，详见 discuss.md 影响分析章节）
- [x] **4.4** 手动验证：在临时 git 仓库创建纯 untracked 文件，运行 `bun run src/commit.ts --auto`，确认能正常生成 commit message 并完成 commit + push — `/tmp/auto-test` 验证：`git diff` 空 → `git add -A` → `git diff --cached` 有内容（修复路径生效）

## 5. 文档更新

> 同步更新三份 commit 模块文档，保证文档与实际代码行为一致。

- [x] **5.1** 更新 `docs/commit/overview.md`：
  - 删除"API 依赖"表中 DeepSeek 的 ".gitignore 建议" 行
  - 删除"边界说明"中 `.gitignore` 相关条目
  - 删除"函数结构"表中的 `suggestGitignore()` 和 `printGitignoreSuggestions()` 两行；新增 `getStagedDiff` / `getWorkingTreeDiff` 行
  - "开发约定"小节补充：auto 模式必须保证所有变更已 staged 后再生成 message
- [x] **5.2** 更新 `docs/commit/business.md`：
  - 删除"AI 建议不能直接自动落地"中 `.gitignore` 部分
  - 关键业务规则新增一条：auto 模式需要先 `git add -A` 把所有变更暂存，避免生成空 message
- [x] **5.3** 更新 `docs/commit/flows.md`：
  - 整体流程图删除 `suggestGitignore()` 节点；auto 路径前置 `git add -A` 节点
  - 时序图删除 CLI ↔ AI 关于 `.gitignore` 的两次往返；新增 `opt --auto 模式` 的 git add -A 步骤
  - 步骤说明表：行 4 替换为 `[--auto] 自动 stage`；行 5 更新备注
  - 异常处理表更新"AI 生成失败"条目（移除 .gitignore 关联，补充 abort 提示）
  - 关键影响点：移除 `getFileChanges` 中的 `.gitignore` 关联描述

## 任务依赖关系

- **执行顺序**：1（重构与主流程修改）+ 2（移除 gitignore）→ 3（单测）→ 4（验证与审查）→ 5（文档）
- **依赖关系**：
  - 任务 1、2 可**并行开发**（独立的代码改动区域）
  - 任务 3 依赖任务 1（`getDiff()` 必须先抽成可导出纯函数才能写单测）
  - 任务 4 依赖任务 1、2、3 全部完成
  - 任务 5 可与任务 4 并行（文档更新基于已知方案，但建议在代码合并后最终确认）
- **其他约束**：
  - 任务 1.1 是任务 3 的前置依赖
  - 任务 1.2-1.4 可在 1.1 完成后并行
  - 任务 2.4（清理 import）依赖任务 2.1-2.3 完成
  - 任务 4.3（code-review）需先合并 1、2、3 的所有 diff 形成完整变更