# sync 排除 aimDirectory & callout 内部 `<a>` 链接替换 需求变更讨论

## 需求背景

飞书同步工具有两条独立的体验缺陷需要一并修复：

**缺陷 1：sync 误删 copy-docs 目标副本**
`cmd.feishu sync` Phase 2（`src/feishu/sync-flow.ts:217-271`）递归遍历 `outputDir`（`feishu.dir`）下所有 `.md` 文件，对比 DB 中 `nodes.file_path` 集合，删除"磁盘有但 DB 没有"的文件。当 `outputDir` 与任一 group 的 `aimDirectory` 存在包含或重叠时（典型：`feishu.dir=./docs`、`default.aimDirectory=./docs/blog`；或 `feishu.dir=./docs/feishu`、`default.aimDirectory=./docs/feishu/sub`），`copy-docs` 写入 aimDirectory 的副本会被 sync 误删。

**缺陷 2：callout 内部 HTML 链接在 VitePress 不渲染**
`src/feishu/utils/blocks.ts:91-116` 的 `resolveCalloutBlocks` 只替换外壳（`<callout emoji="X">` → `::: type X`、`</callout>` → `:::`），内部 HTML 完全不动。飞书 callout 内容常带 `<a href="...">text</a>` 锚点，落到 VitePress `:::` 容器里不会自动渲染成可点链接（VitePress 把容器内容按 Markdown 解析，且需 `[text](url)` 形式以应用主题链接样式）。本次需在 callout 内部对 `<a>` 链接做 href 替换，且**保持 `<a>` 标签形态**（不用 Markdown 格式）。

需求：
1. sync 始终排除所有 `feishu.{group}.aimDirectory` 子树下的 `.md` 文件
2. callout 内部 `<a href="token">text</a>` → `<a href="组合url">text</a>`（保持 `<a>` 标签形态，只换 href；http(s) 完整 URL 原样保留）

## 讨论后的关键结论

### 缺陷 1（sync 排除 aimDirectory）

- 始终排除：sync 在删除前跳过所有 `cfg.feishu` 中 `aimDirectory` 子树下的 `.md`，与 `outputDir` 和 `aimDirectory` 是否实际重叠无关（重叠是触发条件，但排除是普适行为，避免未来路径重构再次踩坑）
- 新增 `collectAllAimDirectories(cfg): string[]` helper 到 `src/feishu/aim-dir.ts`，与现有 `resolveAimDirectory` / `resolveAimUrl` 形成"config group 系列"对称
- 收集所有 `cfg.feishu.{group}.aimDirectory`（含 `default` fallback），resolve 为绝对路径；缺 `default.aimDirectory` 时该 group 不进排除集
- Phase 2 日志分两段：删除数 N + 排除 aimDirectory 数 M

### 缺陷 2（callout 内部 `<a>` 替换）

- 沿用 `ResolveLinkResult` 三态 `{ path } | { url } | { reason }`，与 cite / sub-page-list 完全对齐
- callout 内部 `<a href="X">text</a>`：
  - href 为 `http(s)://` 完整 URL → 原样保留（外部链接）
  - href 为飞书 token → 走 `resolveLink` 四分支：
    - 同组 → `<a href="${human_path}.md">text</a>`
    - 跨组 + aimUrl 可解析 → `<a href="${aimUrl}/${human_path}.html">text</a>`（"组合 url"）
    - 跨组 + aimUrl 缺失 → 保留原文 + warning
    - 未就绪（human_path/upload_url 缺失）→ 保留原文 + warning
- **保持 `<a>` 标签形态，不转 Markdown**：与 cite / sub-page 行为不同（后者输出 Markdown），这是 callout 特有需求（VitePress `:::` 容器内允许 raw HTML，`<a href>` 也用 URL 解析语义）
- `resolveCalloutBlocks` 改签名 `(content, resolveLink) => { result, warnings }`
- download-flow 抽 `makeResolveLink(cfg, db, currentNode)` 共享闭包，cite / sub-page / callout 三处并入
- 其他 HTML 元素（`<aside>` / `<p>` / `<b>` / `<code>` / `<img>` 等）保持原样——本次只做 `<a>` 替换

## 需求目标

### 缺陷 1
`sync` 流程保证本地索引与本次 API 扫描结果一致的同时，**不删除**任何 `feishu.{group}.aimDirectory` 子树下的 `.md` 文件——这些文件由 `copy-docs` 阶段写入，属于另一条独立数据流（归档目录），sync 不应干预。

