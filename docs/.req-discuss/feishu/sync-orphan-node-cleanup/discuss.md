# sync 孤儿节点清理 需求变更讨论

## 需求背景

设计验证 `src/feishu/sync-flow.ts` 时发现：当飞书侧的某个节点（doc/docx）从 API 不再返回（被删、被移出该空间、或 SKIP_TYPES 被排除）时，本地 SQLite 的 `nodes` 表对应行不会清理，造成 DB 残留。同时，Phase 2 本地文件清理逻辑只删"DB 没有但磁盘有"的文件，不动 DB 记录——所以"DB 有但节点已不在 API 中"的情况没有反向清理路径。

同步流程是断点续传、可疑标题扫描（`32n`）、文档下载（`download`）等下游命令的唯一索引来源，残留记录会影响所有下游行为。

## 讨论后的关键结论

- **修复 Gap 1**：每个 space 扫描循环结束后，新增节点级 diff：`DB 里有但本次 `fetchAllNodes` 没返回` 的节点视为孤儿，立即清理。
- **修复 Gap 2**：抽出 `purgeOrphanNodes(db, nodeTokens, outputDir, ossConfig)` 统一节点清理路径：`SELECT file_paths + image_pairs → DELETE nodes → rmSync 本地文件 → cleanupOrphanImages(内部副作用删除 images 行 + 清 OSS + 清本地 temp)`。
- **空间级清理分支同步迁移**：line 175-200 的空间删除逻辑改为先收集该空间所有 node_token，调 `purgeOrphanNodes`，再 `deleteSpace`。整段 line 188-200 的额外 images 清理块移除（避免重复）。
- **直接废弃 `deleteNodesBySpace`**：调用点全部改为 `purgeOrphanNodes`，删除 `db.ts` 中的 `deleteNodesBySpace` 函数。
- **行为兼容 `--spaces` 过滤模式**：节点级 diff 只针对本次实际扫描过的空间，不会误清未要求同步的空间。
- **顺序约束**：`cleanupOrphanImages` 必须在 `DELETE FROM nodes` 之后、`images` 行实际删除之前调用——images 行的删除由 `cleanupOrphanImages` 内部的 `deleteImageByMd5AndNode` 副作用完成（参 `src/feishu/images.ts:191`）。若先 `DELETE FROM images`，`getImageByMd5` 会返回 null，本地 temp 和 OSS 不被清理。

## 需求目标

`sync` 流程保证本地索引（`nodes` + `images` + 本地文件）与本次 API 扫描结果一致——本次扫到的进入索引，本次没扫到的（包括之前存在但本次缺失的）从索引、本地文件和 OSS 彻底清理。

**边界**：
- 不修改 `download`、`upload`、`sync-updated-at` 的核心流程。
- 不引入 `--prune` 开关（已确认"以本次扫描结果为准"，无歧义）。
- 不修改 per-node 图片 diff 逻辑和 `cleanupGlobalOrphans` 全局清理。

## 当前流程

```
runSync:
  Phase 1 扫描知识库元数据
    fetchSpaces() → 按 --spaces 过滤 targetSpaces
    for each space:
      fetchAllNodes(spaceId, name) → 遍历节点树
        填 nodeMap、upsert nodes 行（仅命中 FETCHABLE_TYPES 的节点）
        ↓
      [本讨论插入点] 节点级 diff:
        SELECT node_token FROM nodes WHERE space_id=?
        vs nodeMap.keys()
        差异 token → purgeOrphanNodes
    ↓
    [仅全量模式] 空间级清理:
      activeSpaceIds vs getSpaceIds(db)
      差异 space → 收集该空间 tokens → purgeOrphanNodes → deleteSpace

  Phase 2 清理过期本地 Markdown
    getAllIndexedFiles(db) vs findMdFiles(outputDir)
    删除不在索引中的本地文件
```

参考：
- [docs/feishu/overview.md](../../../feishu/overview.md)
- [docs/feishu/business.md](../../../feishu/business.md)
- [docs/feishu/flows.md](../../../feishu/flows.md)
- `src/feishu/sync-flow.ts`
- `src/feishu/db.ts`

## 影响分析

### 1. `src/feishu/sync-flow.ts`

- 每个 space `for await` 循环结束后新增一段节点级 diff（约 15 行）。
- line 167-203 空间级清理分支重构（约减 20 行），调用 `purgeOrphanNodes` + `deleteSpace`。
- line 188-200 的图片清理 try/catch 块移除（已在 `purgeOrphanNodes` 内部处理）。

### 2. `src/feishu/db.ts`

