# 飞书同步流程

## 数据库初始化流程 (cmd.feishu init-db)

```
┌─────────────────────────────────────────────────────┐
│                 cmd.feishu init-db                   │
│                                                     │
│  创建数据库及迁移执行                                 │
│  ┌───────────────────────────────────────┐         │
│  │ 创建 feishu.db（如不存在）              │         │
│  │   → 创建 _migrations 跟踪表            │         │
│  │   → 按文件名排序读取 SQL 迁移文件       │         │
│  │   → 事务中执行未应用的迁移              │         │
│  │   → 记录 applied_at 时间戳             │         │
│  │   → 输出迁移执行统计                    │         │
│  └───────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘
```

### init-db 详细流程

```
getDB(outputDir)                          → 创建/连接 SQLite
  ↓
CREATE TABLE IF NOT EXISTS _migrations   → 迁移跟踪表
  ↓
loadMigrations()                          → 读取 migrations/*.sql
  ↓
getAppliedMigrations(db)                  → 已应用集合
  ↓
for each pending migration:
  ├── 006_rebuild_images_pk.sql:
  │     → PRAGMA table_info(images)       → 检查 node_token 列
  │     → 已存在 → 跳过（标记为已应用）
  │     └── 不存在 → 执行重建
  ├── ALTER TABLE 类:
  │     → 列已存在（duplicate column name）→ 跳过
  │     └── 成功 → 记录 applied_at
  └── CREATE TABLE 类:
        → IF NOT EXISTS 保证幂等
  ↓
输出: N 已应用, M 已跳过
```

## 索引同步流程 (cmd.feishu sync)

```
┌─────────────────────────────────────────────────────┐
│                   cmd.feishu sync                   │
│                                                     │
│  扫描知识库元数据（快速）                            │
│  ┌───────────────────────────────────────┐         │
│  │ lark-cli 获取 spaces                   │         │
│  │   → BFS 遍历每个 space 的节点树        │         │
│  │   → 构建文档路径                       │         │
│  │   → 写入 SQLite (spaces + nodes 表)    │         │
│  │   → 清理已删除的远端 space             │         │
│  └───────────────────────────────────────┘         │
│                    ↓                                │
│  清理本地过期 Markdown 文件                          │
│  ┌───────────────────────────────────────┐         │
│  │ getAllIndexedFiles(DB)                │         │
│  │   vs findMdFiles(outputDir)           │         │
│  │   → 删除不在索引中的本地文件           │         │
│  │   → 清理空目录                         │         │
│  └───────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘
```

### 索引同步详细流程

```
fetchSpaces()                      → 获取所有知识库列表
  ↓
filter targetSpaces                → 按 --space 参数过滤
  ↓
for each space:
  fetchAllNodes(spaceId, name)     → BFS 遍历节点树（所有类型节点都进 nodeMap）
    ↓
  按 obj_type 分组计数:
    FETCHABLE_TYPES (doc, docx) → 计入"文档"
    其他类型 → 计入"其他类型"
    ↓
  buildPath(node, nodeMap)         → 仅 doc/docx 节点构建 file_path
    ↓
  续传判断 (仅 doc/docx 节点):
    若 nodes 表中 node 存在
    AND downloaded_at 非空
    AND 文件存在 → 保持 downloaded_at / human_path
    否则 → downloaded_at 清空
    ↓
  db.transaction()                 → 批量 upsert nodes（所有类型都写入）
    doc/docx: file_path = "{spaceDir}/{层级路径}.md"
    非 doc/docx: file_path = ""（占位，不生成本地文件）
    ↓
  upsertSpace                      → 更新空间元数据
    ↓
节点级 diff（每个 space 扫描结束）:
  SELECT node_token FROM nodes WHERE space_id=?
    vs
  nodeMap.keys()                    → 本次扫描到的节点集合
    → 差异 token（DB 有但本次未扫到）→ purgeOrphanNodes
      → DELETE nodes 行 + 本地 .md 文件 + cleanupOrphanImages 清 images 行/OSS/temp
    ↓
清理已删除的空间:
  全量扫描场景:
    getSpaceIds(DB) - activeSpaceIds → 已删除的空间
      → purgeOrphanNodes            → 删除节点 + 本地文件 + images
      → deleteSpace                  → 删除空间记录
  ↓
清理本地过期 Markdown:
  getAllIndexedFiles(DB)           → 索引中的非空 file_path 集合（过滤占位空字符串）
    vs
  findMdFiles(outputDir)           → 磁盘上的所有 .md 文件
    → 删除多余文件, 清理空目录
```

