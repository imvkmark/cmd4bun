# 跨 group 引用解析为绝对 URL 需求变更讨论

## 需求背景

`cmd.feishu copy-docs` 按 `group` 把文档分发到不同 `feishu.{group}.aimDirectory`（参见 [group-classification](../group-classification/discuss.md)）。但 `<cite>` 与 `<sub-page-list>` 引用解析器始终输出相对 Markdown 链接 `[title]({human_path}.md)`，假定所有副本在同一目录树。当 group A 的文档引用 group B 的文档时，相对路径在物理隔离的归档目录之间会失效。

需求：跨 group 引用时，链接地址改为 B 的 `aimUrl + slug + .html`（绝对 URL），让跨 group 的引用在物理隔离的归档目录之间也能被读者正常点击。

## 讨论后的关键结论

- 仅当 **被引节点 group ≠ 当前节点 group** 时切换为绝对 aimUrl；同组维持相对 `.md` 路径（行为不变）
- 跨组但被引方 aimUrl 不可解析时（group 未配且 fallback `default` 也未配），保留原文 + warning，与现有 `resolveLink` 返回 `reason` 失败路径一致
- `ResolveLinkResult` 扩展为三态 `{ path } | { url } | { reason }`，与现有 `{reason}` 平行
- 新增 `resolveAimUrl(cfg, group)` helper 到 `aim-dir.ts`，与现有 `resolveAimDirectory` 对称
- `loadConfig` 提前到 `processDocContent` 函数顶部，让 cite/sub-page 两个 `resolveLink` 闭包可访问 cfg
- `default` group 视作普通 group（按字符串相等判断）
- sheet/file 节点 `upload_url` 改为走 `url` 分支（与跨组绝对 URL 共用，输出时不再追加 `.md`）
- `resolveLink` 闭包内完全取消 `incrementNodePriority` + `markNodeDownloaded` 调用（既包括 human_path/upload_url 未就绪分支，也包括 aimUrl 缺失分支）；保留这条防御性副作用的原始前提（"重下可补救"）已不成立—— aimUrl 是配置问题而非下载问题，靠重下无法修复

## 需求目标

在 `<cite>` 与 `<sub-page-list>` 引用解析时，按"当前节点 group 与被引节点 group 是否一致"动态选择输出形式：同组保持当前相对 `.md` 路径；跨组切到 `refGroupAimUrl + refNode.slug + .html` 绝对 URL；跨组但 aimUrl 不可解析走保留原文 + warning 失败路径。

**边界**：
- 不改 `<callout>` / `buildFrontmatter` og:url / DB schema / `copy-docs` / `diff-with`
- 不覆盖作者在 Markdown 正文里手写的相对路径
- 不 bump priority（理由：aimUrl 缺失是配置侧问题，下载重试不会自动修复；未就绪的 human_path/upload_url 同理——区分两类来源不再有意义，统一不 bump 更简洁）
- 不为 sheet/file 节点做跨组判断（`upload_url` 已是绝对 URL，沿用 `url` 分支直出）

## 当前流程

```
download (processDocContent):
  parseAndStripFrontmatter(content)             → { slug, ignore, group, cleanedContent }
  updateNodeIgnore / updateNodeGroup(db, ...)
  resolveCiteBlocks(cleanedContent, citeResolveLink)
    citeResolveLink(docId) → getNode(db, docId)
      - docx + human_path → { path: human_path }
      - sheet/file + upload_url → { path: upload_url }
      - 未就绪 → incrementNodePriority + markNodeDownloaded(null) + { reason }
  resolveSubPageListBlocks(citeResult, subPageResolveLink)
    subPageResolveLink(objToken) → getNodeByObjToken(db, objToken)  # 与 cite 同构
  resolveCalloutBlocks(...)
  → buildFrontmatter(title, slug, desc, updatedAt, aimUrl)         # aimUrl 仅给当前节点自身 og:url

copy-docs (fan-out):
  SELECT DISTINCT "group" FROM nodes WHERE <downloadable & not ignore>
  → 每个 group → feishu.{group}.aimDirectory → ./<human_path>.md
```

`blocks.ts:61` 输出 `\`[${title}](${linkResult.path}.md)\`` 始终追加 `.md`，是跨组引用失活的根因。

参考：
- `docs/feishu/overview.md`（`nodes.group` 列、`aim-dir.ts` 模块、`FeishuGroupConfig` schema）
- `docs/feishu/business.md`（`<cite>` / `<sub-page-list>` 解析规则、frontmatter 解析、下载章节）
- `docs/feishu/flows.md`（`processDocContent` 流程、删除文档清理路径）
- 历史讨论：[group-classification](../group-classification/discuss.md)（同源问题，本方案的前提）

## 影响分析

### 1. `src/feishu/utils/blocks.ts`（解析层）

