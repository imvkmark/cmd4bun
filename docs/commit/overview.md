# Git 提交辅助模块 (cmd-git-commit)

## 服务职责

AI 辅助 Git 提交信息生成与交互式文件暂存工具，负责展示仓库变更摘要，调用 DeepSeek API 生成 Conventional Commits 风格的中文提交说明，并提供交互式确认与文件选择。

## 模块结构

| 模块 | 职责 |
|------|------|
| `commit.ts` | CLI 入口：文件变更收集、树形展示、AI 提交信息生成、交互式菜单与文件多选、提交执行 |
| `config.ts` | XDG 配置文件加载（config.json）、token 解析（环境变量优先） |
| `shared/colors.ts` | ANSI 终端颜色常量 |

## 技术栈

| 组件 | 用途 |
|------|------|
| `fetch` (原生 HTTP) | 调用 DeepSeek 原生 `/chat/completions` API |
| `@inquirer/prompts` | Modify 模式下的人工输入 |
| Git CLI | 读取文件状态、diff、执行 add 和 commit |
| raw mode stdin | 交互式文件多选和菜单选择（TUI） |

## 功能入口

| 命令 | 说明 |
|------|------|
| `bun run src/commit.ts` | 完整流程：展示变更 -> 生成 message -> 文件选择 -> 提交 |
| `bun build ./src/commit.ts --compile --outfile ./bin/cmd.commit` | 编译为独立二进制，输出到 `bin/cmd.commit` |

## 配置

### 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `CMD_BUN_DEEPSEEK_TOKEN` | DeepSeek API token，优先级高于配置文件 | 是 |

### config.json

配置文件路径：`$XDG_CONFIG_HOME/cmd4bun/config.json`（未设置 `XDG_CONFIG_HOME` 时回退 `~/.config/cmd4bun/config.json`）

```json
{
  "deepseek": {
    "token": "sk-xxxxxxxx",
    "model": "deepseek-chat",
    "reasoningEffort": "high"
  }
}
```

| 字段 | 说明 | 必填 |
|------|------|------|
| `deepseek.token` | DeepSeek API token，优先级低于环境变量 | 否 |
| `deepseek.model` | DeepSeek 模型名称，默认 `deepseek-chat` | 否 |
| `deepseek.reasoningEffort` | 推理链强度，可选 `low` / `medium` / `high`，不配置时不启用 | 否 |

## API 依赖

| 服务 | 交互方式 | 说明 |
|------|---------|------|
| Git 工作区 | 本地 CLI 调用 | 读取变更文件、diff，执行 add 和 commit |
| DeepSeek API | HTTPS（原生 `/chat/completions` 接口） | 生成提交说明 |

## 边界说明

- 不负责判断 Git 提交内容是否业务正确，只辅助展示变更并生成提交说明。
- 不负责 DeepSeek 的账号登录、权限开通和 token 管理。
- 提交说明需要用户确认，不自动落地 AI 建议。

## 文档索引

- 业务逻辑 → [business.md](business.md)
- 执行流程 → [flows.md](flows.md)

## 开发约定与后续建议

- CLI 使用 `#!/usr/bin/env bun`，参数解析支持 `--help` / `-h`。
- 正常进度输出到 stdout，错误输出到 stderr；用户输入、环境或运行错误使用非零退出码。
- 外部命令调用优先使用参数数组传递，避免用字符串拼接方式执行包含动态内容的命令。
- 修改交互流程或提交策略时，同步更新 [business.md](business.md) 与 [flows.md](flows.md)。
- `--auto` 模式必须先执行 `git add -A` 把所有变更（含 untracked）暂存，再读取 diff 生成提交说明，避免纯 untracked 场景下 commit message 为空。

## 函数结构

| 函数 | 职责 |
|------|------|
| `main()` | 入口编排：配置加载、流程调度、异常处理 |
| `getFileChanges()` | 收集 staged / unstaged / untracked 变更 |
| `buildTree()` | 将文件路径构建为树形结构 |
| `printFileTree()` | 展示带颜色和状态图标的文件树 |
| `getDiff()` | 获取 diff（封装 `getStagedDiff` + `getWorkingTreeDiff`，优先 staged，fallback 到 working tree） |
| `generateMessage()` | AI 生成 Conventional Commits 格式提交说明 |
| `selectAction()` | 交互式菜单：Accept / Modify / Regenerate / Exit |
| `selectFiles()` | 交互式文件多选：Space 切换、Enter 确认 |
| `getStagedPaths()` | 获取已暂存文件路径集合 |
| `getStagedDiff()` / `getWorkingTreeDiff()` | 分别获取已暂存与未暂存的 diff 内容（`src/commit/diff.ts`） |