## 编辑时间同步流程 (cmd.feishu sync-updated-at)

```
┌─────────────────────────────────────────────────────┐
│              cmd.feishu sync-updated-at             │
│                                                     │
│  批量获取节点远端编辑时间                             │
│  ┌───────────────────────────────────────┐         │
│  │ 从 nodes 表查询待更新节点队列           │         │
│  │   → 并发调用 wiki +node-get API        │         │
│  │   → QPS 控制在 5（避免限流）            │         │
│  │   → 写入 updated_at 到数据库            │         │
│  │   → 输出成功/失败统计                   │         │
│  └───────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘
```

### sync-updated-at 详细流程

```
ensureDB(db)                              → 校验核心表存在
  ↓
查询队列（不按 obj_type 过滤，所有类型节点都进队列）:
  ├── --node-token: 单个节点
  ├── --space: 指定空间的所有节点
  └── 默认: 全部节点
  ↓
[可选] --max-age 过滤:
  updated_at_last_synced_at IS NULL OR updated_at_last_synced_at < cutoff
  ↓
并发获取 (QPS=5):
  for each node (Promise.all):
    fetchNodeMetaAsync(node_token, obj_type)
      → wiki +node-get API（内部支持 doc/docx/sheet/bitable/mindnote/slides/file）
      → 返回 { updated_at }
  ↓
db.transaction():
  for each result:
    updateNodeUpdatedAt(db, token, updated_at)
      → 同时写入 updated_at_last_synced_at = now()
  ↓
输出: N 写入, M 失败
```

## 文档下载流程 (cmd.feishu download)

```
┌─────────────────────────────────────────────────────┐
│                  cmd.feishu download                │
│                                                     │
│  检查索引依赖                                        │
│  ┌───────────────────────────────────────┐         │
│  │ 检查 feishu.db 是否存在                │         │
│  │   → 不存在则提示先运行 sync            │         │
│  └───────────────────────────────────────┘         │
│                    ↓                                │
│  下载节点（按 obj_type 分发到三条处理管线）          │
│  ┌───────────────────────────────────────┐         │
│  │ 从 nodes 表读取待下载队列               │         │
│  │   → 包含 doc/docx/file/sheet 四种类型   │         │
│  │   → downNode 按 obj_type 分发：         │         │
│  │      doc/docx → processDocContent:     │         │
│  │        解析 slug → 移除 slug 代码块     │         │
│  │        → 更新 human_path → 生成描述     │         │
│  │        → 注入 frontmatter → 保存 .md    │         │
│  │        → processImagesInFile 处理图片：  │         │
│  │          下载 → MD5 去重 → 上传 OSS     │         │
│  │      file → downFileNode:              │         │
│  │        lark-cli drive +download 下载    │         │
│  │        → OSS 上传 → 写 upload_url      │         │
│  │      sheet → downSheetNode:            │         │
│  │        lark-cli sheets +workbook-export │         │
│  │        → OSS 上传 → 写 upload_url      │         │
│  │   → 标记 downloaded_at=now              │         │
│  └───────────────────────────────────────┘         │
│                    ↓                                │
│  全局孤儿图片扫描（兜底）                            │
│  ┌───────────────────────────────────────┐         │
│  │ cleanupGlobalOrphans：                  │         │
│  │   → 扫描所有 .md 提取引用 MD5 集合      │         │
│  │   → 删除无人引用的孤儿图片              │         │
│  └───────────────────────────────────────┘         │
│                                                     │
│  注意：不清理本地文件（清理是 index 阶段的职责）      │
└─────────────────────────────────────────────────────┘
```

### 下载流程详细流程