- `ResolveLinkResult = { path: string } | { reason: string }`（blocks.ts:7）扩展为 `{ path } | { url } | { reason }`
- `resolveCiteBlocks`（line 22-66）输出端 `\`[${title}](${linkResult.path}.md)\`` 增加 `url` 分支：`\`[${title}](${linkResult.url})\``（不加 `.md`）
- `resolveSubPageListBlocks`（line 132-）输出端 `- [title](path.md)` 同构改造

### 2. `src/feishu/aim-dir.ts`（helper 层）

- 新增 `resolveAimUrl(cfg, group): string | null`，与 `resolveAimDirectory` 对称
- 复用 `resolveFeishuGroupConfig(cfg, group)` 实现 fallback 链：`feishu.{group}.aimUrl ?? feishu.default.aimUrl ?? null`
- 下载/复制/未来其他模块按 group 取 aimUrl 统一走这里

### 3. `src/feishu/download-flow.ts:32-155`（`processDocContent`）

- **cfg 加载时机**：函数顶部 `const cfg = await loadConfig();`（从 `:149` 提前）
- **cite 的 `resolveLink`（line 62-79）**：
  - sheet/file + upload_url → `{ url: upload_url }`（改走 url 分支）
  - docx + human_path + `refNode.group === currentGroup` → `{ path: human_path }`（不变）
  - docx + human_path + 跨组 + aimUrl 可解析 → `{ url: ${aimUrl}/${human_path}.html }`（按 buildFrontmatter:546 的拼接方式去掉首尾斜杠）
  - docx + human_path + 跨组 + aimUrl 不可解析 → `{ reason: \`cross-group 引用目标 group "${refNode.group}" 缺少 aimUrl 配置\` }`
  - 移除所有 `incrementNodePriority(db, docId)` + `markNodeDownloaded(db, docId, null)` 调用
  - 未就绪分支（human_path/upload_url 缺失）：`{ reason: ... }` 不变
- **sub-page 的 `resolveLink`（line 100-117）**：与 cite 同构，使用 `getNodeByObjToken` 取 `refNode`

### 4. `src/config.ts`

- 不改 `resolveFeishuGroupConfig` 签名
- 不改 `FeishuGroupConfig` 字段
- 不在 config.ts 内导出新 helper（`resolveAimUrl` 放在 `aim-dir.ts`）

### 5. 级联副作用

- **priority bump 取消**：`incrementNodePriority` / `markNodeDownloaded` 在两个 resolveLink 闭包内全部移除。被引节点未就绪或 aimUrl 缺失时不再触发提前重下（重下也救不了 aimUrl 缺失；human_path 缺失的"重下补救"语义现在统一让位给"作者修复后下次 download 自动覆盖写"）
- **og:url**：不变（`buildFrontmatter` 仍是当前节点自身的 aimUrl，与引用关系无关）
- **删除文档 3380003 清理路径**：不变
- **fan-out copy-docs**：不变
- **diff-with**：不变（只读副本清单）
- **图片处理**：不变
- **frontmatter 解析 / ignore / group**：不变

### 6. 数据一致性与过渡

- **存量数据**：纯解析期改造，不动 DB schema、不动 DB 行
- **覆盖写语义**：每次 download 重读 YAML，group 变化 → 跨组语义下次自动跟随
- **group 名修改**：作者把 `foo` 改成 `bar`，下次 download 后跨组关系重新计算；旧 aimDirectory 下副本不被自动迁移（沿用 group-classification 结论）
- **未配 aimUrl 的 group**：跨组引用走保留原文 + warning；warning 文本明确告诉用户"group X 缺少 aimUrl 配置"
- **存量 `.md` 中已有的相对路径**：本次不批量迁移，下次 download 自动重写；用户可手动 `download --force` 触发整库重下
- **default group**：按字符串相等判断（`default !== blog` 即跨组），不特殊处理

### 7. 性能风险

- 零额外网络请求、零大表扫描
- 闭包内 `resolveFeishuGroupConfig` 每次调用是 O(1) 对象属性查找
- `loadConfig` 提前到 `processDocContent` 顶部：函数内多次访问 cfg 是纯对象查找，零额外 IO
- 关闭 priority bump 后，被引节点不再被推到下载队列前端，整体下载顺序略更稳定（少副作用）

### 8. 测试影响

- `tests/feishu/utils.test.ts`：新增 `ResolveLinkResult` 三态转换用例（path → 加 .md；url → 不加 .md；reason → 原文）
- `tests/feishu/aim-dir.test.ts`：新增 `resolveAimUrl` 单测（命中 group / fallback default / 双未配）
- `tests/feishu/download-flow.test.ts`：覆盖两个 `resolveLink` 的四种分支（同组、跨组成功、跨组 aimUrl 缺失、未就绪）
- `tests/feishu/copy-docs.test.ts`：不变（与本次无关）

