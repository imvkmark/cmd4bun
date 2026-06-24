# `<sub-page-list>` 块解析需求变更讨论

## 需求背景

飞书文档正文中会出现一种内嵌引用形式：

```xml
<sub-page-list space-id="7562969962420109313" wiki-token="Hci8wDBB4iP7plklk1xcAkCwnpf">
  <sub-page doc-id="VDhGdtOBPoPKXxxbGmec3WZmnxb" file-type="docx" title="DISCARD"/>
  <sub-page doc-id="JLl3dpIjvoTMaFxGKy8cD3tBnmf" file-type="docx" title="EXEC"/>
  ...
</sub-page-list>
```

语义上等价于"父文档展示一组子文档的索引卡片"。当前 `src/feishu/utils/blocks.ts` 只解析 `<cite>` 块，`<sub-page-list>` 块原样保留在最终 .md 中，无法跳转、不可读。同步阶段已经在 `nodes` 表里索引了所有子文档的 `node_token` / `human_path` / `upload_url`，具备把这种块折叠为本地链接的全部条件。

需求：在下载管线中新增 `<sub-page-list>` 块解析能力，与现有 `<cite>` 解析平级。

## 讨论后的关键结论

- 新增 `resolveSubPageListBlocks` 函数，结构与 `resolveCiteBlocks` 对齐（同样接受 `resolveLink: (docId) => string | null` 回调，返回 `{ result, warnings }`）
- 子项解析行为完全对齐 cite：命中→Markdown 链接，未命中→保留原始 `<sub-page>` 标签 + 警告
- `file-type` 范围与 cite 策略不同：cite 只解析 `file-type=wiki` 的 `type=doc`；这里**全部解析** `docx` / `sheet` / `file` 三种（docx 走 `human_path.md`，sheet/file 走 `upload_url` 直出）
- **关键修正**（实施阶段用户指出）：sub-page 的 `doc-id` 是飞书文档对象 ID（`obj_token`），不是 wiki 树节点 ID（`node_token`）。cite 的 `doc-id` 是 `node_token`，两者语义不同。sub-page 的 `resolveLink` 回调必须按 `obj_token` 查 DB
- 在 `db.ts` 新增 `getNodeByObjToken(db, objToken)` 辅助函数（`WHERE obj_token=? LIMIT 1`），与现有 `getNode` 平级
- 整体块不删除：即使所有子项都未命中，`<sub-page-list>` 外壳保留，仅子项降级
- `space-id` / `wiki-token` 属性不参与解析（无 `resolveLinkByWikiToken` 需求），仅作信息保留
- 串联顺序：`parseAndStripFrontmatter → resolveCiteBlocks → resolveSubPageListBlocks → resolveCalloutBlocks`
- 不影响 DB schema、不影响 sync / copy-docs / 图片处理

## 需求目标

支持把飞书正文中的 `<sub-page-list>...<sub-page/>...</sub-page-list>` 块折叠为 Markdown 无序列表 `- [title](path)`，命中已索引的子文档时直接生成可点击链接，未命中的子项降级为原文并产生警告。目标是把这种"内嵌子文档索引"从不可读的 XML 块升级为可导航的本地链接列表，与现有 `<cite>` 解析行为对齐。

**边界**：
- `download` 阶段串联调用；`sync` / `copy-docs` / `init-db` 阶段不感知
- 不支持 file-type 非 `docx` / `sheet` / `file` 的子项（如 `bitable` / `mindnote`），保留原始标签
- 不解析 `space-id` / `wiki-token` 属性（仅作信息保留，不影响结果）
- 不新增 DB 列、不改 `nodes` 表 schema
- 现有无 `<sub-page-list>` 块的文档行为零变化（`replace` 无副作用）

## 当前流程

```
processDocContent (download-flow.ts:39-78)
  ↓
parseAndStripFrontmatter(content)            → 移除 slug/ignore/group YAML 块
  ↓
resolveCiteBlocks(cleanedContent, cb)        → <cite> → [title](human_path.md)
  ↓
resolveCalloutBlocks(citeResult)             → <callout> → ::: container
  ↓
返回 processedContent → Bun.write(filePath)
```