```
检查 feishu.db 是否存在
  不存在 → 错误提示 + 退出
  ↓
getDownloadQueue(db, spaceIds, force)
  force=true  → doc/docx/file/sheet 全部节点
  force=false → JS 层过滤：downloaded_at 为空或 downloaded_at < updated_at
  ↓
并发下载 (workerCount = min(concurrency, queue.length))
  ↓
for each node in queue (并行 worker):
  downNode(outputDir, db, node)  → 按 obj_type 分发到不同处理管线
    ├── obj_type='file'   → downFileNode (OSS 通道)
    ├── obj_type='sheet'  → downSheetNode (OSS 通道)
    └── obj_type∈{doc,docx}:
        ↓
        fetchDocContent(obj_token)       → 调用飞书 API 获取 Markdown
          ├── try: docs_ai/v1/documents/{token}/fetch (format=markdown)
          └── fallback: docs +fetch (api-version=v2)
        ↓
        node.updated_at 从 DB 读取            → sync 阶段已通过 wiki +node-get 获取
          └── formatUpdatedAt(updated_at)       → frontmatter lastUpdated
        ↓
        processDocContent(content, title, updatedAt, db, node)  → 统一处理管线
          ↓
          parseAndStripSlug(content)    → 解析 slug + 移除 slug 代码块
          ├── 有 slug:
          │   ├── 返回 { slug, cleanedContent }  → cleanedContent 不含 slug 代码块
          │   ├── updateNodeHumanPath             → 写入 human_path
          │   ├── 检查 description 缓存:
          │   │   ├── DB 中已有 → 直接复用
          │   │   └── 无缓存:
          │   │       ├── resolveDescription(title, cleanedContent)
          │   │       │   ├── 提取 headings 或正文预览
          │   │       │   └── generateDescription() → DeepSeek API 摘要
          │   │       └── updateNodeDescription     → 写入 description
          │   ├── buildFrontmatter(title, slug, desc, updatedAt, aimUrl)
          │   │   ├── description / lastUpdated / head.meta[]
          │   │   └── 无 aimUrl 时跳过 og:url
          │   │       (aimUrl 按节点 group 取:feishu.{group}.aimUrl ?? feishu.default.aimUrl)
          │   └── 返回 { slug, processedContent: frontmatter + cleanedContent }
          └── 无 slug:
              └── 返回 { slug: null, processedContent: cleanedContent }
          ↓
        (同步) parseAndStripFrontmatter 同时解析 group(小写 [a-z0-9-]+) → updateNodeGroup
        (覆盖写;非法值降级 default)
          ↓
        resolveCiteBlocks(cleanedContent, cb)  → <cite> → [title](human_path.md)
          ↓
        resolveSubPageListBlocks(citeResult, cb)  → <sub-page-list> → Markdown UL
          ↓
        resolveCalloutBlocks(subPageResult)  → <callout> → ::: container
          ↓
        Bun.write(filePath, processedContent)  → 写入 .md 文件
        ↓
        markNodeDownloaded(node_token)   → 由 uploadImagesForNode 在图片处理完毕后写入 downloaded_at

  > processDocContent 由 downNode（单节点下载）和 runDownload（批量下载）共用，
  > 确保两个入口的内容处理行为完全一致。

  > callback 闭包内实现 priority 副作用：
  > - 被引方在 nodes 表中不存在 → 跳过（UPDATE 影响 0 行,无法 bump；警告提示作者先跑 sync）
  > - 被引方存在但 human_path / upload_url 未就绪 → incrementNodePriority(db, node_token) 把被引方优先级 +1
  > - 被引方存在且 human_path / upload_url 已就绪 → 直接返回路径(无副作用)
    (注：sheet/file 节点的引用通过 upload_url 解析,docx 走 human_path)
    (注：sub-page-list 用 obj_token 查节点 → 拿到 node_token 再 bump,与 cite 解析器行为对齐)
```


## 单节点下载流程 (cmd.feishu download --node-token)

**触发入口**：用户运行 `cmd.feishu download --node-token <token>` 或 `bun run src/feishu.ts download --node-token <token> [options]`<br>
**输出结果**：下载单个文档到本地，自动处理图片

### 执行序列

