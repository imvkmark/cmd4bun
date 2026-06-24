# 代码重构：修 Bug + 提取共享模块 需求变更讨论

## 需求背景

代码审查发现 14 项改进点，经讨论决定分两批推进。批次 1 聚焦零风险改动：修复 3 个已知 bug + 提取 2 个共享模块（DeepSeek 客户端、OSS 配置构建）。批次 2 处理 git-commit.ts 拆分。

## 讨论后的关键结论

- DeepSeek 客户端提取到 `src/shared/deepseek-client.ts`
- `buildOssConfig` 提取到 `src/config.ts`
- 批次 1 全部改动一次完成，不拆子 PR
- 批次 2（git-commit 拆分）在批次 1 完成后独立进行

## 需求目标

**批次 1**：修复 3 个 bug + 消除 DeepSeek API 调用和 OSS 配置构建的代码重复。不改变任何业务行为，不修改 DB schema，不新增依赖。

**边界**：不改变 CLI 接口、不改变输出格式、不改变 API 调用行为。

## 当前流程

### DeepSeek 调用点（3 处重复）

```
git-commit.ts:
  suggestGitignore()  → fetch('https://api.deepseek.com/chat/completions', ...)
  generateMessage()   → fetch('https://api.deepseek.com/chat/completions', ...)

feishu/api.ts:
  generateDescription() → fetch('https://api.deepseek.com/chat/completions', ...)
```

### OSS 配置构建（3 处重复）

```
sync-flow.ts:42-51        → 从 cfg.oss 构建 ossConfig 对象
upload-flow.ts:25-32      → 同上
download-item-flow.ts:61-71 → 同上
```

参考：
- `docs/feishu/overview.md`
- `docs/feishu/flows.md`

## 影响分析

### 1. tests/feishu/utils.test.ts

- 行 233：`cleanedContent` 声明未使用 → 移除解构中的变量
- 仅测试文件，无业务影响

### 2. tests/feishu/download-flow.test.ts

- 行 9：`DBNode` mock 缺少 `scanned_at` → 添加 `scanned_at: null`
- 仅测试文件，无业务影响

### 3. src/feishu/sync-updated-at-flow.ts

- 行 100：`written` 计数器声明但从未递增 → 在 `updateNodeUpdatedAt` 后 `written++`
- 仅影响终端输出统计，不影响 DB 写入

### 4. src/shared/deepseek-client.ts（新增）

- 新增 `chat()` 函数，统一 DeepSeek API 调用
- 影响 `git-commit.ts` 的 `suggestGitignore`、`generateMessage`
- 影响 `feishu/api.ts` 的 `generateDescription`
- API 行为不变

### 5. src/config.ts（新增 buildOssConfig）

- 新增 `buildOssConfig()` 函数
- 影响 `sync-flow.ts`、`upload-flow.ts`、`download-item-flow.ts`
- 纯配置解析，无业务影响

### 6. 级联副作用

- 无。所有改动为纯内部重构，不改变任何外部行为

### 7. 数据一致性与过渡

- 不涉及 DB schema 变更
- 不需要数据迁移

## 方案对比

### 方案 A：统一入口式 DeepSeek 客户端（推荐）

`chat(config, { systemPrompt, userPrompt, maxTokens, temperature, reasoningEffort })` → `string`

优点：
- 单一入口，token 解析统一
- 调用方只需传 prompt 参数
- 容易添加重试、日志等横切关注点

缺点：
- 不同调用方的差异化参数需要可选的 options 对象

### 方案 B：各调用方保留独立函数

不提取，只在各自文件中消除其他重复。

优点：无需新建文件

缺点：
- 3 处 API URL 和认证逻辑仍然重复
- 未来改 API 需要改 3 处

## 推荐方案

方案 A。所有差异（maxTokens、temperature、reasoningEffort）都可以通过可选的 `DeepSeekRequest` 参数表达。

## 实施建议

1. 先修 3 个 bug（各自 1 行）
2. 新增 `src/shared/deepseek-client.ts`
3. 新增 `buildOssConfig` 到 `config.ts`
4. 重构调用点
5. 运行 `bun test && bun run build` 验证

## 结论

批次 1 是一次零风险的代码卫生清理：修 3 个 bug、消除 2 处重复代码。所有改动不影响业务行为，为批次 2 的 git-commit.ts 拆分做好铺垫。
