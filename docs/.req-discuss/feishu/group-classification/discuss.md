# 文档 group 维度归档需求变更讨论

## 需求背景

当前 `cmd.feishu copy-docs` 只能把所有 `human_path != ''` 的文档复制到 `config.feishu.aimDirectory` 这一个目录。但在实际使用中，飞书知识库会同时承载"主站文档"、"博客文章"、"内部知识库"等多种用途的文档，它们的归档目标和公网 URL 前缀完全不同。

需求：作者在飞书文档正文 YAML 代码块里追加 `group: <name>` 字段，标记该文档属于哪个分组；`copy-docs` 命令不指定分组时自动按 DB 中所有 unique group 分批复制到各自配置的 `feishu.{group}.aimDirectory`；`feishu.aimDirectory` / `feishu.aimUrl` 升级为 `feishu.default.*` 命名空间，为分组配置让位。

## 讨论后的关键结论

- `group` 字段加入 frontmatter 解析器（与 `slug`/`ignore` 同层），命名规则严格 `[a-z0-9-]+` 小写，校验失败降级为 `default`（不阻断下载）
- `nodes.group TEXT NOT NULL DEFAULT 'default'` 列由 download 阶段覆盖写、sync 阶段保留作者设置（沿用 `is_ignore` 模式）
- `copy-docs` 不指定 `--group` 时按 DB 中 unique group fan-out 串行复制；缺 `aimDirectory` 的 group 跳过 + warn
- `feishu.{group}.aimDirectory` / `feishu.{group}.aimUrl` 复用同一索引签名；不向后兼容老 `feishu.aimDirectory`，`loadConfig` 检测到时打 stderr 警告
- `download` 不加 `--group` 过滤（保持全量下载，group 仅在 copydocs 阶段消费）
- sheet/file 节点不解析 `group`（与 `ignore` 边界一致）
- 删除文档（3380003）时按节点的 `group` 字段定位对应 aimDirectory 进行副本清理

## 需求目标

支持文档按 `group` 维度归档：作者在 YAML 写 `group: foo` → 节点标记为 `foo` → `copy-docs` 不指定时自动按 DB 中所有 unique group 分批复制到各自 `feishu.{group}.aimDirectory`。目标是把"单归档目录"扩展为"按 group 多归档目录"，让不同来源/用途的文档物理隔离。

**边界**：
- `download` 不加 `--group` 过滤（保持全量下载）
- group 名严格 `[a-z0-9-]+`；不匹配则降级为 `default`（不阻断下载）
- 不为 sheet/file 节点解析 `group`（仅 doc/docx 走 frontmatter 解析路径）
- `nodes.group` 由 download 阶段覆盖写、sync 阶段保留（与 `is_ignore` 同模式）
- 不向后兼容老配置 `feishu.aimDirectory` / `feishu.aimUrl`（仅打 stderr 警告提示迁移）

## 当前流程

```
download (doc/docx):
  parseAndStripFrontmatter(content)  → { slug, ignore, cleanedContent }
  updateNodeIgnore(db, token, ignore ? 1 : 0)   // 覆盖写
  buildFrontmatter(... aimUrl: cfg.feishu?.aimUrl)  // 单 aimUrl
  → aimUrl/{slug}.html 写入 og:url

download 删除清理 (error 3380003):
  cfg.feishu?.aimDirectory  → 删除 aimDirectory/{human_path}.md

copy-docs:
  SELECT FROM nodes WHERE <downloadable & not ignore>
  → 单一 aimDirectory → 单次 Bun.write 复制
```

参考：
- `docs/feishu/overview.md`（`nodes` 表 schema、`FeishuConfig` schema）
- `docs/feishu/business.md`（frontmatter 解析、下载、复制文档章节）
- `docs/feishu/flows.md`（下载流程、删除文档清理路径）
- 历史讨论：[node-ignore-flag](../node-ignore-flag/discuss.md)（同模式参考）

## 影响分析

