# 移除 gitignore 建议 & auto 模式前置 git add 需求变更讨论

## 需求背景

`src/commit.ts` 在 `--auto` 模式下，当仓库仅有新增未跟踪文件（pure untracked 场景）时：
- `git diff --cached` 返回空（没有 staged）
- `git diff` 也返回空（只显示已跟踪文件的修改）
- → `getDiff()` 返回空字符串
- → `generateMessage()` 拿到空 diff，输出空 commit message
- → `autoCommitAndPush()` 触发 abort，提示 "Generated commit message is empty"

该问题在 `docs/commit/flows.md:89` 已隐式承认（"无 diff 但有新增文件（如纯 untracked 场景）时传入空字符串"），但 auto 模式没有兜底机制。

同时，`.gitignore` 建议功能每次都额外调用一次 DeepSeek API，建议内容对用户决策影响有限，且 `.gitignore` 维护本质上是项目级的人工决策，不应由 AI 一次性提示决定。

参考：
- `src/commit.ts`
- `src/commit/tree.ts`
- `src/commit/selector.ts`
- `docs/commit/overview.md`
- `docs/commit/business.md`
- `docs/commit/flows.md`

## 讨论后的关键结论

- 完全移除 `.gitignore` 建议功能（auto 与非 auto 均删除）
- `--auto` 模式新增：在 `printFileTree()` 之前执行 `git add -A`，让 untracked 文件被 staged，保证 `getDiff()` 能拿到完整 diff
- 非 auto 模式流程不变（保留 Accept 路径下的文件选择能力，避免 `[●] 不可取消` 的副作用）
- `autoCommitAndPush` 内部删除冗余的 `git add -A`（caller 已保证 staged）
- `autoCommitAndPush` 在 message 为空时输出更具体的错误信息，便于排查
- 补充 `getDiff()` / stage-first 关键路径的单测
- 同步更新三份文档（overview / business / flows）

## 需求目标

- 移除冗余的 `.gitignore` AI 建议功能，节省一次 API 调用、降低噪音
- 修复 `--auto` 模式在纯 untracked 场景下生成空 commit message 的 bug
- 通过调整 `--auto` 模式的操作顺序，让所有变更（含 untracked）一次性进入 staging，保证 `getDiff()` 能拿到完整 diff 内容

变更边界：
- **做**：删 gitignore 函数与调用点；`--auto` 提前 stage；删 `autoCommitAndPush` 冗余 add；补单测；补错误信息；改三份文档
- **不做**：非 auto 模式流程不变；不改 Accept/Modify/Regenerate 交互逻辑；不改 `selectFiles` 行为

## 当前流程

```
main()
├─ 解析 --auto
├─ loadConfig + resolveToken
├─ 加载 modelName / reasoningEffort
├─ printFileTree()         ← 收集 staged + unstaged + untracked（src/commit/tree.ts:getFileChanges）
├─ suggestGitignore()      ← AI 建议 .gitignore（要删除）
├─ getDiff()               ← git diff --cached → fallback git diff
├─ generateMessage()
└─ if isAuto → autoCommitAndPush(message)
       ├─ message 空 → abort
       ├─ git add -A
       ├─ git commit -m message
       └─ git push
   else → selectAction 循环
       ├─ Accept → selectFiles → git add <selected> → commit
       ├─ Modify → input → git add -A → commit
       └─ Regenerate → generateMessage（基于同一个 diff）
```

参考：
- `docs/commit/flows.md`
- `docs/commit/business.md`

## 影响分析

### 1. src/commit.ts（直接改动）

- 删除 `suggestGitignore()` 函数（约 30 行）
- 删除 `printGitignoreSuggestions()` 函数（约 10 行）
- 删除 `main()` 中的 `if (!isAuto) { ... }` 调用块
- 在 `main()` 顶部按 `isAuto` 增加 `git add -A` 前置步骤（错误处理沿用现有风格）
- 从 `autoCommitAndPush()` 内部删除冗余的 `git add -A`（caller 已保证 staged）
- 增强 `autoCommitAndPush()` 空 message 错误提示（例如输出 "diff 为空，请检查文件是否全部被 .gitignore 过滤"）

### 2. tests/git-commit.test.ts（补充测试）

- 当前只覆盖 `selectFiles` 纯逻辑（`buildInitialSelected` / `toggleSelection` / `getSelectedPaths` / `buildPlainFileLines`），主流程无单测
- 建议补：
  - 把 `getDiff()` 抽成可导出的纯函数 `getDiffByStrategy(strategy)` 或类似名
  - 覆盖场景：空仓库、纯 staged、纯 unstaged、纯 untracked、staged + untracked 混合
  - 覆盖 stage-first 后的 diff 变化（untracked-only 场景前置 add 后能拿到 diff）
- 测试目标覆盖率 > 50%（满足 CLAUDE.md 强制要求）

### 3. docs/commit/overview.md（同步）

- 删除"API 依赖"表中 DeepSeek 的 ".gitignore 建议" 行
- 删除"边界说明"中 `.gitignore` 相关条目（line 70）
- 删除"函数结构"表中的 `suggestGitignore()` 和 `printGitignoreSuggestions()` 两行
- "开发约定"小节补充：auto 模式必须保证所有变更已 staged 后再生成 message

### 4. docs/commit/business.md（同步）

- 删除"AI 建议不能直接自动落地"中 `.gitignore` 部分（line 23）
- 关键业务规则新增一条：auto 模式需要先 `git add -A` 把所有变更暂存，避免生成空 message

### 5. docs/commit/flows.md（同步）