`resolveCiteBlocks` 已有的关键能力（被新方案复用）：
- `parseHtmlAttrs` 解析 HTML 属性字符串
- `resolveLink` 回调闭包支持 docx / sheet / file 三种 obj_type 分流
- `{ result, warnings }` 返回结构与 warning 注入 `console.warn` 流程

参考：
- `src/feishu/utils/blocks.ts`（cite / callout 解析器实现）
- `src/feishu/utils/markdown.ts`（`parseHtmlAttrs` 工具）
- `src/feishu/download-flow.ts:57-78`（`processDocContent` 调用链）
- `tests/feishu/utils.test.ts:617-729`（cite 测试用例，覆盖命中/未命中/混合/属性缺失等场景）
- `feishu-docs/技能/Database/Redis 简介/文档/Set _ 集合.md:20`（sub-page-list 真实样例）

## 影响分析

### 1. `src/feishu/utils/blocks.ts`（核心实现）

- 新增 `resolveSubPageListBlocks(content, resolveLink): { result, warnings }` 导出函数
- 内部定义两个正则：
  - `BLOCK_RE = /<sub-page-list\b[^>]*>([\s\S]*?)<\/sub-page-list>/g`：匹配整块
  - `ITEM_RE = /<sub-page\b([^>]*?)\/>/g`：在块内匹配自闭合的 `<sub-page ... />` 子项
- 块替换函数闭包内：
  - 解析每个子项的 `doc-id` / `title` / `file-type` 属性
  - 缺 `doc-id` → 保留原文 + warning
  - `file-type` 非 `docx` / `sheet` / `file` → 保留原文（无 warning）
  - `resolveLink(docId) === null` → 保留原文 + warning
  - 命中 → `- [title](human_path.md)` 或 `- [title](upload_url)`
- 块内无任何子项命中也输出空（外壳丢弃），块内部分命中则仅降级未命中子项

### 2. `src/feishu/download-flow.ts`（串联调用）

- `processDocContent` 内的解析链路改为：
  ```
  resolveCiteBlocks(cleanedContent, resolveLinkCb) → citeResult
    → resolveSubPageListBlocks(citeResult, resolveLinkCb) → subPageResult
    → resolveCalloutBlocks(subPageResult) → resolvedContent
  ```
- `resolveLink` 闭包零改动直接复用（已经支持 sheet/file 走 upload_url）

### 3. `src/feishu/utils/index.ts`（re-export）

- 在第 9 行 `export { resolveCiteBlocks, resolveCalloutBlocks } from './blocks';` 追加 `resolveSubPageListBlocks`

### 4. `tests/feishu/utils.test.ts`（测试覆盖）

- 新增 `describe('resolveSubPageListBlocks', ...)`，1:1 复刻 cite 测试模式：
  - 多 sub-page 全部命中 → 输出完整 UL
  - 全部未命中 → 整块丢弃 + 每子项 1 条 warning
  - 部分命中 → 命中项变链接，未命中项保留原文
  - 缺 `doc-id` 属性 → 保留原文 + warning
  - 缺 `title` 属性 → 默认 `Untitled`
  - 空 sub-page-list 块 → 输出空字符串
  - `space-id` / `wiki-token` 不影响解析结果
  - file-type 为 `docx` 走 `human_path.md` 后缀
  - file-type 为 `sheet` / `file` 走 `upload_url` 直出（不加 `.md`）

### 5. 文档同步

- `docs/feishu/business.md` "飞书文档下载" 关键业务规则增加一条：`<sub-page-list>` 块解析
- `docs/feishu/flows.md` 下载流程详细流程的 ASCII 流程图中串联步骤之间增加 `resolveSubPageListBlocks` 节点

### 6. 级联副作用

无。
- 不影响 DB schema
- 不影响 `sync` 阶段（sub-page-list 是下载期解析）
- 不影响 `copy-docs` 阶段（输出文件已含解析结果）
- 不影响图片处理管线

### 7. 数据一致性与过渡

- 不变更任何持久化数据，纯字符串转换
- 向前兼容：旧文档无 `<sub-page-list>` 块时 `replace` 无副作用
- 无需回填，无需迁移

## 方案对比

### 方案 A（推荐）：与 cite 完全平级的新函数

**核心思路**：在 `blocks.ts` 中新增 `resolveSubPageListBlocks(content, resolveLink): { result, warnings }`，结构与 `resolveCiteBlocks` 对齐。闭包内对每个 `<sub-page .../>` 调用 `parseHtmlAttrs` + `resolveLink` 查 `human_path` / `upload_url`，最后拼接成 markdown UL。