- 新增 `purgeOrphanNodes(db, nodeTokens, outputDir, ossConfig): { filePaths: string[] }`。
- 删除 `deleteNodesBySpace(db, spaceId)` 函数（已被 `purgeOrphanNodes` 替代）。
- **顺序约束（实施时务必遵守）**：`cleanupOrphanImages` 内部依赖 `getImageByMd5` 查 `ext` 来定位本地 temp 文件 + 删 OSS，因此 `images` 行必须保留到 `cleanupOrphanImages` 调用之后。正确顺序：`SELECT file_paths → SELECT (md5, node_token) pairs → DELETE FROM nodes → rmSync 本地文件 → for each pair: cleanupOrphanImages(db, [md5], node_token, ...)`（images 行由 `cleanupOrphanImages` 内部的 `deleteImageByMd5AndNode` 副作用删除，不在 `purgeOrphanNodes` 里手动 DELETE）。

### 3. `src/feishu/images.ts`

- 无代码改动。
- `cleanupOrphanImages` 复用，作为 `purgeOrphanNodes` 末段清理 OSS 与本地 temp 图片 + 删除 images 行的入口（副作用）。
- 调用时机确认：必须先 `DELETE FROM nodes`、再 `rmSync`、最后才调 `cleanupOrphanImages`——若先 `DELETE FROM images`，`cleanupOrphanImages` 内的 `getImageByMd5` 会返回 null，导致本地 temp 文件和 OSS 不被清理。

### 4. `tests/feishu/db.test.ts`

- 新增 `purgeOrphanNodes` 单测：
  - 空数组 → 直接返回 `{ filePaths: [] }`，不执行 SQL
  - 删 `nodes` 行
  - 同步删 `images` 行
  - 删本地 `.md` 文件（用 tmp dir 验证）
  - 收集的 md5 列表传给 `cleanupOrphanImages`

### 5. 级联副作用

- **`32n` 命令**：扫描的节点集合减少（已删节点不再出现），输出更准。
- **`download` 命令**：不再对已删节点反复尝试 `obj_token`，避免 404 错误日志污染。
- **`upload` 命令**：`cleanupGlobalOrphans` 仍然有效，作为兜底。但孤儿 `images` 行已经在 `sync` 阶段同步删掉，所以 `cleanupGlobalOrphans` 实际工作量下降。
- **`--spaces` 过滤运行**：被排除空间的节点仍残留（设计合理——用户没要求同步该空间）。如要彻底清理，需要不带 `--spaces` 运行一次全量同步。

### 6. 数据一致性与过渡

- 一次性迁移：本次 commit 后第一次 `sync` 会扫描所有空间并清理所有历史孤儿节点。无须额外迁移脚本。
- 存量 DB 中的孤儿节点：自然清理，不影响功能。
- 短期不一致：节点删除和图片清理在同一 `purgeOrphanNodes` 调用内完成，无中间状态。
- 失败回滚：当前 sync 流程不在事务里，单步失败只会留下部分清理结果，下次 sync 会继续 diff 出来清理。符合现有"幂等增量"风格。

## 方案对比

### 方案 A：最小改动——仅在 Phase 1 内嵌节点级 diff

在每个 space 扫描循环结束后，新增一段节点级 diff，不动现有空间级清理逻辑。

```ts
// 新增到 line 161 之后
const dbTokens = (db.query(...).all(...));
const orphans = dbTokens.filter(t => !nodeMap.has(t));
if (orphans.length > 0) {
    // 内联实现：DELETE nodes + rmSync 文件 + cleanupOrphanImages
}
```

**优点**：
- 改动局部（~30 行），风险低
- 与 `--spaces` 过滤模式天然兼容

**缺点**：
- "删节点"的逻辑在两处（节点级 diff + 空间级 line 175-200），存在重复
- 后续若改删除语义（比如加日志、加 `--prune`），需要双修
- 违反 architecture.md "单一职责"原则

### 方案 B：在 Phase 1 结束后统一 diff 清理

所有 space 扫描结束后，统一收集 `activeNodeTokens` 做 diff 清理。

**优点**：
- 集中在一处处理

**缺点**：
- `nodeMap` 只在每个 space 循环内可见，需要把每个空间的扫描结果合并到外部 Map
- 代码改动比方案 A 还大
- 没有解决"删节点逻辑分散"问题

### 方案 C（推荐）：抽出 `purgeOrphanNodes`，统一两处清理路径

**核心思路**：把 line 175-200 的"删 nodes + 删文件 + 清 images"抽成 `purgeOrphanNodes(db, nodeTokens, outputDir, ossConfig)` 函数，节点级 diff 和空间级 diff 都调它。`deleteNodesBySpace` 直接废弃。