- 整体流程图删除 `suggestGitignore()` 节点（line 8）
- 时序图删除 CLI ↔ AI 关于 `.gitignore` 的两次往返（lines 43-45）
- auto 路径：在 `printFileTree()` 之前增加 `git add -A` 步骤（修改 lines 33-39 时序图、line 89 步骤说明）
- 步骤说明表更新行 4（删除 gitignore），插入新行说明 auto 前置 stage
- 异常处理表更新"AI 生成失败"条目（移除 .gitignore 关联）

### 6. 级联副作用

- 无（纯本地 CLI，无外部消费者，无事件链路）

### 7. 数据一致性与过渡

- 不涉及持久化数据
- 行为兼容：CLI 调用方式不变（仍是 `bun run src/commit.ts [--auto]`）
- 用户可见行为变化：
  - auto 模式：进入 `commit.ts` 后立即把所有变更 staged（用户看不到 `[?]` 状态的 untracked，所有文件展示为 A/M）
  - 非 auto 模式：流程不变，仍然展示 mixed status 的文件树
- 兼容性：现有 deepseek API 调用从 2 次降为 1 次，节省 token 与时延

## 方案对比

### 方案 A：单点顺序调整 + 删除 gitignore（推荐）

**核心思路**：在 `main()` 顶部按 `isAuto` 加 `git add -A`；删除两个 gitignore 函数和调用块；从 `autoCommitAndPush` 删冗余 add；增强错误信息。

优点：
- 改动局限在 `commit.ts` 一个文件 + 三个 doc 文件 + 一个 test 文件
- 不破坏 `autoCommitAndPush` 的契约（仍然 "auto 提交并推送"）
- 不破坏非 auto 模式的选择性 commit 能力
- 单测容易补：把 `getDiff()` 抽出来即可

缺点：
- `autoCommitAndPush` 失去"未 stage 兜底"能力，依赖 caller 保证 staged（已通过重构保证）

### 方案 B：抽 `stageAll()` + `getStagedDiff()` 纯函数

**核心思路**：在方案 A 基础上，把 `git add -A` 抽成 `stageAll()`，`getDiff()` 拆出 `getStagedDiff()` 和 `getUnstagedDiff()`，便于单测。

优点：
- 测试可独立覆盖 stage 和 diff 两层
- 长期更可维护

缺点：
- 多一层抽象；对当前 scope 略重

### 方案 C：保留 `getDiff` 的 fallback，但 auto 模式跳过 fallback

**核心思路**：`getDiff()` 增加参数 `preferStagedOnly: boolean`，auto 时调用强 staged 版本。

优点：
- 改动只在 `getDiff` 内部

缺点：
- 抽象变复杂；auto 模式仍可能在 pre-staged 文件为空时返回空——还是要 `git add -A` 前置
- 没有解决根因

## 推荐方案

**方案 A 主体 + 方案 B 的单测思路**：
- 主体走方案 A（最小修改 + 删除冗余功能）
- 顺手把 `getDiff()` 抽成可导出纯函数（不一定要拆成两个函数，单个 `getDiff({ strategy })` 即可）
- 加几个单测覆盖 untracked-only、staged-only、mixed、empty 四个场景
- 验证修复确实有效，避免回归

理由：
- 当前 `commit.ts` 主流程没有单测覆盖，正好借这次改动补齐
- 主流程变更需要测试兜底，否则后续容易再次回归

## 待确认事项

无（用户已确认全部 4 个待确认点）：
1. ✅ 范围 = 全部（gitignore 全删，stage-first 仅 --auto）
2. ✅ 同意方案 A + 单测补充
3. ✅ 加上更具体的错误信息
4. ✅ 三份文档全部同步

## 实施建议

按依赖顺序：

1. **重构**：把 `getDiff()` 抽成 `commit.ts` 内可导出的纯函数（例如 `getStagedDiff()` + `getWorkingTreeDiff()`），保持原 `getDiff()` 兼容封装
2. **写单测**：在 `tests/git-commit.test.ts`（或新建 `tests/commit-diff.test.ts`）覆盖：
   - 空仓库 → 两路 diff 都为空
   - 纯 staged → staged diff 有内容
   - 纯 untracked → 两路 diff 都为空（**这是被修复的场景**）
   - staged + untracked 混合 → staged diff 只有 staged 部分（修复前 auto 会因 untracked 漏掉）
3. **修改主流程**：`main()` 顶部按 `isAuto` 加 `git add -A`（带错误处理）
4. **清理**：`autoCommitAndPush` 删冗余 `git add -A`；增强空 message 错误输出
5. **删除 gitignore**：删 `suggestGitignore()` / `printGitignoreSuggestions()` 及 `if (!isAuto)` 调用块
6. **更新文档**：`overview.md` / `business.md` / `flows.md` 三份同步
7. **验证**：`bun test` 全绿 + `bun run lint` 无错 + 手动在纯 untracked 仓库跑 `--auto` 验证

风险点：
- auto 模式强制 stage 用户的 untracked 文件——用户原本在 auto 模式下也会被 `autoCommitAndPush` 强制 add，**净行为不变**
- 非 auto 模式不变（保留 Accept 文件选择能力）

## 结论

本次变更本质是**双清理**：
1. 移除 `.gitignore` 建议功能（噪音消除 + 节省一次 DeepSeek API 调用）
2. 修复 `--auto` 模式 pure untracked 场景的 bug（前置 `git add -A` 一次性解决）

核心约束是**保持非 auto 模式不变**——`Accept` 路径下的文件多选能力不能丢，所以 pre-stage 只作用于 `--auto` 模式。配套补单测、补错误信息、同步文档，避免后续回归。