### 1. `src/feishu/utils/markdown.ts`（解析层）

- `parseFrontmatterMeta` / `parseAndStripFrontmatter` 返回类型扩展为 `{ slug, ignore, group, cleanedContent }`
- 新增 group 正则：`/^group[^\S\n]*:[^\S\n]*(.+)$/m`，trim 后**校验** `[a-z0-9-]+`：
  - 通过 → 返回该字符串
  - 不通过/缺失 → 返回 `'default'`
- 代码块剥离条件：`slug | ignore | group` 任一命中即移除（与现有 ignore 行为对齐）
- `parseAndStripFrontmatter` 触发剥离的判断同步追加 `group`

### 2. `src/feishu/utils/index.ts`（导出）

- 导出同步替换：函数签名新增 `group`，调用方使用元组解构即可

### 3. `src/feishu/db.ts`（存储层）

- `DBNode` 接口新增 `group: string`（默认 `'default'`）
- 新增 `updateNodeGroup(db, token, group)`：覆盖写，幂等
- 不变更 `needsDownload` / `getDownloadQueue` 等下载队列逻辑（group 不影响下载触发）
- 不变更 `purgeOrphanNodes`（被 group 切换的节点若远端删了仍要被清理掉）

### 4. `src/feishu/migrations/016_add_group.sql`（新增迁移）

```sql
-- 016: 新增 group 列。
-- 下载管线在解析 YAML group 字段时覆盖写,默认 'default' 与存量数据语义对齐,无需回填。
ALTER TABLE nodes ADD COLUMN group TEXT NOT NULL DEFAULT 'default';
```

- 复用 ALTER TABLE 迁移的"列已存在视为已应用"幂等规则
- 默认值 `'default'` 与存量"未分组"语义对齐，无需回填脚本

### 5. `src/feishu/sync-flow.ts`（同步层）

- INSERT 列清单追加 `group`（值固定 `'default'`，新节点视为默认分组）
- ON CONFLICT DO UPDATE SET **不**包含 `group`（沿用 `is_ignore` 模式，保留作者已设置的 group，避免 sync 覆盖作者意图）
- 续传判断（基于 `downloaded_at`/`updated_at`）不受影响
- `purgeOrphanNodes` 不需要改

### 6. `src/feishu/download-flow.ts`（编排层）

- `processDocContent`：拿到 `group` 后无条件调用 `updateNodeGroup(db, node.node_token, group)`
  - **覆盖写语义**：作者删除 `group: foo` 字段时下次 download 自动回到 `default`
  - 校验失败时降级为 `'default'` 并 warn 一行
- `buildFrontmatter` 接收 `aimUrl` 改为按节点 group 取：`cfg.feishu?.[node.group]?.aimUrl ?? cfg.feishu?.default?.aimUrl`
- 删除文档清理路径（line 286-310）：用节点当前 `group` 查 `feishu.{group}.aimDirectory`，未配置时 fallback 到 `feishu.default.aimDirectory`，再找不到时仅清理本地 `.md` + DB 行

### 7. `src/config.ts`（配置层）

- `FeishuConfig` 结构改为：
  ```ts
  interface FeishuGroupConfig {
      aimDirectory?: string;
      aimUrl?: string;
  }
  interface FeishuConfig {
      dir?: string;
      default?: FeishuGroupConfig;
      [group: string]: FeishuGroupConfig | string | undefined;
  }
  ```
- 新增解析助手 `resolveFeishuGroupConfig(cfg, group: string): FeishuGroupConfig | null`：
  - 命中 `feishu.{group}` → 返回该对象
  - 未命中 → 返回 `null`（调用方决定 fallback）
- `loadConfig` 检测到老的 `feishu.aimDirectory` / `feishu.aimUrl`（直接挂在 feishu 上而非 feishu.default）时打 stderr 警告，提示迁移到 `feishu.default.*`
- 删除现有 `FeishuConfig.aimDirectory` / `aimUrl` 顶层字段（不向后兼容）