**边界**：
- 不修改 `copy-docs` / `download` / `sync-updated-at` 的核心流程
- 不修改 DB schema
- 不修改 `diff-with`（只读反查）
- 不改 Phase 1 节点级 diff 清理（`purgeOrphanNodes`，按 DB node_token 清理，与 aimDirectory 无关）
- 不动 `images/` / `data/` 子目录（已被 `findMdFiles` 排除）

### 缺陷 2
callout 块在 download 阶段被转换为 VitePress `:::` container 时，内部 HTML `<a>` 链接的 href 同步按"同组相对 / 跨组绝对 / 未就绪保留"四分支替换，保持 `<a>` 标签形态以兼容 VitePress `:::` 容器内的 raw HTML 渲染。

**边界**：
- 不改 callout 外壳替换逻辑
- 不处理 callout 内其他 HTML 元素（`<aside>` / `<p>` / `<b>` 等保持原样）
- 不处理 callout 内的图片（图片由 `processImagesInFile` 独立处理）
- 不为外部 URL（http(s)://）做 DB 反查
- 不 bump priority（与 cross-group-link 讨论结论一致：aimUrl 缺失是配置问题，重下无法自动修复）

## 当前流程

### 缺陷 1 相关流程

```
runSync (cmd.feishu sync):
  ┌─ loadConfig() (line 56)              ← cfg 已可用,无需新加
  │
  Phase 1 扫描知识库元数据
    for each space:
      fetchAllNodes → upsert nodes
      节点级 diff (DB 有但本次未扫到) → purgeOrphanNodes
    空间级清理 (全量模式) → purgeOrphanNodes + deleteSpace
  │
  Phase 2 清理过期文档 (line 217-243)
    indexedFiles = getAllIndexedFiles(db)
    localMdFiles = findMdFiles(outputDir)         ← 递归 outputDir
    for each mdFile in localMdFiles:
      if relPath not in indexedFiles:
        rmSync(mdFile)                            ← ⚠ 这里会误删 aimDirectory 副本
    cleanupEmptyDirs(outputDir)
  │
  Phase 2 末尾
    Image cleanup (best-effort)
```

参考：
- [docs/feishu/overview.md](../../../feishu/overview.md)
- [docs/feishu/business.md](../../../feishu/business.md)
- [docs/feishu/flows.md](../../../feishu/flows.md)（索引同步流程图、Phase 2 详细流程）
- [docs/.req-discuss/feishu/sync-orphan-node-cleanup/discuss.md](../sync-orphan-node-cleanup/discuss.md)（purgeOrphanNodes 抽取，Phase 1 清理路径）

### 缺陷 2 相关流程

```
processDocContent (download-flow.ts:35):
  parseAndStripFrontmatter → { slug, ignore, group, cleanedContent }
  updateNodeIgnore / updateNodeGroup
  resolveCiteBlocks(cleanedContent, citeResolveLink)        → { citeResult, warnings }
  resolveSubPageListBlocks(citeResult, subPageResolveLink)  → { subPageResult, warnings }
  resolveCalloutBlocks(subPageResult)                        → string  ← 仅外壳替换
  buildFrontmatter + 注入
```

`resolveCalloutBlocks`（blocks.ts:91-116）当前实现：

```ts
let result = content.replace(/<callout\s+emoji="([^"]*)">/g, (m, emoji) => {
    const type = emojiTypeMap[emoji] ?? 'info';
    return `::: ${type} ${emoji}\n`;
});
result = result.replace(/<\/callout>/g, '\n:::');
return result;
```

`citeResolveLink` 与 `subPageResolveLink`（download-flow.ts:80-146）当前实现几乎完全同构：

```ts
const citeResolveLink = (docId: string): ResolveLinkResult => {
    const refNode = getNode(db, docId);
    if (refNode === null) return { reason: 'doc-id 未在索引中找到...' };
    if ((refNode.obj_type === 'sheet' || refNode.obj_type === 'file') && refNode.upload_url !== null) {
        return { url: refNode.upload_url };
    }
    if (refNode.obj_type === 'docx' && refNode.human_path !== null) {
        if (refNode.group === node.group) return { path: refNode.human_path };
        const aimUrl = resolveAimUrl(cfg, refNode.group);
        if (aimUrl) return { url: `${aimUrl}/${refNode.human_path}.html` };
        return { reason: `cross-group 引用目标 group "${refNode.group}" 缺少 aimUrl 配置` };
    }
    return { reason: ... };
};
```