### 9. 文档同步

- `docs/feishu/business.md`：`<cite>` / `<sub-page-list>` 段落补充"跨组引用 → 绝对 aimUrl"业务规则
- `docs/feishu/flows.md`：`processDocContent` 流程图标注 resolveLink 的跨组分支与 cfg 提前
- `docs/feishu/overview.md`：`aim-dir.ts` 模块表追加 `resolveAimUrl`

## 方案对比

### 方案 A：扩展 ResolveLinkResult 三态 + 共享 resolveAimUrl helper（采纳）

**核心思路**：`ResolveLinkResult` 扩展为 `{ path } | { url } | { reason }`；新增 `resolveAimUrl` helper 到 `aim-dir.ts`；cite/sub-page 两个 `resolveLink` 闭包比 group → 跨组读 aimUrl → 缺失返回 reason；`blocks.ts` 按 `url` vs `path` 决定是否追加 `.md`。

优点：
- 与 commit 85fee67 的设计方向一致（用对象表达多态）
- 共享 helper 避免两处 resolveLink 重复 fallback 逻辑
- 类型显式承载"绝对 URL"语义，未来扩展不踩坑
- 不会误伤作者手写路径

缺点：
- `ResolveLinkResult` 是公开接口，扩展时需要同步更新 `blocks.ts` 两处调用方

实施复杂度：中

### 方案 B：让 path 直接携带绝对 URL（不采纳）

**核心思路**：`ResolveLinkResult` 不变；跨组时 `path` 直接放完整 URL 字符串；`blocks.ts` 检测 `path.startsWith('http')` 决定是否加 `.md`。

优点：`ResolveLinkResult` 类型零改动，改动点最少。

缺点：以字符串前缀判断 URL 是隐式约定；类型无表达力；未来扩展（https 之外 scheme、相对 URL 区分）易踩坑。

实施复杂度：低

### 方案 C：在 processDocContent 末尾做后处理扫描（不采纳）

**核心思路**：不改 blocks.ts；解析完后由 processDocContent 扫描结果文本，把"非同组"的 `[title]({refHumanPath}.md)` 替换为绝对 URL。

优点：解析器零改动。

缺点：后处理扫描无法区分 cite 产出 vs 作者手写相对路径，会误伤；实现复杂且语义不优雅。

实施复杂度：高

## 推荐方案

方案 A。理由：`ResolveLinkResult` 是最近 commit 85fee67 重构的"用对象明确多态"设计，扩展 `{ url }` 与该方向一致；`resolveAimUrl` 与现有 `resolveAimDirectory` 对称，下载与未来模块都能复用；类型显式承载"绝对 URL"语义比字符串前缀更稳健；不会误伤作者手写路径。

## 待确认事项

| # | 项 | 默认假设（已确认） |
|---|----|---------|
| 1 | `ResolveLinkResult` 扩展形态 | 三态 `{ path } \| { url } \| { reason }`，与现有 `{reason}` 平行 |
| 2 | 是否抽 `resolveAimUrl(cfg, group)` 到 `aim-dir.ts` | 抽，与 `resolveAimDirectory` 对称 |
| 3 | aimUrl 缺失时是否 bump 被引节点 priority | 不 bump（与未就绪分支一并取消） |
| 4 | `loadConfig` 加载时机 | 提前到 `processDocContent` 顶部 |

## 实施建议

按自底向上逐层落地，每个层落地后跑对应测试：

1. **类型层** `src/feishu/utils/blocks.ts` — `ResolveLinkResult` 三态扩展 + 两处输出同步 → `bun test tests/feishu/utils.test.ts`
2. **helper 层** `src/feishu/aim-dir.ts` — 新增 `resolveAimUrl` → `bun test tests/feishu/aim-dir.test.ts`
3. **下载层** `src/feishu/download-flow.ts` — cfg 提前 + 两个 resolveLink 同构改造 + 移除 bump → `bun test tests/feishu/download-flow.test.ts`
4. **lint + 全量测试** `bun run lint && bun test`
5. **文档同步** `docs/feishu/{overview,business,flows}.md`

## 结论

这次变更的本质是把引用解析从"始终相对路径"升级为"按 group 关系动态选择相对/绝对 URL"，并把"未就绪分支"原本隐含的 priority bump 副作用一并取消（aimUrl 是配置问题，重下无法补救）。改动集中在两个 `resolveLink` 闭包、`ResolveLinkResult` 类型扩展、一个新的 helper 函数；与现有 group-classification 架构契合（同套 group 解析、同样按 group 读 config）；未配 aimUrl 走保留原文 + warning 与现有失败路径语义一致。`{ path } | { url } | { reason }` 三态设计延续了最近 commit 85fee67 的"用对象明确多态"方向，未来扩展不同 scheme、不同后缀都不用动类型。