### 8. `src/feishu/copy-docs-flow.ts`（消费侧）

- 接收 `--group` 参数（不传时进入 fan-out 分支）
- **--group 指定分支**：
  1. SQL 增加 `AND group = ?` 过滤
  2. 从 `feishu.{group}` 读 aimDirectory，未配置时 fallback 到 `feishu.default.aimDirectory`
  3. 都未配置 → 报错退出（明确告诉用户配置哪一组）
- **fan-out 分支**（不传 `--group`）：
  1. `SELECT DISTINCT group FROM nodes WHERE <现有复制条件> ORDER BY group`
  2. 对每个 group：从 `feishu.{group}.aimDirectory` 读 aimDirectory
  3. 缺失 aimDirectory 的 group → `console.log` 一行警告并跳过该 group
  4. 缺失时 fallback 到 `feishu.default.aimDirectory`
- 提示文案更新：
  - 单 group 模式："目标 group 没有可复制文档"
  - fan-out 模式：每组单独统计（复制 N、跳过 M、warn 该组无 aimDirectory）
  - 整体无任何 group 有可复制文档 → "没有符合复制条件的文档"

### 9. `src/feishu/cli/{types,registry,parse-args}.ts`（CLI 层）

- 新增 `CopyDocsArgs extends CommonArgs { group: string }`（默认 `''`，与现有 `DownloadArgs` 模式一致）
- `ParsedCommand` 联合分支同步更新
- registry 加 `--group, -g` flag：`apply` 把值赋给 `args.group`
- `copy-docs` 的 `run` 接收 `CopyDocsArgs` 而非 `CommonArgs`

### 10. 级联副作用

- **图片处理**：与 group 无关，不变
- **优先级副作用**：`incrementNodePriority` 在解析 `<cite>` 时若被引方 `human_path` 为空会触发。group 文档本身仍写 `human_path`，引用行为不变；作为被引方时仍可被其他人正常引用
- **description 缓存**：不变
- **frontmatter og:url**：现在按 group 选 aimUrl，**同一文档多次下载**时 og:url 可能因 group 切换而变化（视为合理行为）。如果 aimUrl 在不同 group 间一致则不变化
- **删除文档时同步**：通过节点的 `group` 字段定位 aimDirectory，不需要重新查 config；fallback 到 `default` 后再找不到则跳过 aimDirectory 清理（与"aimDirectory 缺失时不删"语义对齐）
- **download 错误处理**：line 281 `if (e.message.includes('3380003'))` 分支使用节点当前 DB 的 `group`（此时 group 可能已被本次 processDocContent 覆盖写）

### 11. 数据一致性与过渡

- **存量数据**：迁移默认 `'default'`，所有历史文档视为 default 分组，行为不变
- **覆盖写语义**：每次 download 重读 YAML → 作者去掉 `group: foo` 后下次自动回到 `default`
- **group 名修改**：作者把 `foo` 改成 `bar`，下次 download 后 `nodes.group` 变为 `bar`，但旧 aimDirectory 下的 `human_path.md` 副本不会被自动迁移（需要重新 copy-docs；下游归档站点需自行处理重定向）
- **配置文件迁移**：`feishu.aimDirectory` → `feishu.default.aimDirectory`。不向后兼容；`loadConfig` 检测到老键时打 stderr 警告提示用户迁移
- **空 group 字段**：YAML 块中只有 `group:` 后面无值 → 视为 `'default'`

### 12. 性能风险

- 零额外网络请求、零大表扫描
- fan-out 分支按 group 串行执行（按字典序），每个 group 内仍是单次 SQL + 多次 Bun.write
- `nodes.group` 暂不加索引（现有查询路径不按 group 过滤；copy-docs fan-out 一次 DISTINCT 不需要索引）

## 方案对比

### 方案 A：扩展 frontmatter 解析器 + 新增 group 列 + fan-out copy-docs（推荐）