```mermaid
sequenceDiagram
    participant User as 用户
    participant CLI as cmd.feishu CLI
    participant DB as feishu.db
    participant API as 飞书 API

    User->>CLI: download --node-token &lt;node_token&gt;
    CLI->>DB: 查询节点信息
    DB-->>CLI: 返回节点元数据
    alt 节点已下载且未传 --force
        CLI-->>User: 跳过，提示已是最新
    else 未下载或强制下载
        CLI->>API: fetchDocContent(obj_token)
        API-->>CLI: Markdown 内容
        CLI->>CLI: 保存文件到本地
        CLI->>DB: markNodeDownloaded()
        CLI->>CLI: processImagesInFile() (默认随 download 执行)
        CLI->>DB: markNodeDownloaded() (在图片处理成功后)
        CLI-->>User: 下载完成
    end
```

### 步骤说明

| 步骤 | 动作 | 备注 |
|------|------|------|
| 1 | 传入 --node-token 启动下载 | 默认读取 `./docs/feishu` |
| 2 | 检查 feishu.db 是否存在 | 不存在则提示先运行 sync |
| 3 | 根据 node_token 查询节点信息 | 必须是已索引的节点 |
| 4 | 判断是否需要下载 | downloaded_at 为空或 downloaded_at < updated_at 时需下载，--force 强制下载 |
| 5 | 调用飞书 API 获取文档内容 | 返回 Markdown 格式 |
| 6 | 保存文件到本地 | 通过 downNode → processDocContent 统一处理：移除 slug 代码块、更新 human_path、生成描述、注入 frontmatter |
| 7 | 处理图片（默认执行） | processImagesInFile：下载 → MD5 去重 → 上传 OSS → 替换 Markdown → 节点级 diff |
| 8 | 写入 downloaded_at 时间戳 | 由 uploadImagesForNode 在图片处理成功后调用 markNodeDownloaded |

### 异常处理

| 异常场景 | 处理方式 | 影响范围 |
|---------|---------|---------|
| 索引数据库不存在 | 输出错误并提示先运行 sync | 下载无法进行 |
| 节点不存在 | 输出错误且退出 | 单个节点失败 |
| 飞书 API 调用失败 | 输出错误且退出 | 单个节点失败 |
| 文件写入失败 | 进程报错退出 | 下载失败 |
| 图片下载失败 | 不阻断下载，downloaded_at 写入正常；reason 透传（`HTTP 404` / `timeout (30s)` 等） | 单张图片失败 |
| 图片 OSS 上传失败 | 不阻断下载，downloaded_at 写入正常；reason 透传 aliyun CLI stderr 首行 | 单张图片失败 |
| 图片处理整体抛出异常 | downloaded_at 不写入 → 节点进入下次重试 | 节点级 |

## 可疑标题扫描流程 (cmd.feishu 32n)

> 该流程已移除。

## 复制文档流程 (cmd.feishu copy-docs)

```
┌─────────────────────────────────────────────────────┐
│                  cmd.feishu copy-docs                │
│                                                     │
│  检查索引依赖                                        │
│  ┌───────────────────────────────────────┐         │
│  │ 检查 feishu.db 是否存在                │         │
│  │   → 不存在则提示先运行 sync            │         │
│  └───────────────────────────────────────┘         │
│                    ↓                                │
│  分支分发(--group 是否传入)                          │
│  ┌──────────────────┬────────────────────────┐    │
│  │ --group <name>   │ (不传,fan-out)         │    │
│  │ SQL: + group=?   │ SELECT DISTINCT group  │    │
│  │ 单 group 处理    │ 串行多 group 处理      │    │
│  └──────────────────┴────────────────────────┘    │
│                    ↓                                │
│  复制节点                                            │
│  ┌───────────────────────────────────────┐         │
│  │ for each group:                       │         │
│  │   resolveAimDirectory(cfg, group)     │         │
│  │     → feishu.{group}.aimDirectory     │         │
│  │     → fallback feishu.default.*       │         │
│  │     → 缺失 → warn + 跳过(group)/报错  │         │
│  │   SELECT FROM nodes WHERE              │         │
│  │     <downloadable & not ignore>       │         │
│  │     AND "group" = ?                   │         │
│  │   mkdirSync + Bun.write               │         │
│  │     → aimDirectory/{human_path}.md    │         │
│  └───────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘
```

### copy-docs 详细流程