参考：
- [docs/feishu/overview.md](../../../feishu/overview.md)
- [docs/feishu/business.md](../../../feishu/business.md)（`<cite>` / `<sub-page-list>` 解析规则）
- [docs/feishu/flows.md](../../../feishu/flows.md)（`processDocContent` 流程图）
- [docs/.req-discuss/feishu/cross-group-link/discuss.md](../cross-group-link/discuss.md)（`ResolveLinkResult` 三态、`resolveAimUrl` helper 的来源）
- [docs/.req-discuss/feishu/sub-page-list-block/discuss.md](../sub-page-list-block/discuss.md)（sub-page 解析器先例）

## 影响分析

### 缺陷 1 影响分析

#### 1. `src/feishu/aim-dir.ts`（helper 层）

- 新增 `collectAllAimDirectories(cfg): string[]`
  - 遍历 `cfg.feishu` 所有 key，跳过 `dir`、跳过非 object 值
  - 对每个 `key` 取 `value.aimDirectory`，有值则 `path.resolve(process.cwd(), value.aimDirectory)` 收集
  - 若 `value.aimDirectory` 缺，回退到 `resolveFeishuGroupConfig(cfg, 'default')?.aimDirectory`（与 `resolveAimDirectory` 同构的 fallback 链）
  - 缺 `default.aimDirectory` 时该 group 不进排除集
  - 返回 string[]（去重后）

#### 2. `src/feishu/sync-flow.ts`（Phase 2 排除过滤）

- `loadConfig` 已在 line 56 调用，无需新增
- Phase 2 删除循环前：
  ```ts
  const aimDirs = collectAllAimDirectories(cfg);
  let excludedByAimCount = 0;
  ```
- 删除判断增加 aimDirectory 前缀过滤：
  ```ts
  for (const mdFile of localMdFiles) {
      const absMd = path.resolve(mdFile);
      const inAim = aimDirs.some(aim => absMd.startsWith(aim + path.sep) || absMd === aim);
      if (inAim) {
          excludedByAimCount++;
          continue;
      }
      const relPath = relative(outputDir, mdFile);
      if (!indexedFiles.has(relPath)) {
          rmSync(mdFile);
          ...
      }
  }
  ```
- 日志：`删除: N` 后追加 `, 排除 aimDirectory: M`
- 排除数大于 0 时打印每个排除文件的相对路径（沿用现有"已删除:"列表风格，但归到"已排除"分组）

#### 3. `src/feishu/utils/files.ts`

- 无改动
- `findMdFiles` 已被 `diff-with` / `download` 复用，本次不扩展其签名

#### 4. 级联副作用

- **`copy-docs` / `download` / `sync-updated-at`**：无影响（仅 sync Phase 2 删除逻辑加前置过滤）
- **`diff-with`**：无影响（只读反查 aimDirectory，不依赖 sync 的删除行为）
- **Phase 1 节点级 diff**（`purgeOrphanNodes`）：无影响（按 DB node_token 清理，与磁盘 aimDirectory 文件无关）
- **`images` 清理**：无影响（只清理被删除节点的关联图片，aimDirectory 文件不携带 image 关联）
- **`--spaces` 过滤模式**：aimDirectory 排除仍生效（与本次 scope 无关，cfg 全局读）

#### 5. 数据一致性与过渡

- **存量数据**：纯运行时行为改造，不动 DB schema、不动 DB 行
- **行为兼容**：用户现有 aimDirectory 文件不再被 sync 误删，相当于"补齐了 source 端反向清理路径"的镜像保护
- **路径重叠边缘 case**：若 aimDirectory 实际不在 outputDir 子树内（`feishu.dir=./docs/feishu`、`default.aimDirectory=./blog`），`findMdFiles` 本来就扫不到，排除是 no-op（zero cost）
- **未来可恢复**：若用户希望 sync 重新接管 aimDirectory 副本的生命周期，需要显式改造（不在本次范围）

#### 6. 性能风险

