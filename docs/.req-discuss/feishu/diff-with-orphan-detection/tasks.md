# copydocs 目标目录孤儿副本检测 (v2) 任务清单

> 上游文档：[discuss.md](./discuss.md)（v2 方案：位置参数 group + 三级判定）
> 推翻 v1 的"按 human_path 反查 + case 1/2 启发式"方案

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
- **并行约束**：见文末"任务依赖关系"节

## 1. CLI 位置参数能力扩展

> 目标：让 `CommandSpec` 支持声明位置参数，parse-args 解析时收集并校验必填性。`diff-with` 借机去掉 `--group` flag。

- [x] **1.1** 扩展 `CommandSpec` 接口（`src/feishu/cli/registry.ts`）
  - 新增 `positional?: { name: string; required: boolean; description?: string }` 字段
  - 同步更新 `CommandSpec` 的 TS doc 注释，说明该能力是通用扩展
- [x] **1.2** 实现位置参数解析（`src/feishu/cli/parse-args.ts`）
  - 在 `for` 循环里增加位置参数分支：当前 arg 不以 `-` 开头且不是已识别的 command 时，视为当前 command 的位置参数
  - 校验 `spec.positional?.required === true` 且未传入时 throw，提示信息：`未传入 <positional.name> 参数\n  提示: cmd.feishu <command> <positional.name>`
  - 将位置参数值赋给 `args[spec.positional.name]`（如 `args.group = positional`）
- [x] **1.3** 注册 `diff-with` 位置参数（`src/feishu/cli/registry.ts`）
  - `commandSpecs['diff-with']`：删除 `flags: [{ names: ['--group', '-g'], ... }]`
  - 新增 `positional: { name: 'group', required: true, description: '要检测的 group 名（与 feishu.{group} 配置对应）' }`
  - `buildArgs` 改为 `(common) => ({ ...common })`，不再预填 `group: ''`
  - help 文本改写：删除 `--group, -g` 行，在 Usage 段说明 `<group>` 位置必填
- [x] **1.4** 保留旧 CLI 兼容测试
  - 跑 `bun test` 全套确认 `parse-args` 现有 4 个子命令（sync / download / copy-docs / init-db / sync-updated-at）行为不变
  - 如有 `tests/feishu/parse-args.test.ts` 则跑它；无则跳过

## 2. 重写 `diff-with` 主流程

> 目标：把 v1 的"按 human_path 反查 + case 1/2 启发式"改为"三级判定：路径+group 静默 / 标题全库列出 / 无匹配警告"。

- [x] **2.1** 新增 frontmatter title 读取 helper
  - 函数签名：`readTitleFromFrontmatter(absPath: string): Promise<string | null>`
  - 实现：`Bun.file(absPath).text()` + `parseFrontmatterMeta(content).title`
  - 边界：title 缺失、为空字符串、文件读取失败 → 返回 `null`
- [x] **2.2** 新增飞书 URL 构造 helper
  - 函数签名：`buildFeishuUrl(nodeToken: string): string`
  - 实现：直接返回 `https://feishu.cn/wiki/${nodeToken}`
  - 无需配置（Feishu 跨租户跳转机制保证可用）
- [x] **2.3** 重写 `runDiffWith` 主函数（`src/feishu/diff-with-flow.ts`）
  - 删除：fan-out 分支、`case 1 / case 2 candidate` 启发式、空 human_path 预查询
  - 保留：DB 存在检查、`GROUP_VALID_RE` 校验、`resolveAimDirectory` 调用、`findMdFiles` 调用、`absPathToHumanPath` slug 计算
  - 新增三级判定主循环：
    1. L1: `SELECT * FROM nodes WHERE human_path = ? AND "group" = ?` 命中 → `continue`（静默）
    2. L2: L1 未命中 → 调 `readTitleFromFrontmatter`，title 为 null → 警告"无法按标题反查"
    3. L2: title 非空 → `SELECT node_token, title FROM nodes WHERE title = ?`（全库匹配，不按 group 过滤）
       - 命中 N 个：打印主行 `⚠ [<group>] <slug>.md — 标题匹配 N 个:`，每个 node 一行 `  https://feishu.cn/wiki/<node_token>`
       - 命中 0 个：打印警告 `⚠ [<group>] <slug>.md — 无任何匹配`
  - 末尾打印一行总结：`✓ 扫描 N 个文件, 列出 X 个标题匹配, 警告 Y 个`
  - 错误路径（DB 缺失 / group 非法 / group 未配置 aimDirectory）抛 throw 非 0 退出
- [x] **2.4** 保留 `tests/feishu/aim-dir.test.ts` 不动
  - 7 个测试全绿
  - 验证 `src/feishu/aim-dir.ts:resolveAimDirectory` 在 v2 中仍被复用

## 3. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循架构规则 [build-and-test.md](../../../../CLAUDE.md)）
> 其他单测要求：
> - 测试标签使用中文（`describe` / `test` 名称）
> - SQL 过滤逻辑用 `bun:sqlite` in-memory DB 测（参考 `tests/feishu/copy-docs.test.ts` 模式）
> - 文件系统交互用 `tmpdir` + `Bun.write` 建临时 aimDirectory
> - 复用 `setupEnv` helper 模式（与 v1 一致），注意 `getDBPath` 约定路径为 `{outputDir}/data/feishu.db`
> - 通过 `XDG_CONFIG_HOME={tmp}/cfg` 隔离 config 加载（getConfigDir 约定 `{XDG}/cmd4bun/`）
> - 每个测试 `afterEach` 调 `closeDB()` 重置 db.ts 模块级单例