```
检查 feishu.db 是否存在
  不存在 → 错误提示 + 退出
  ↓
loadConfig()              → 检测老 feishu.aimDirectory/aimUrl 时打 stderr 警告
  ↓
args.group 是否传入:
  ├── 是 → 单 group 分支:
  │     resolveAimDirectory(cfg, args.group)  → aimDirectory
  │       ├── null → 报错退出
  │       └── 命中 → SELECT WHERE group=? + 复制
  └── 否 → fan-out 分支:
        SELECT DISTINCT group FROM nodes WHERE <copy 条件> ORDER BY group
          ↓
        for each group (串行):
          resolveAimDirectory(cfg, group)
            ├── null → console.log 警告 + 跳过该 group
            └── 命中 → SELECT WHERE group=? + 复制
          ↓
        汇总:处理 group 数 / 复制数 / 跳过数
```

### 关键设计决策

- **fan-out 自动发现**：无需维护 group 列表,DB 中所有出现过的 group 自动参与
- **串行而非并行**：复制按 group 字典序串行,避免 aimDirectory 之间的并发写入冲突;每个 group 内仍是单次 SQL + 多次 Bun.write
- **缺 aimDirectory 不阻断**：fan-out 模式下某个 group 缺配置只跳过该 group,其他 group 正常进行(用户可分批修复配置)
- **--group 严格模式**：显式指定 group 时未配置 aimDirectory 报错退出,避免静默丢失
- **删除文档时 aimDirectory 定位**：3380003 分支用节点当前 group 查 aimDirectory,fallback 到 default,再找不到跳过副本清理

## 关键设计决策

### 流程显式分离

数据库初始化、索引、编辑时间获取、下载（内置图片处理）、复制文档各阶段完全独立，用户可以按需重跑任意阶段，便于调试和故障恢复。各阶段通过共享的 SQLite 索引传递状态。

### MD5 去重

图片以内容 MD5 为唯一键。同一张图片出现在多篇文档中，只下载一次、只上传一次 OSS。大幅减少网络开销和存储成本。

### 续传机制

基于 `updated_at` 判断文档是否有更新。`sync` 扫描时保留已有文档的下载状态（不依赖 updated_at 比较），`sync-updated-at` 专门负责从远端获取编辑时间。下载阶段只下载 `downloaded_at` 为空或早于 `updated_at` 的文档。支持中断后继续（`--force` 可强制全量重下）。

### 已公网化图片跳过

图片 URL 属于 `oss.urlPrefix` 域名时，直接跳过，避免重复下载和上传。

### 并发控制

文档下载和图片处理分别使用 `createRateLimiter(qps)` 控制 API 调用频率，避免触发飞书 API 限流。图片下载有 30 秒超时保护。

### 按引用需求度排序下载队列

`download` 队列 SQL 末尾使用 `ORDER BY parent_node_token ASC, CASE WHEN downloaded_at IS NULL THEN 0 ELSE 1 END ASC, priority DESC, node_token ASC`：外层 `parent_node_token` 把同一父节点下的兄弟 / 子节点聚在一起，根节点（空串 / NULL）优先；中层 `downloaded_at IS NULL` 优先保证"无内容（从未下载）"先于"有内容（曾下载，需重下）"处理；`priority` 反映"被多文档需要但尚未就绪"的信号，越高越靠前；`node_token ASC` 作 tie-breaker 保证 stable sort。`sync-updated-at` 队列使用简化版 `ORDER BY priority DESC, node_token ASC`（不涉及父节点 / 内容状态维度）。详见 [business.md](business.md) 的"飞书文档下载"章节。

## 关键影响点

- **`parseArgs`**：影响同步范围、输出目录、是否强制下载、并发、限速参数。
- **`fetchSpaces` / `fetchChildNodes` / `fetchAllNodes`**：影响远端知识库扫描完整性。
- **`FETCHABLE_TYPES` / `SKIP_TYPES`**：影响哪些远端节点会进入本地同步范围。
- **`buildPath` / `sanitize`**：影响本地文件路径稳定性和跨平台安全性。
- **SQLite 索引 schema**：影响断点续传、增量同步。
- **`fetchDocContent` / Markdown 处理**：影响文档内容获取和降级转换质量。
- **`processImagesInFile` / `uploadToOSS`**：影响图片下载、去重、上传和 Markdown 链接替换。
- **`findMdFiles` / `cleanupEmptyDirs`**：仅在索引阶段使用，影响本地已删除远端文档的清理行为。