核心思路：把现有 `parseFrontmatterMeta` 扩展为返回 `{ slug, ignore, group }`；新增 `group` 列并在下载管线覆盖写；`copy-docs` 不指定 `--group` 时按 DB 中 unique group 串行 fan-out 到各自配置的 aimDirectory。

优点：
- 与 `is_ignore` 机制高度同构（frontmatter 解析、DB 列、覆盖写语义、SQL 过滤），复用度高
- fan-out 自动发现所有 group，用户无需维护 group 列表
- 配置 schema 用索引签名兼容任意 group 名，扩展性强
- 校验失败降级为 `default` 不阻断下载，作者体验友好

缺点：
- `FeishuConfig` 用索引签名，与 `dir: string` 共存需要 TS 类型联合
- fan-out 串行执行，比单次复制略慢
- 不向后兼容老配置（用户需手动迁移）

实施复杂度：中

### 方案 B：保留旧函数名 + 独立 parseGroupFromContent（不推荐）

核心思路：不动 `parseFrontmatterMeta` 名字，新增独立函数扫 YAML 块取 `group`。

缺点：
- 同一份内容被扫多次，性能略差
- 解析逻辑分散，与已认可的"通用 frontmatter 解析器"方向相悖

实施复杂度：低

## 推荐方案

方案 A。与既有 `is_ignore` 架构契合度高，扩展点都在熟悉的层（解析、DB、SQL 过滤、配置 schema）；fan-out 模式让用户零配置即可使用多 group 归档；不向后兼容老配置换取 schema 清晰度（仅一次迁移成本）。

## 待确认事项

| # | 项 | 默认假设 |
|---|----|---------|
| 1 | `CommonArgs.group` 还是新增 `CopyDocsArgs extends CommonArgs { group }` | 新增 `CopyDocsArgs` 更符合现有分层（见 `DownloadArgs` 模式） |
| 2 | fan-out 内部是否复用 `runCopyDocs(args)` 递归调用 | 不递归，复制逻辑内联展开（更显式，避免参数污染） |
| 3 | 下载删除清理（3380003）找不到 aimDirectory 时如何处理 | 仅清理本地 `.md` + DB 行，跳过 aimDirectory 副本清理（与现有"aimDirectory 缺失时不删"语义对齐） |

## 实施建议

按层自底向上，每个层落地后跑对应测试：

1. **解析层**（`src/feishu/utils/markdown.ts`）→ 单测先行
2. **存储层**（`migrations/016_add_group.sql` + `src/feishu/db.ts`）
3. **同步层**（`src/feishu/sync-flow.ts`）
4. **配置层**（`src/config.ts` + `loadConfig` 警告）
5. **下载层**（`src/feishu/download-flow.ts` 的 `buildFrontmatter` 和删除清理）
6. **复制层**（`src/feishu/copy-docs-flow.ts` 重构为 fan-out 模式）
7. **CLI 层**（`src/feishu/cli/{types,registry,parse-args}.ts`）
8. **文档同步**（`docs/feishu/{overview,business,flows}.md`）
9. **完整测试**（`bun test`）

## 结论

这次变更的本质是把"文档归档"从单目录扩展为按 `group` 维度的多目录机制：作者通过 YAML 标注分组，DB 持久化，配置按 group 隔离归档目标和公网 URL，`copy-docs` 自动 fan-out 到所有 group。改动与既有 `is_ignore` 机制高度同构（frontmatter 解析、DB 列、覆盖写语义、SQL 过滤），复用度极高；唯一的复杂性在 `copy-docs` 的 fan-out 行为和配置 schema 的索引签名变更，但都属于局部可控改动。

---

```
✅ 讨论记录已保存

文件：docs/.req-discuss/feishu/group-classification/discuss.md
模式：完整讨论
业务域：feishu
变更主题：group-classification（文档 group 维度归档）
方案倾向：方案 A — 扩展 frontmatter 解析器 + 新增 group 列 + fan-out copy-docs
待确认项：3 项（均为实施细节默认值）
```