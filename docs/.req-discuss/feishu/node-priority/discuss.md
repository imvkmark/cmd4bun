# node 优先级 需求变更讨论

## 需求背景

`cmd.feishu download` 在解析文档时，会通过 `resolveCiteBlocks`（[utils/blocks.ts:11](src/feishu/utils/blocks.ts#L11)）扫描文档内的 `<cite doc-id="...">` 块，尝试在 `nodes` 表里查被引方的 `human_path` 替换为 Markdown 链接。如果被引方不在索引或 `human_path` 为空，会打一条 warning 后保留原始 `<cite>` 标签——也就是说引用方下载下来了，但被引方还没就绪，引用是死链。

当前没有任何机制能反映"某节点被多篇文档依赖且尚未就绪"这一信号。下载队列的拉取顺序（[db.ts:141](src/feishu/db.ts#L141)）是 SQL 物理顺序（PK 顺序），与被依赖程度无关。

变更动机：

- **反映依赖信号**：让被多篇文档需要的节点优先下载
- **不引入额外概念**：复用 `nodes` 表，加一列即可，不引入新表或新子系统
- **下载时即时反馈**：刚下完就能感知到引用方还差什么，下次 `download` 自动把缺的补上

## 讨论后的关键结论

- **`nodes` 表新增 `priority INTEGER NOT NULL DEFAULT 0`**：单调累加，初始 0，无衰减无封顶
- **触发条件**：下载阶段，`resolveCiteBlocks` 的 callback 判定
  - ① 被引方在 `nodes` 表里查不到 → 跳过（不 +1，不创建占位行）
  - ② 被引方存在且 `human_path` 非空 → 正常返回
  - ③ 被引方存在但 `human_path` 为空 → `incrementNodePriority(db, docId)`，返回 null
- **每次未命中 +1**：同一篇文档中重复引用同一被引方 N 处 → +N；同一被引方被多篇文档引用 → 累加
- **下载队列按优先级排序**：`getDownloadQueue` 的 SQL 加 `ORDER BY priority DESC, node_token ASC`（`node_token ASC` 作 tie-breaker 保证 stable sort）
- **sync-updated-at 队列也按优先级排序**：3 处 `SELECT` SQL 都加 `ORDER BY`（实际效果受 QPS limiter 制约，但写出一致性更好）
- **`utils/blocks.ts` 零改动**：`resolveCiteBlocks` 保持纯函数，+1 副作用在 `download-flow.ts` 的 callback 闭包内完成
- **`sync` 流程零改动**：不主动重算存量 priority，迁移默认 0 即可
- **不引入 CLI flag**、**不引入占位行**、**不做衰减**

## 需求目标

为 `nodes` 表引入优先级字段，让下载阶段自动识别"被多文档依赖但尚未就绪"的节点，并在后续队列拉取中把它们排到前面。

**边界**：
- 不修改 `sync` 流程（不主动重算存量 priority）
- 不修改 `images.ts` / `copy-docs-flow.ts`（与 priority 概念无交集）
- 不修改 `purgeOrphanNodes` / `cleanupOrphanImages` / 图片管线
- 不修改 `utils/blocks.ts` 的对外签名（保持纯函数）
- 不为 DB 查不到的被引方创建占位行（确认跳过 +1）
- 不暴露 `--priority-min` 等 CLI flag
- 不做 priority 衰减/封顶

## 当前流程

```
runDownload(args):
  downloadQueue = getDownloadQueue(db, targetSpaces, force)
    → SQL: SELECT * FROM nodes WHERE space_id IN (...) AND obj_type IN ('doc','docx')
    → JS 层 needsDownload 过滤
    → 按 SQL 物理顺序（PK = node_token 字典序）

  for each node in downloadQueue (并发 worker):
    downNode(...)
      → processDocContent(content, title, updatedAt, db, node)
        → parseAndStripSlug(content)
        → resolveCiteBlocks(cleanedContent, (docId) => {
            const refNode = getNode(db, docId);
            return refNode?.human_path ?? null;   ← 仅查 human_path
          })
        → buildFrontmatter / 注入 / 保存

runSyncUpdatedAt(args):
  queue = SELECT node_token, obj_token, title, obj_type
          FROM nodes WHERE space_id IN (...) AND obj_type IN (...)
                      [AND updated_at_last_synced_at < ?]
    → 按 SQL 物理顺序
  for each node (Promise.all + QPS limiter 1.6 req/s):
    fetchNodeMetaAsync(...)
```

参考：
- [docs/feishu/overview.md](../../../feishu/overview.md)
- [docs/feishu/business.md](../../../feishu/business.md)
- [docs/feishu/flows.md](../../../feishu/flows.md)
- `src/feishu/db.ts`
- `src/feishu/download-flow.ts`
- `src/feishu/sync-updated-at-flow.ts`
- `src/feishu/utils/blocks.ts`

## 影响分析

### 1. `src/feishu/migrations/011_add_node_priority.sql`（新建）

```sql
-- 011: 新增 priority 字段，记录被未就绪被引方引用次数
-- 单调累加，默认 0；下载阶段 callback 在被引方存在但 human_path 为空时 +1
ALTER TABLE nodes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
```

依赖 `init-db-flow.ts:143-158` 已有的"duplicate column name → 跳过"幂等机制，无需额外防护。

### 2. `src/feishu/db.ts`

- `DBNode` 接口（[db.ts:11-28](src/feishu/db.ts#L11)）新增 `priority: number` 字段
- 新增函数 `incrementNodePriority(db, nodeToken)`：单行 `UPDATE nodes SET priority = priority + 1 WHERE node_token = ?`。SQLite 单行 UPDATE 对不存在的 row 影响 0 行，无需额外防护
- `getDownloadQueue`（[db.ts:141-150](src/feishu/db.ts#L141)）SQL 末尾加 `ORDER BY priority DESC, node_token ASC`

### 3. `src/feishu/download-flow.ts`

`processDocContent`（[download-flow.ts:36-42](src/feishu/download-flow.ts#L36)）的 callback 改造为三分支：

```ts
const { result: citeResult, warnings } = resolveCiteBlocks(
    cleanedContent,
    (docId) => {
        const refNode = getNode(db, docId);
        if (refNode === null) return null;                      // ① DB 查不到
        if (refNode.human_path) return refNode.human_path;      // ② 就绪
        incrementNodePriority(db, docId);                      // ③ 未就绪 +1
        return null;
    }
);
```

引入 `incrementNodePriority` import。

`utils/blocks.ts` 保持零改动，callback 签名 `(docId: string) => string | null` 不变。

### 4. `src/feishu/sync-updated-at-flow.ts`

3 处 `SELECT` SQL（[sync-updated-at-flow.ts:44-46, 62-64, 79](src/feishu/sync-updated-at-flow.ts#L44)）都加 `ORDER BY priority DESC, node_token ASC`：
- 单节点分支（`WHERE node_token=?`）实际上无意义但为了一致性也加
- 按空间分支（`WHERE space_id IN (...)`）
- 全量分支（`WHERE obj_type IN (...)`）

**注意**：sync-updated-at 实际下载行为受 QPS limiter 1.6 req/s 控制，加 ORDER BY 对 API 调用顺序影响微弱，主要价值是写出一致性和未来如果换 limiter 模型时有优先级基础。

### 5. 测试

**`tests/feishu/db.test.ts`**：新增 `describe('incrementNodePriority', ...)`，至少 3 个 case：
- 单次 +1：priority 0 → 1
- 多次累加：priority 0 → 3（连调 3 次）
- 不存在的 node_token：UPDATE 影响 0 行，不抛错

测试模式参考现有 `purgeOrphanNodes`（[db.test.ts:263-360](tests/feishu/db.test.ts#L263)）：用 `:memory:` SQLite + 直接 INSERT 测试数据 + 验证函数返回值。

**`tests/feishu/utils.test.ts`**：**零修改**——`resolveCiteBlocks` 的 callback 签名不变，现有 mock（[utils.test.ts:371-483](tests/feishu/utils.test.ts#L371)）全部继续通过。

### 6. 文档

**`docs/feishu/overview.md`**：
- `nodes` 表新增 `priority` 列说明（默认 0，下载阶段未就绪被引方 +1）

**`docs/feishu/business.md`**：
- "飞书文档下载"章节补充：priority 副作用（callback 三分支、未命中 +1 语义、单调累加）

**`docs/feishu/flows.md`**：
- `download` 流程图补充：callback 闭包内三分支
- `sync-updated-at` 流程图补充：队列加 `ORDER BY priority DESC, node_token ASC`
- "关键设计决策"补充："按引用需求度排序下载队列"

**README.md**（如需要）：在升级说明里加一句"新增 priority 字段，存量节点默认为 0，无需主动重算"。

### 7. 级联副作用

- **`copy-docs`**：不读 priority，无影响
- **`purgeOrphanNodes`**：删 node 时整行删除，priority 跟着消失，无额外动作
- **`downNode` 错误码 3380003 路径**（[download-flow.ts:99-137](src/feishu/download-flow.ts#L99)）：文档被删 → `deleteNodeByToken`（整行删除），无 priority 清理动作
- **`download --force`**：会让 priority 虚高（每次重下，cite 块未命中会重复 +1）。**已确认接受**，在文档中明确写出
- **sync 后 priority 不重置**：即使被引方后来下载完成、补上 human_path，priority 不会回退。保留"曾经被多文档未就绪引用"的历史信号

### 8. 数据一致性与过渡

- **迁移幂等**：依赖 `init-db-flow.ts:143-158` 的 duplicate column 处理
- **存量数据**：迁移默认 priority=0，不主动重算（重算需要扫所有 .md 文件解析 cite 块，IO 开销大且无业务价值）
- **短期不一致**：无——`incrementNodePriority` 是单行 UPDATE，失败时不影响下载主流程（下次 download 重新触发即可）
- **失败回滚**：不在事务里，与现有 `markNodeDownloaded` 等单行 UPDATE 同级别处理风格

### 9. 性能风险

- `incrementNodePriority` 是单行 UPDATE：单次 download 一篇文档的 cite 数通常 < 10，UPDATE 次数有限
- `ORDER BY priority DESC, node_token ASC`：priority 默认全 0 时排序开销可忽略（`node_token` 是 PK，自带索引）
- 队列加 ORDER BY 不会引入全表扫描

## 方案对比

### 方案 A（推荐）：callback 闭包内 +1，迁移 + DB 排序

**核心思路**：在 `processDocContent` 的 callback 内三分支判定，未就绪则调 `incrementNodePriority`。`utils/blocks.ts` 零改动，下载/sync-updated-at 队列 SQL 加 `ORDER BY`。

**优点**：
- 改动面收敛：5 个文件改 + 1 个迁移 + 1 个测试
- 现有 `resolveCiteBlocks` 测试零修改（callback 签名不变）
- `utils/blocks.ts` 保持纯函数，符合 architecture.md "依赖抽象"
- 与 `markNodeDownloaded` 等现有单行 UPDATE 同级

**缺点**：
- `download --force` 时 priority 虚高（已确认接受）
- 暂无衰减机制（设计选择）

**实施复杂度**：低

### 方案 B：把 +1 从 callback 拆出来，批量遍历

**核心思路**：让 `resolveCiteBlocks` 额外返回 `refDocs: string[]`（所有 doc-id 列表），由调用方串行遍历并批量 `incrementNodePriority`。

**优点**：
- 未来扩展（批量化、去重）更易

**缺点**：
- 让 `utils/blocks.ts` 多承担"收集引用事件"职责，违反单一职责
- 单次 download 的 cite 数量本来就小，批量化收益不明显

**实施复杂度**：中

**不推荐理由**：`utils/blocks.ts` 是纯工具模块，让它收集副作用事件会污染职责边界。

### 方案 C：在 `sync` 阶段做 priority 重算

**核心思路**：在 `sync-flow.ts` 跑完后，扫所有已下载 .md 文件解析 cite 块，批量给未就绪被引方 +1。

**优点**：
- download 流程的 callback 不需要改

**缺点**：
- "未就绪"信号延迟到 sync 后才反映到下载队列——用户期望"刚下载就能感知到引用问题"
- 需在 sync 阶段读所有 .md 文件 + 解析 cite 块，IO 开销大
- 与原始需求"下载时 +1"的语义直接冲突

**实施复杂度**：高

**不推荐理由**：与需求语义冲突。

## 推荐方案

**方案 A：callback 闭包内 +1 + SQL 队列排序**

理由：

- 严格对齐你需求里的"下载时未找到 → +1"和"获取 nodes 时按优先级"
- 改动面最小：`utils/blocks.ts` 不动、`sync-flow.ts` 不动、`images.ts` 不动
- 现有 `resolveCiteBlocks` 测试零修改
- 现有 `sync` 流程、续传逻辑、图片处理、orphan 清理全部不受影响
- `incrementNodePriority` 是单行 UPDATE，与 `markNodeDownloaded` 同级

## 待确认事项

- [x] "未找到"判定 —— ✅ `getNode` 查不到 或 `human_path` 为空
- [x] +1 对象 —— ✅ 被引方（前提是它在 `nodes` 表里存在）
- [x] 优先级模型 —— ✅ 整数（默认 0，无上限）单调累加
- [x] 应用环节 —— ✅ download 队列 + sync-updated-at 队列都按优先级
- [x] 重复计数 —— ✅ 每命中一次 +1（允许重复）
- [x] "DB 查不到"的被引方 —— ✅ 不处理（跳过 +1，不创建占位行）
- [x] `download --force` 虚高 —— ✅ 接受，文档中明确写出
- [x] `--node-token` 单节点模式 —— ✅ 不受 ORDER BY 影响
- [x] `copy-docs` / `purgeOrphanNodes` / 3380003 错误路径 —— ✅ 不需额外动作

## 实施建议

按优先级：

1. **`src/feishu/migrations/011_add_node_priority.sql`** 新建：`ALTER TABLE nodes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;`
2. **`src/feishu/db.ts`**：
   - `DBNode` 接口加 `priority: number`
   - 新增 `incrementNodePriority(db, nodeToken): void`
   - `getDownloadQueue` SQL 加 `ORDER BY priority DESC, node_token ASC`
3. **`src/feishu/download-flow.ts`**：`processDocContent` 的 callback 改为三分支，import `incrementNodePriority`
4. **`src/feishu/sync-updated-at-flow.ts`**：3 处 `SELECT` SQL 加 `ORDER BY priority DESC, node_token ASC`
5. **`tests/feishu/db.test.ts`**：新增 `describe('incrementNodePriority', ...)`，至少 3 个 case
6. **文档**：
   - `docs/feishu/overview.md`：nodes 表加 `priority` 列说明
   - `docs/feishu/business.md`：补充 priority 副作用
   - `docs/feishu/flows.md`：补充 download callback 三分支 + sync-updated-at ORDER BY
   - README.md 升级提示（"新增 priority 字段，存量默认 0"）
7. **验证**：
   - `bun run lint`
   - `bun test`（重点看 `tests/feishu/db.test.ts` / `tests/feishu/utils.test.ts` / `tests/feishu/download-flow.test.ts` / `tests/feishu/sync-updated-at.test.ts`）
   - `bun run build` 确认产物正常
   - （可选）手动跑 `cmd.feishu init-db` 验证迁移成功，跑一次 `download` 观察 priority 累加

## 结论

这次变更的本质是为 `nodes` 表引入"被依赖度"信号，让下载队列能反映"被多文档需要的节点优先就绪"这一业务诉求。改动收敛在 5 个文件 + 1 个迁移 + 1 个测试：`utils/blocks.ts` 保持纯函数，+1 副作用在 `download-flow.ts` 的 callback 闭包内完成，DB 层新增单行 `UPDATE` 函数，下载和 sync-updated-at 队列各加 `ORDER BY` 排序。`sync` 流程、图片管线、orphan 清理、`copy-docs`、CLI 入口全部零改动，向后兼容（迁移默认 priority=0，存量数据无感升级）。