- 零网络请求、零大表扫描
- `collectAllAimDirectories` 一次性收集，O(groups) 复杂度
- Phase 2 删除循环每文件多 1 次 `path.sep` 字符串比较，量级仍是 O(localMdFiles)
- aimDirectories 数组去重后一般 ≤ 5 个 entry，开销可忽略

#### 7. 测试影响

- `tests/feishu/aim-dir.test.ts`：
  - 新增 `collectAllAimDirectories` 单测（多 group、含 default fallback、缺 default、重复路径去重）
- `tests/feishu/sync-flow.test.ts`（如不存在则新建）：
  - 验证 Phase 2 不会删除 aimDirectory 下的 `.md`
  - 验证 aimDirectory 文件被计入"排除 aimDirectory"统计
  - 验证 aimDirectory 外的过期文件仍被正常删除

#### 8. 文档同步

- `docs/feishu/business.md`：sync 流程"关键业务规则"补充 aimDirectory 排除语义
- `docs/feishu/flows.md`：Phase 2 流程图标注 aimDirectory 排除分支
- `docs/feishu/overview.md`：`aim-dir.ts` 模块表追加 `collectAllAimDirectories`

### 缺陷 2 影响分析

#### 1. `src/feishu/utils/blocks.ts`（解析层）

- `resolveCalloutBlocks` 改签名：
  ```ts
  export function resolveCalloutBlocks(
      content: string,
      resolveLink: (docId: string) => ResolveLinkResult
  ): { result: string; warnings: string[] }
  ```
- 块级匹配 `<callout emoji="X">...</callout>`（保留外壳 emoji→type 映射）
- 内部正则匹配 `<a href="([^"]+)"([^>]*)>([\s\S]*?)</a>`：
  - href 以 `http://` / `https://` 开头 → 原样保留
  - 其他 → 走 `resolveLink(href)`：
    - `{ path }` → `<a href="${path}.md">${text}</a>`
    - `{ url }` → `<a href="${url}">${text}</a>`
    - `{ reason }` → 保留原文 + warning
- 外壳替换 `<callout emoji="X">` → `::: type X` 与 `</callout>` → `:::` 不变
- warnings 数组与 cite / sub-page 一致

#### 2. `src/feishu/download-flow.ts`（共享闭包抽取）

- 新增内部 helper `makeResolveLink(cfg, db, currentNode)` 返回 `ResolveLinkResult` 函数：
  - 把 `citeResolveLink`（line 80-106）和 `subPageResolveLink`（line 121-146）的逻辑合并
  - 三个 `resolveLink` 实例（cite / sub-page / callout）都用这个 helper 生成
- `processDocContent` 内：
  - `const resolveLink = makeResolveLink(cfg, db, node);`
  - `resolveCiteBlocks(cleanedContent, resolveLink)`
  - `resolveSubPageListBlocks(citeResult, resolveLink)`
  - `resolveCalloutBlocks(subPageResult, resolveLink)`（新增）
  - warnings 遍历 + 累计 unresolvedRefCount
- unresolvedRefCount 现在累加三个解析器的 failures

#### 3. `src/feishu/aim-dir.ts`

- 无改动（`resolveAimUrl` 已在 cross-group-link 讨论中落地）

#### 4. 级联副作用

- **callout warnings 触发 unresolvedRefCount 累加**：与 cite / sub-page 一致，复用现有"未解析引用重下"机制
- **`buildFrontmatter` og:url**：不变（仍是当前节点自身 aimUrl）
- **删除文档 3380003 清理路径**：不变
- **fan-out copy-docs / diff-with**：不变
- **图片处理**：不变
- **frontmatter 解析 / ignore / group**：不变
- **priority bump 取消策略**：与 cross-group-link 一致，不为 callout 内未就绪引用 bump priority

#### 5. 数据一致性与过渡

- **存量数据**：纯解析期改造，不动 DB schema、不动 DB 行
- **覆盖写语义**：每次 download 重读 callout 内容，链接替换自动跟随被引节点状态
- **callout 内外部链接**：http(s):// 完整 URL 原样保留，行为兼容
- **存量 `.md` 中已有的 callout 内部 `<a>` 链接**：本次不批量迁移，下次 download 自动重写；用户可手动 `download --force` 触发整库重下

#### 6. 性能风险

