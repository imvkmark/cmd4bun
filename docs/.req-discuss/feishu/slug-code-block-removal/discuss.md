# 下载文档时移除 slug 代码块 需求变更讨论

## 需求背景

飞书文档中包含用于标记 `human_path` 的 YAML 代码块（```` ```yaml ```` 内含 `slug: xxx`）。该代码块是内部解析机制，不应出现在最终下载的 `.md` 文件中。当前下载流程中 slug 代码块被原样保留在输出文件中。

同时发现 `downNode`（单节点下载）和 `runDownload`（批量下载）的内容处理逻辑不一致：`downNode` 有 slug 解析 + frontmatter 注入，`runDownload` 裸写文件。

## 讨论后的关键结论

- 新增 `parseAndStripSlug()` 函数：解析 slug 的同时移除整个 YAML 代码块
- 提取共享的 `processDocContent()` 函数，统一 `downNode` 和 `runDownload` 的内容处理
- 移除范围仅限包含 `slug:` 的第一个 YAML 代码块，其他 YAML 代码块保留
- 批量下载统一后将自动获得 frontmatter 注入和 `human_path` 更新能力
- DeepSeek 调用不需额外限流，飞书 API 的 QPS 限流已间接约束其速率

## 需求目标

下载文档保存为 `.md` 文件时，移除包含 `slug:` 的 YAML 代码块。同时统一 `downNode` 和 `runDownload` 的内容处理逻辑，消除两者之间的行为不一致。

**边界**：不移除其他 YAML 代码块；不改变 slug 的解析逻辑；不修改 DB schema。

## 当前流程

```
批量下载 (runDownload):
  fetchDocContent → Bun.write(filePath, content)  ← 裸写，无 slug 处理、无 frontmatter

单节点下载 (downNode):
  fetchDocContent → parseSlugFromContent
                  ├─ 有 slug: updateHumanPath → resolveDescription → buildFrontmatter
                  │            → Bun.write(filePath, frontmatter + content)
                  └─ 无 slug: Bun.write(filePath, content)
                  markNodeDownloaded
```

参考：
- `docs/feishu/overview.md`
- `docs/feishu/flows.md`
- `docs/feishu/business.md`

## 影响分析

### 1. download-flow.ts

- `downNode()`：用共享的 `processDocContent()` 替换当前的 slug 解析 + frontmatter 构建代码
- `runDownload()`：内部 worker 改为调用 `processDocContent()`，统一获得 slug 解析、frontmatter 注入能力
- 新增 `processDocContent()`：聚合 slug 解析 + 移除代码块 + DB 更新 + 描述生成 + frontmatter 构建

### 2. utils.ts

- 新增 `parseAndStripSlug(content)` 函数：在 `parseSlugFromContent` 基础上，同时返回移除 slug 所在代码块后的清理内容
- 移除规则：定位到第一个包含 `slug:` 的 YAML 代码块，将其完整替换为空

### 3. download-item-flow.ts

- 调用 `downNode()`，无需改动
- 行为变化：产出文件不再含 slug 代码块（预期行为）

### 4. images.ts（间接影响）

- `updateFrontmatterOgImage` 依赖 frontmatter 存在。批量下载统一后也会产出 frontmatter，`og:image` 回写对批量下载产出的文件也将生效

### 5. 级联副作用

- `runDownload` 统一后会触发 `updateNodeHumanPath` 和 `updateNodeDescription` DB 写入，之前这两列在批量下载中不会被更新
- `sync` 续传逻辑不受影响（续传只看 `downloaded_at` 和 `updated_at`）

### 6. 数据一致性与过渡

- slug 代码块移除是纯文本处理，不影响 DB 字段、不影响续传判断
- 已下载的存量 `.md` 文件不会自动回修，slug 代码块仍在，只有下次重新下载时移除
- 前端 Vitepress 渲染时 YAML 代码块仅作为 code fence 展示，不影响页面布局，无破坏性影响
- `sync` 阶段清理逻辑不受影响

## 方案对比

### 方案 A：提取共享处理函数 + 改造 parseSlug（推荐）

核心思路：
1. `utils.ts` 新增 `parseAndStripSlug(content)` → `{ slug, cleanedContent }`
2. `download-flow.ts` 新增 `processDocContent()` 共享函数
3. `downNode` 和 `runDownload` 内部 worker 统一调用 `processDocContent()`

优点：
- 消除两个下载入口的行为不一致
- slug 代码块不再泄露到最终文件
- 批量下载自动获得 frontmatter 注入能力

缺点：
- 批量下载首次运行时会触发 DeepSeek 描述生成（对无缓存的节点），增加少量耗时

实施复杂度：低

### 方案 B（不推荐）：仅移除代码块，不统一逻辑

只在 `parseSlugFromContent` 旁新增移除逻辑，`downNode` 和 `runDownload` 各自调用。

缺点：
- 不解决两个入口逻辑不一致的固有问题
- `runDownload` 仍然缺少 frontmatter 注入

## 推荐方案

方案 A。一次改动同时解决 slug 泄露和逻辑不统一两个问题。

## 待确认事项

- 无

## 实施建议

1. `utils.ts` 新增 `parseAndStripSlug()`，返回 `{ slug, cleanedContent }`
2. `download-flow.ts` 新增 `processDocContent()`，聚合完整的 slug→human_path→description→frontmatter 链路
3. `downNode()` 和 `runDownload()` 内部 worker 统一改为调用 `processDocContent()`
4. 更新 `docs/feishu/flows.md` 下载流程图，反映 slug 代码块移除步骤

## 结论

这次变更的本质是在下载管道中增加一道"内部标记清理"工序，同时修复了批量下载与单节点下载长期存在的逻辑不一致问题。改动范围小、风险低，且统一后的行为更符合 `business.md` 中描述的业务规则。