**优点**：
- 与 `resolveCiteBlocks` 同模式，代码风格统一，新人理解成本低
- 回调签名一致，`processDocContent` 内的 `resolveLink` 闭包零改动直接复用
- 单元测试可 1:1 复刻 cite 测试（命中/未命中/部分命中/属性缺失等）
- 不影响 `<cite>` 解析的现有行为
- 单一职责，未来再加 `<mention>` 等新块可继续平级扩展

**缺点**：
- 多了一次正则扫描（一般一篇文档 1 个 sub-page-list 块，可接受）
- 全未命中时会刷 N 条子项 warning（与 cite 行为一致，告警噪音可接受）

**实施复杂度**：低。`blocks.ts` 增加约 30-40 行，测试约 80-100 行，download-flow.ts 1 行串联调用。

### 方案 B：扩展 `resolveCiteBlocks` 同时处理 sub-page-list

**核心思路**：在 `resolveCiteBlocks` 内部先扫一遍 `<sub-page-list>` 块（独立正则），再扫原 cite。

**优点**：调用方只调一次解析函数，串联步骤少一处。

**缺点**：
- 函数职责膨胀（同时管两类不同语义的块）
- 测试组合爆炸，回归风险高
- 后续如果再加新块（如 `<mention>`），函数会持续膨胀
- 违反"单一职责"原则

**不推荐**。

## 推荐方案

采用**方案 A**。理由：

1. **职责清晰**：解析器层按块类型分函数，`<cite>` 和 `<sub-page-list>` 是两种不同语义的引用形式，不应混在一个函数内
2. **测试粒度好**：每个块类型独立 `describe`，回归定位精准
3. **扩展性优**：未来需要解析新块（如 `<mention>` / `<code-block-meta>`）时，沿用平级方案即可
4. **实施成本低**：约 30-40 行实现 + 80-100 行测试，1 行串联调用

## 待确认事项

- [x] 解析行为：与 cite 完全对齐（命中→链接，未命中→原文+警告）
- [x] file-type 范围：全部解析 `docx` / `sheet` / `file`（docx 走 human_path.md，sheet/file 走 upload_url）
- [x] 整体失败处理：子项逐个降级，外壳保留
- [ ] 警告文案格式：是否在 warning 中带文档标题前缀（便于定位"哪篇文档的 sub-page 未命中"）— **待实施时决定**，`processDocContent` 调用方已统一加 `node.title:` 前缀（参考 download-flow.ts:50），无需在函数内重复

## 实施建议

按以下顺序落地：

1. **`src/feishu/utils/blocks.ts`**：新增 `resolveSubPageListBlocks` 导出函数（约 30-40 行）
2. **`src/feishu/utils/index.ts`**：在 line 9 追加 `resolveSubPageListBlocks` re-export
3. **`src/feishu/download-flow.ts`**：在 `processDocContent` 内 `resolveCalloutBlocks(citeResult)` 前插入 `resolveSubPageListBlocks(citeResult, ...)`，warning 注入到现有 `console.warn` 循环
4. **`tests/feishu/utils.test.ts`**：新增 `describe('resolveSubPageListBlocks', ...)` 覆盖 9 个用例
5. **文档同步**：更新 `docs/feishu/business.md` 关键业务规则 + `docs/feishu/flows.md` 流程图

验证标准：
- `bun test tests/feishu/utils.test.ts` 全部通过
- `bun run lint` 无错
- 在 `feishu-docs/技能/Database/Redis 简介/文档/Set _ 集合.md` 等真实样例上跑 `download --force`，确认 `<sub-page-list>` 块输出为 `- [SADD key member [...]](...).md` 形式的 UL

## 结论

本次变更的本质是在飞书同步管线的"内容处理"环节新增一种 XML 块到 Markdown 的转换规则。关键决策是与 `<cite>` 解析平级新增独立函数（方案 A），保持单一职责和扩展性；范围上 `file-type` 比 cite 更宽（覆盖 docx/sheet/file 三种）；失败处理上与 cite 一致（保留原文 + warning）。整体无 schema 变更、无 sync / copy-docs / 图片管线影响，是一次纯粹的解析器扩展。