- 零额外网络请求
- callout 块级匹配是 O(blocks)，内部 `<a>` 匹配是 O(a-tags-per-block)
- `resolveLink` 闭包内 `getNode` / `getNodeByObjToken` 已是 DB 单次查询，开销与现有 cite 解析一致
- `makeResolveLink` 抽取后三个 resolveLink 实例共享同一逻辑函数，零额外内存

#### 7. 测试影响

- `tests/feishu/utils.test.ts`：
  - 新增 `resolveCalloutBlocks` 用例：
    - 基本外壳替换 + 内部 `<a>` 飞书 token → 同组 `<a href="${path}.md">`
    - 跨组 + aimUrl 可解析 → `<a href="${aimUrl}/${path}.html">`
    - 跨组 + aimUrl 缺失 → 保留原文 + warning
    - 未就绪（human_path 缺失）→ 保留原文 + warning
    - 完整 URL（http(s)://）原样保留
    - 多 callout 块独立解析
    - 无 callout 时返回原内容
- `tests/feishu/download-flow.test.ts`：
  - 覆盖 `makeResolveLink` 四分支（同组 / 跨组成功 / 跨组 aimUrl 缺失 / 未就绪）
  - 覆盖 callout 内部 `<a>` 经共享 resolveLink 正确替换

#### 8. 文档同步

- `docs/feishu/business.md`：下载流程关键业务规则补充"`<callout>` 内部 `<a>` href 替换"段落
- `docs/feishu/flows.md`：`processDocContent` 流程图标注 `resolveCalloutBlocks` 新签名 + `makeResolveLink` 共享闭包
- `docs/feishu/overview.md`：`blocks.ts` 模块职责描述补充"callout 内部 `<a>` 链接替换"

## 方案对比

### 缺陷 1 方案对比

#### 方案 A：`collectAllAimDirectories` helper + Phase 2 前置过滤（采纳）

**核心思路**：`src/feishu/aim-dir.ts` 新增 `collectAllAimDirectories(cfg): string[]`，返回所有 group 的 aimDirectory 绝对路径；sync Phase 2 删除循环前判断每个文件是否落在任一 aimDirectory 下，是则跳过并计入"排除 aimDirectory"。

**优点**：
- 与 `resolveAimDirectory` / `resolveAimUrl` 形成"config group 系列"对称（cross-group-link 抽 `resolveAimUrl` 同构模式）
- 始终排除，与 outputDir / aimDirectory 是否实际重叠无关，避免未来路径重构再次踩坑
- 改动局部（~30 行 + 1 helper），不影响 Phase 1 清理、不影响其他子命令
- 排除路径的去重与 resolve 在 helper 内部完成，sync-flow 调用方零样板

**缺点**：
- aimDirectory 路径是 cfg 驱动的，加新 group 需保证 aimDirectory 配置正确（现状即如此，非本次引入）

**实施复杂度**：低

#### 方案 B：把 aimDirectory 排除塞进 `findMdFiles`（不采纳）

**核心思路**：`findMdFiles(dir, excludePaths?)` 接受排除路径参数，递归时跳过子树。

**优点**：`findMdFiles` 调用方无需各自做过滤。

**缺点**：
- `findMdFiles` 被 `diff-with` / `download` 复用，扩展签名需双修调用点
- sync 特有的"排除 aimDirectory"需求放在通用文件遍历 helper 里，违反单一职责
- aimDirectory 概念是 sync/copy-docs 的领域知识，不属于通用文件遍历

#### 方案 C：cfg 之外维护黑名单（不采纳）

**核心思路**：在 `config.json` 新增 `sync.excludePaths` 数组，sync 读该字段做过滤。

**优点**：用户可自定义排除范围。

**缺点**：
- 与 aimDirectory 配置重复（用户已在 `feishu.{group}.aimDirectory` 声明）
- 多一份配置心智负担
- 本次需求范围不需要自定义能力（YAGNI）

### 缺陷 2 方案对比

#### 方案 A：`resolveCalloutBlocks` 改签名 + `makeResolveLink` 共享闭包（采纳）

**核心思路**：`resolveCalloutBlocks` 接 `resolveLink` 回调返回 `{ result, warnings }`；download-flow 抽 `makeResolveLink(cfg, db, currentNode)` 内部 helper，cite / sub-page / callout 三处共享。

**优点**：
- 与 cross-group-link 讨论的设计方向一致（`ResolveLinkResult` 三态、共享闭包）
- callout / cite / sub-page 行为同构：URL 形态区分 + 四分支决策 + 共享 helper
- 警告与 unresolvedRefCount 复用现有机制
- 不为 callout 单独维护一份 resolveLink 函数体（DRY）