```ts
// db.ts 新增
export function purgeOrphanNodes(db, nodeTokens, outputDir, ossConfig) {
    if (nodeTokens.length === 0) return { filePaths: [] };
    const placeholders = nodeTokens.map(() => '?').join(',');
    const filePaths = (db.query(`SELECT file_path FROM nodes WHERE node_token IN (${placeholders})`).all(...nodeTokens) as { file_path: string }[]).map(r => r.file_path);
    const imagePairs = (db.query(`SELECT md5, node_token FROM images WHERE node_token IN (${placeholders})`).all(...nodeTokens) as { md5: string; node_token: string }[]);
    db.run(`DELETE FROM nodes WHERE node_token IN (${placeholders})`, ...nodeTokens);
    for (const fp of filePaths) {
        const abs = join(outputDir, fp);
        if (existsSync(abs)) rmSync(abs);
    }
    for (const { md5, node_token } of imagePairs) {
        cleanupOrphanImages(db, [md5], node_token, outputDir, ossConfig);
    }
    return { filePaths };
}
```

**优点**：
- 单一职责：删除节点只有一条路径
- 符合 architecture.md "依赖抽象而非实现"
- 节点级清理和空间级清理行为完全一致（同一函数）
- 后续加 `--prune`、改日志、改 images 清理策略只改一处
- `deleteNodesBySpace` 直接废弃，调用点全部归一

**缺点**：
- 重构略大，要 touch 已工作的空间级清理代码
- 顺序约束：`cleanupOrphanImages` 必须在 `DELETE FROM nodes` 之后、images 行删除之前调用——images 行由 `cleanupOrphanImages` 内部的 `deleteImageByMd5AndNode` 副作用删除（参 `src/feishu/images.ts:191`）

**实施复杂度**：中

## 推荐方案

**方案 C：抽出 `purgeOrphanNodes`，统一节点级 / 空间级清理路径**

理由：architecture.md 要求"单一职责"+"依赖抽象"。方案 A 短期改动小，但"删节点"逻辑分散会让后续每次改动都要双修。方案 C 抽一次函数，多花的成本很小（多写 ~30 行，多改一处调用点），但消灭了一整类的潜在 drift。

images 行的清理通过 `cleanupOrphanImages` 的副作用完成（其内部调用 `deleteImageByMd5AndNode`，参 `src/feishu/images.ts:191`），不依赖后续 `upload` 流程的 `cleanupGlobalOrphans` 兜底——这样 sync 阶段就能完整清理孤儿，不再受 `cleanupGlobalOrphans` 时机的制约。

## 待确认事项

- [ ] `purgeOrphanNodes` 内的 `cleanupOrphanImages` 调用要不要用事务包起来？目前 sync-flow 整体不在事务里，建议保持现状，靠下次 sync 兜底。
- [ ] 节点级 diff 是否输出日志？建议：`console.log(`    ${C.yellow}−${C.reset} 清理 ${removedCount} 个孤儿节点`);`，与现有 writeProgress 风格保持一致。
- [ ] （已隐含解决）`cleanupOrphanImages` 的 md5List 入参：在 `purgeOrphanNodes` 实现里始终传 `[md5]`（单个元素数组），不存在空列表场景，无需额外短路保护。

## 实施建议

按优先级：

1. **`src/feishu/db.ts`**：新增 `purgeOrphanNodes` 函数（~30 行）。保留 `deleteNodesBySpace` 函数（待调用点全部迁移后移除）。先 grep 全仓 `deleteNodesBySpace` 引用。
2. **`src/feishu/sync-flow.ts`**：
   - line 175-200 重构为调 `purgeOrphanNodes` + `deleteSpace`，移除 line 188-200 整段。
   - line 161 之后新增节点级 diff 段。
3. **`tests/feishu/db.test.ts`**：新增 `purgeOrphanNodes` 单测。
4. **`src/feishu/db.ts`**：删除 `deleteNodesBySpace` 函数。
5. 跑 `bun run lint` 和 `bun test` 验证。
6. 手动 `cmd.feishu sync` 一次，验证孤儿节点被清理、日志输出正确。
7. 同步更新 `docs/feishu/flows.md`（索引同步流程图）和 `docs/feishu/business.md`（飞书知识库索引关键业务规则），反映"同步阶段同步清理孤儿节点"。

## 结论

这次变更的本质是补齐 `sync` 流程的反向清理路径——保证本地索引是"本次 API 扫描结果"的镜像，而不是"历史同步结果的累加"。改动虽然触及 `sync-flow.ts` 已工作的逻辑，但通过抽 `purgeOrphanNodes` 把删除语义收敛到一处，反而降低了后续维护成本。同时把 `images` 行同步删除，让孤儿清理不再依赖 `upload` 流程的 `cleanupGlobalOrphans` 兜底，数据一致性更稳。