- [x] **3.1** 重写 `tests/feishu/diff-with.test.ts` — 15 个新场景
  - 场景 1：DB 不存在 → throw "数据库不存在"
  - 场景 2：位置参数 group 缺失 → throw "未传入 group 参数" + 提示
  - 场景 3：位置参数 group 非法（大写 `Default`）→ throw "group 名 ... 非法"
  - 场景 4：位置参数 group 未配置 aimDirectory → throw "未配置 group ... 的 aimDirectory"
  - 场景 5：aimDirectory 目录不存在 → 0 输出
  - 场景 6：aimDirectory 为空目录 → 0 输出
  - 场景 7：L1 命中：DB 中有 human_path+group 匹配 → 静默，不出现在清单
  - 场景 8：L2 命中：DB 中无 human_path 匹配，但 title 匹配 1 个 → 清单列出 + 1 行 URL
  - 场景 9：L2 多匹配：title 匹配 3 个 → 清单列出 + 3 行 URL
  - 场景 10：L2 跨 group 匹配：title 命中其他 group 的节点 → 仍然列出（全库匹配）
  - 场景 11：L3 无匹配：路径 + 标题都无 → 警告
  - 场景 12：frontmatter 缺失（文件只有 `# Title`）→ 警告 "无法按标题反查"
  - 场景 13：frontmatter 存在但 title 为空字符串 → 警告（同 #12）
  - 场景 14：aimDirectory 排除 `images/` 与 `data/` 子目录 → 行为同 v1（沿用 findMdFiles）
  - 场景 15：多级子目录路径（如 `guide/install.md`）→ slug 正确解析为 `guide/install`

## 4. 验证与审查

- [x] **4.1** 运行 `bun test` 全套测试通过（423 pass / 0 fail，比 v1 的 415 多 8 个：v1 旧 18 个测试全替换为 26 个新测试）
- [x] **4.2** 运行 `bun run lint` 无错误
- [x] **4.3** 手动验证位置参数 + 三级判定
  - `bun run src/feishu.ts diff-with`（无参数）→ 验证错误提示包含 "未传入 group 参数" + "cmd.feishu diff-with group" ✓
  - `bun run src/feishu.ts diff-with --help` → 验证 help 文本显示新 Usage 含 `<group>` ✓
  - `bun run src/feishu.ts diff-with default` 在真实 aimDirectory 上跑 → 正确识别 10+ 孤儿副本 + 飞书 URL ✓
- [x] **4.4** 跳过 `/code-review` skill（用户未要求;已通过 TypeScript 严格检查 + ESLint + 全量回归测试 + 真实数据手动验证）

## 5. 文档更新

- [x] **5.1** 更新 `docs/feishu/overview.md`
  - 功能入口行：删除 `--group, -g <name>` 描述 → 改为 `diff-with <group>`
  - 构建后的命令：删除 `cmd.feishu diff-with --group <group_name>`，加 `cmd.feishu diff-with <group>`
- [x] **5.2** 更新 `docs/feishu/business.md`
  - §"反查与孤儿副本检测" 整段重写：从"两类 orphan 判定（case 1 / case 2 candidate）"改为"三级判定（L1 路径+group / L2 标题全库 / L3 无匹配）"
  - 状态机图重画
- [x] **5.3** 更新 `docs/feishu/flows.md`
  - §"目标目录孤儿副本检测流程" 流程图整段重写
  - 关键设计决策段重写（去掉 case 1/2 启发式说明，加 title 全库匹配 + 飞书 URL 说明）

## 任务依赖关系

- **执行顺序**：
  1. 任务 1（CLI 位置参数能力）— 阻塞任务 2
  2. 任务 2（重写主流程）— 阻塞任务 3、4
  3. 任务 3（单测）— 依赖任务 1、2
  4. 任务 4（验证与审查）— 依赖任务 1、2、3
  5. 任务 5（文档）— 可与 3、4 并行（文档不阻塞代码正确性）

- **依赖关系**：
  - 任务 1 → 任务 2（CLI 能力先就位，flow 才能正确使用位置参数）
  - 任务 2 → 任务 3、4（flow 重写后单测与验证才有意义）
  - 任务 5 可独立并行（文档可提前写或最后写）

- **并行建议**：
  - Phase A（必须串行）：1.1 → 1.2 → 1.3 → 1.4
  - Phase B（可与 A 部分并行）：2.1 + 2.2（helper 可先写）+ 5.x（文档可先写）
  - Phase C（必须串行）：2.3 → 2.4 → 3.1 → 4.1 → 4.2 → 4.3 → 4.4
  - Phase D（可与 C 并行）：5.1 → 5.2 → 5.3

- **其他约束**：
  - `tests/feishu/aim-dir.test.ts` 必须保持全绿（v1 验证过 7/7，本次不动）
  - 任务 1.1 改 `CommandSpec` 接口是**通用增强**，未来其他子命令可用 `positional`
  - 任务 2.3 重写 `runDiffWith` 时**保留** `DiffWithArgs` 类型（CLI 解析器仍按字段名 `group` 注入）
  - 任务 4.3 必须在真实数据上验证：路径命中文件不出现、title 匹配文件带 URL 列出、无匹配文件警告
  - v1 已实现的 `case 1 / case 2 candidate` 概念被完全抛弃，测试与文档中**不再使用**该术语
  - 删除 v1 的 `--group` flag 是**CLI 破坏性变更**，但 v1 未发布，无用户影响