**缺点**：
- `resolveCalloutBlocks` 是公开接口，签名变更需要同步更新 `utils/index.ts` re-export
- `makeResolveLink` 让 `download-flow.ts` 共享逻辑更明显，函数体略增大（但消除重复）

**实施复杂度**：中

#### 方案 B：callout 内只换 href 不动 `<a>` 标签，但 resolveLink 单独写一份（不采纳）

**核心思路**：在 `download-flow.ts` 内单独写 `calloutResolveLink`，不复用 `makeResolveLink`。

**优点**：callout 解析器可独立演进。

**缺点**：三个 resolveLink 闭包逻辑几乎完全一样，分散维护违反 DRY；未来若要改一处决策逻辑（比如 sheet/file 分支），需要三处同步改。

#### 方案 C：把 callout 内容转 Markdown（不采纳）

**核心思路**：把 callout 内部从 HTML 整体转 Markdown（`<p>`→空行、`<b>`→`**`、`<a>`→`[](url)`、`<code>`→`` ` `` 等）。

**优点**：输出更"标准化 Markdown"。

**缺点**：
- 范围远超本次需求（用户明确"保持 `<a>` 标签形态"）
- 会动到 `<aside>` / `<p>` / `<b>` 等多种元素，引入大量边界 case
- 与"其他 HTML 元素保持原样"的最小改动原则相违背
- 实施复杂度高，易引入新 bug

## 推荐方案

### 缺陷 1：方案 A
`collectAllAimDirectories` helper + sync Phase 2 前置过滤。理由：与现有 `resolveAimDirectory` / `resolveAimUrl` 对称，符合"config group 系列 helper 集中在 `aim-dir.ts`"的模式；改动局部，风险低；始终排除语义避免未来路径重构再次踩坑。

### 缺陷 2：方案 A
`resolveCalloutBlocks` 改签名 + `makeResolveLink` 共享闭包。理由：与 cross-group-link 讨论的设计方向一致（`ResolveLinkResult` 三态 + 共享 helper）；保持 `<a>` 标签形态契合 VitePress `:::` 容器内的 raw HTML 渲染需求；DRY 让三处闭包共享同一份决策逻辑。

## 待确认事项

### 缺陷 1

| # | 项 | 默认假设（已确认） |
|---|----|---------|
| 1 | aimDirectory 排除是否考虑重叠 | 始终排除，与是否重叠无关 |
| 2 | 排除集范围 | 遍历 `cfg.feishu` 全部 group 的 `aimDirectory`（含 `default` fallback），缺 `default.aimDirectory` 时该 group 不进排除集 |
| 3 | 排除语义是否区分"未索引 vs 被排除"日志 | 区分：分别打印 `删除: N` + `排除 aimDirectory: M` |
| 4 | `collectAllAimDirectories` 放置位置 | `src/feishu/aim-dir.ts`，与 `resolveAimDirectory` / `resolveAimUrl` 对称 |
| 5 | 排除路径判定的边界（路径分隔符） | 用 `path.resolve` + `path.sep` 严格匹配，避免 `./` vs `/` 漏判 |

### 缺陷 2

| # | 项 | 默认假设（已确认） |
|---|----|---------|
| 1 | callout 内部 `<a>` 替换是否转 Markdown | **不转**，保持 `<a>` 标签形态，只换 href |
| 2 | href 为 `http(s)://` 完整 URL 时是否走 resolveLink | 不走，原样保留（外部链接） |
| 3 | callout 内其他 HTML 元素（`<aside>` / `<p>` / `<b>` / `<img>` 等）是否一并处理 | 不处理，保持原样——本次只做 `<a>` 替换 |
| 4 | callout 解析器是否 bump 被引节点 priority | 不 bump（与 cross-group-link 结论一致） |
| 5 | `makeResolveLink` 抽到独立文件还是 download-flow 内部 helper | download-flow 内部 helper（cite / sub-page / callout 三处闭包并入） |
| 6 | callout warnings 是否计入 unresolvedRefCount | 是，与 cite / sub-page 一致 |

## 实施建议

按自底向上逐层落地，每个层落地后跑对应测试：

### 缺陷 1 实施步骤

1. **`src/feishu/aim-dir.ts`** — 新增 `collectAllAimDirectories(cfg): string[]`
   - 遍历 `cfg.feishu`，收集所有 `aimDirectory`（含 `default` fallback）
   - `path.resolve(process.cwd(), aimDir)` 绝对化
   - 去重后返回
2. **`tests/feishu/aim-dir.test.ts`** — 新增 `collectAllAimDirectories` 单测
3. **`src/feishu/sync-flow.ts`** — Phase 2 删除循环加 aimDirectory 前置过滤
   - 顶部 `const aimDirs = collectAllAimDirectories(cfg);`（cfg 已 loadConfig）
   - 删除判断加 `inAim` 短路
   - 日志分两段：`删除: N` + `排除 aimDirectory: M`
4. **`tests/feishu/sync-flow.test.ts`**（如不存在则新建）— 验证 aimDirectory 不被误删 + 统计正确
5. **`bun run lint && bun test`**
6. **文档同步** — `docs/feishu/{overview,business,flows}.md`

### 缺陷 2 实施步骤

1. **`src/feishu/utils/blocks.ts`** — `resolveCalloutBlocks` 改签名
   - 接 `resolveLink` 回调，返回 `{ result, warnings }`
   - 块级匹配 + 内部 `<a>` href 替换（保持 `<a>` 标签形态）
   - http(s):// 完整 URL 原样保留
2. **`src/feishu/utils/index.ts`** — re-export 同步（`resolveCalloutBlocks` 已 re-export，无需新加类型）
3. **`tests/feishu/utils.test.ts`** — 新增 `resolveCalloutBlocks` 单测（外壳替换 + 内部 `<a>` 四分支 + 完整 URL 保留 + 多块独立解析）
4. **`src/feishu/download-flow.ts`** — 抽 `makeResolveLink(cfg, db, currentNode)` 共享 helper
   - `citeResolveLink` / `subPageResolveLink` / 新增 `calloutResolveLink` 都用 `makeResolveLink` 生成
   - `resolveCalloutBlocks(subPageResult, resolveLink)` 接新签名
   - warnings 遍历 + unresolvedRefCount 累加
5. **`tests/feishu/download-flow.test.ts`** — 覆盖 `makeResolveLink` 四分支 + callout 内部 `<a>` 替换
6. **`bun run lint && bun test`**
7. **文档同步** — `docs/feishu/{overview,business,flows}.md`

### 落地顺序建议

两个缺陷互相独立，可任意顺序落地。推荐：**先缺陷 2 后缺陷 1**，因为缺陷 2 涉及更多文件改动（`blocks.ts` / `download-flow.ts` / `utils/index.ts` / 两份测试），先做可以减少交叉 merge 冲突；缺陷 1 改动局部（`aim-dir.ts` + `sync-flow.ts`），可独立快速落地。

## 结论

这次变更同时修两条用户已撞到过的实际缺陷：

- **缺陷 1（sync 误删）**本质是补齐 sync 与 copy-docs 之间的"领地边界"——sync 管 source 端索引与本地文件，copy-docs 管 aimDirectory 归档副本；通过 `collectAllAimDirectories` helper 把"哪些目录归 copy-docs 管辖"声明在 cfg 维度，sync 在删除前尊重该边界。改动局部在 sync-flow.ts Phase 2 + aim-dir.ts 1 个 helper，与现有 `resolveAimDirectory` / `resolveAimUrl` 形成 config group 系列对称。

- **缺陷 2（callout 链接失活）**本质是把 callout 内部 HTML 链接的 href 替换接进现有的 `ResolveLinkResult` 三态决策体系，**保持 `<a>` 标签形态**以契合 VitePress `:::` 容器的 raw HTML 渲染需求。`makeResolveLink` 抽取让 cite / sub-page / callout 三处闭包共享同一份决策逻辑，DRY 收口为 download-flow 内部 helper。

两个缺陷都遵循"用对象表达多态" + "config group 系列 helper 集中"的现有架构方向，与 cross-group-link / sub-page-list-block 等历史讨论契合；新加的 `collectAllAimDirectories` / `makeResolveLink` 不破坏既有公开接口（`ResolveLinkResult` 三态、`resolveAimUrl` / `resolveAimDirectory` 签名），存量 `.md` 与 DB 行均不需迁移，下次 `download` / `sync` 自动覆盖。
