# 飞书同步业务逻辑

## 数据库初始化 (init-db)

### 状态机

```text
DB_NOT_FOUND → MIGRATIONS_CHECKED → MIGRATIONS_APPLIED → DONE
```

状态说明：

- `DB_NOT_FOUND`：数据库文件不存在，执行器创建新文件。
- `MIGRATIONS_CHECKED`：读取 `_migrations` 跟踪表，确定哪些迁移尚未应用。
- `MIGRATIONS_APPLIED`：在事务中顺序执行待处理迁移，记录 `applied_at` 时间戳。

### 关键业务规则

- 所有 CREATE TABLE 使用 `IF NOT EXISTS`，保证幂等执行。
- ALTER TABLE 类迁移执行时若列已存在（duplicate column name），视为已应用，标记跳过。
- 006_rebuild_images_pk 迁移在执行前检查 `PRAGMA table_info(images)` 中 node_token 列是否存在，若已存在则跳过。
- 迁移通过 `_migrations` 表跟踪，已应用的迁移不会重复执行。
- 首次使用飞书工具前必须执行 `init-db`。

## 飞书知识库索引

### 状态机

```text
INIT → AUTH_CHECKED → METADATA_SCANNED → INDEX_SAVED → LOCAL_CLEANED → DONE
                                      ↘ NO_CHANGES → DONE
```

状态说明：

- `AUTH_CHECKED` 是同步前置条件：没有可用的 `lark-cli` 和用户认证时，同步无法继续。
- `METADATA_SCANNED` 先于内容下载：本地索引是断点续传、增量判断和清理本地文件的依据。
- `NO_CHANGES` 表示远端结构与本地索引一致，无需更新。
- `LOCAL_CLEANED` 是索引完成后的清理阶段：移除远端已不存在文档对应的本地文件。

### 关键业务规则

- 索引只处理知识库结构，不下载文档内容，不获取编辑时间。
- 索引更新后立即清理本地过期 Markdown 文件，确保本地目录反映远端当前状态。
- 清理不做交互确认，直接删除不在索引中的文件。
- 删除知识库时，同时删除该空间下所有已同步的文档。
- 同空间内路径冲突时，通过序号后缀避免覆盖。
- 续传判断简化：已有节点若 `downloaded_at` 非空且对应文件存在，直接保留下载状态，不再依赖 `updated_at` 比较。
- **以本次扫描结果为准**：`sync` 流程保证本地索引（`nodes` + `images` + 本地文件）与本次 API 扫描结果一致——本次扫到的节点进入索引；本次未扫到的节点（包括历史孤儿）通过 `purgeOrphanNodes` 同步清理 `nodes` 行、关联 `images` 行、本地 `.md` 文件和 OSS 上的图片。该清理路径覆盖单空间节点级删除、移动到其他空间、以及 `--spaces` 过滤模式下已退出的空间。
- **顺序约束**：`purgeOrphanNodes` 必须按 `SELECT → DELETE nodes → rmSync 本地文件 → cleanupOrphanImages` 顺序执行——`cleanupOrphanImages` 依赖 `getImageByMd5` 查 ext 才能定位本地 temp 和 OSS，因此 `images` 行必须保留到 `cleanupOrphanImages` 调用之后才被删除（由其内部 `deleteImageByMd5AndNode` 副作用完成）。

## 飞书编辑时间同步 (sync-updated-at)

### 状态机

```text
DB_READY → QUEUE_BUILT → FETCHING → WRITTEN → DONE
                        ↘ EMPTY_QUEUE → DONE
```

状态说明：

- `DB_READY`：核心表（spaces, nodes, images）均已存在，可通过 `ensureDB()` 校验。
- `QUEUE_BUILT`：根据范围参数（全量 / `--space` / `--node-token`）从数据库查询待更新节点列表。
- `FETCHING`：并发调用 `wiki +node-get` API 获取远端 `updated_at`，QPS 控制在 5。
- `WRITTEN`：事务中批量写入 `updated_at` 到 `nodes` 表。

### 关键业务规则

- sync-updated-at 依赖 `sync` 先运行，确保 `nodes` 表中有节点记录。
- 支持三种更新范围：全量（默认）、按空间（`--space` 可多次指定）、按单节点（`--node-token`）。
- 支持 `--max-age <分钟>` 增量同步：只更新 `updated_at_last_synced_at` 为空或距今超过指定时长的节点，减少 API 调用次数。
- 单节点模式（`--node-token`）不受 `--max-age` 限制，始终发起 API 调用。
- API 调用使用 QPS 5 限流，避免触发飞书 API 限流。
- 单个节点的 API 调用失败不影响其他节点的更新，失败的节点不写入。
- 成功获取到的 `updated_at` 写入 `nodes.updated_at` 列，同时写入 `updated_at_last_synced_at` 为当前时间。download 阶段据此判断是否需要重新下载。
- sync 流程中当 `downloaded_at` 被清空（本地文件不存在）时，`updated_at_last_synced_at` 同步清空，确保下次 sync-updated-at 不会错误跳过该节点。

## 飞书文档下载

### 状态机

```text
INDEX_REQUIRED → INDEX_LOADED → DOWNLOAD_PENDING → DOWNLOADING → SAVED → DONE
                        ↘ NO_DOCS → DONE
```

状态说明：

- `INDEX_REQUIRED` 不满足时直接结束：下载依赖本地索引，不能绕过索引直接访问远端。
- `NO_DOCS` 表示索引中没有可下载的文档，提前结束。

### 关键业务规则

- 下载不自动执行索引：必须先运行 `sync` 命令更新远端结构。
- `sync` 同步所有类型节点，`download` 处理 doc/docx/file/sheet：sync 把 sheet/bitable/mindnote/slides/file 也写入 `nodes` 表（仅元数据，`file_path` 为空字符串）。`download` 对 doc/docx 生成本地 Markdown 文件，对 file/sheet 走 OSS 通道（lark-cli 下载/导出后上传 OSS，公网地址写入 `upload_url`），bitable/mindnote/slides 仍不处理。
- 续传判断依赖远端编辑时间（`updated_at`）、本地下载时间（`downloaded_at`）与本地文件存在性：`downloaded_at` 为空，或 `downloaded_at` 早于 `updated_at` 时需重新下载。
- 下载并发和 QPS 受控：平衡同步速度、限流风险和本机资源占用。
- 下载失败不中断整体批次：单个文档失败时记录错误，继续处理其他文档。
- 下载不清理本地文件：清理是索引阶段的职责。
- 下载时自动移除文档中用于标记 `human_path` 的 slug YAML 代码块（```` ```yaml ```` 内含 `slug:`）。slug 值被解析写入 `human_path` 列后，该代码块从最终 `.md` 文件中剔除，不对外暴露。
- `downNode`（单节点下载）与 `runDownload`（批量下载）共享 `processDocContent` 处理管线，行为完全一致：解析 slug → 移除代码块 → 更新 DB → 生成描述 → 注入 frontmatter。
- 解析 frontmatter 时同时支持 `ignore` 字段（仅识别字面量 `Y`，区分大小写、trim 后匹配）。命中时 `nodes.is_ignore` 写为 1，未命中或缺失保持 0。覆盖写语义保证作者去除 `ignore: Y` 后下次 download 自动恢复。`ignore` 字段不区分 doc/docx 以外的其他节点类型（sheet/file 不参与解析）。被忽略文档不影响 download 流程的其他环节（图片、frontmatter、human_path 全部照旧）。
- 解析 frontmatter 时同时支持 `group` 字段（小写 `[a-z0-9-]+`，trim 后校验；非法值或缺失降级为 `'default'`）。命中时 `nodes.group` 覆盖写为该值。`group` 字段不区分 doc/docx 以外的其他节点类型（sheet/file 不参与解析）。覆盖写语义保证作者去除 `group: foo` 后下次 download 自动回到 `'default'`。`group` 与 `ignore` 互不影响：被 group 标记的文档仍正常下载、`is_ignore=0` 的 group 文档仍可被 `copy-docs` 复制。
- 下载完成后自动处理图片：默认随 download 一并执行（无需额外 flag），流水线语义是"下载一篇 → 处理图片一篇"。处理管线包括：下载图片 → MD5 去重 → 上传 OSS（OSS 未配置时降级本地路径）→ 替换 Markdown 链接 → 节点级 diff 清理。
- 下载管线解析 `<sub-page-list>` 块为 Markdown 无序列表：块级正则匹配整块，块内逐项解析 `<sub-page doc-id="..." file-type="..." title="..."/>`。命中分支按 `file-type` 分流：`docx` 同组走 `human_path.md`、跨组走 `${aimUrl}/${human_path}.html`（绝对 URL）；`sheet` / `file` 走 `upload_url` 直出（不加 `.md`，无论同组/跨组）。降级路径分四种（均保留原文 + warning）：缺 `doc-id`；`file-type` 非 `docx` / `sheet` / `file`（如 `bitable` / `mindnote`）；`resolveLink` 返回 `reason`（含跨 group + aimUrl 缺失）；被引方不在索引。块级决策：当所有子项都是"resolveLink 失败"（格式正确但节点缺失）时丢弃整块；只要存在"命中 / 格式问题保留"中的任一种有效子项，就输出 Markdown UL。`space-id` / `wiki-token` 不参与解析，仅作信息保留。`resolveLink` 闭包内不再 bump 被引节点 priority（与 `<cite>` 同构；aimUrl 缺失是配置问题，下载重试不会自动修复；human_path/upload_url 缺失同理，等作者修复后下次 download 覆盖写）。
- 下载管线解析 `<cite>` 引用块为 Markdown 链接：仅处理 `type="doc"` + `file-type="wiki"` 的标准组合，其余组合（`type` 非 `doc`、`file-type` 非 `wiki`）以及缺 `doc-id`、`resolveLink` 返回 `reason` 都保留原文 + warning，提示作者检查标签或重跑 sync。`resolveLink` 回调按"当前节点 group 与被引节点 group 是否一致"分流：同组返回 `human_path`（最终输出 `[title](human_path.md)`）；跨组且被引方 `aimUrl` 可解析返回 `${aimUrl}/${human_path}.html`（最终输出绝对 URL，跨 aimDirectory 也能跳转）；跨组但被引方 `aimUrl` 不可解析返回 `reason`（保留原文 + warning，提示"cross-group 引用目标 group X 缺少 aimUrl 配置"）。详见 [跨 group 引用解析为绝对 URL](../.req-discuss/feishu/cross-group-link/discuss.md)。
- 下载全部完成后执行全局孤儿图片扫描（`cleanupGlobalOrphans`）：遍历所有已下载 `.md` 文件提取引用的图片 MD5 集合，删除 `images` 表中不被任何文档引用的孤儿图片（本地 temp 文件 + OSS 文件 + DB 记录）。作为事件驱动清理（per-node diff + sync 删除）的补充。
- `processImagesInFile` 抛出异常时 `downloaded_at` 不会写入：节点会在下次 `download` 运行时进入下载队列再次重试（受 `needsDownload` 规则触发）。

## 图片处理

图片处理是 `download` 流程的内置环节，与"下载文档"合并执行。`processImagesInFile` 是核心实现。

### 状态机

```text
PROCESSING → DIFFED → DONE
```

状态说明：

- `PROCESSING` 阶段：提取 Markdown 中的图片 URL，下载、计算 MD5、按内容去重。完成后由 `uploadImagesForNode` 写入 `downloaded_at`（"下载 + 图片处理完毕"统一标记）。
- `DIFFED` 阶段：对比新下载的图片集合与该节点在 `image_vs_node` 表中已存在的关联，找出"老关联但新下载里没了"的 MD5，通过 `cleanupOrphanImages` 清理（OSS / 本地 temp / DB 记录按引用计数收敛）。

### 关键业务规则

- 图片处理与 download 同步执行：`runDownload` 在每个节点下载成功后立即调 `processImagesInFile`，不需要用户额外操作。
- `downloaded_at` 升级为"下载 + 图片处理完毕"的统一标记：`processImagesInFile` 成功返回后由 `uploadImagesForNode` 写入。当 `sync` 扫描发现文档编辑时间变更或本地文件不存在时，`downloaded_at` 被清空，下次 download 重新处理。
- 图片按内容 MD5 去重：同一张图片只下载和上传一次。
- 已公网化图片直接跳过：URL 属于 `oss.urlPrefix` 域名时不再处理。
- OSS 配置不完整或 aliyun CLI 缺失时，图片降级保存到本地路径 `./images/{md5}.{ext}`，仅 warning 不阻断主流程。
- 单张图片失败不阻断整批处理：继续处理其他图片并在最后汇总失败项。`processImagesInFile` 通过返回值 `{ processed, failed, failures }` 把每张失败图片的 URL + 原因传递给 `download-flow`：单节点模式直接逐条打印，batch 模式按节点分组汇总到末尾的"图片失败详情"section（最多展示 20 个节点 × 每节点 5 张，reason 单行 200 字符截断）。
- 节点级 diff 清理：每个节点 `processImagesInFile` 末尾调 `cleanupOrphanImages` 摘除"老关联但新下载里没了"的图片。

## 飞书单节点下载

### 状态机

```text
INDEX_REQUIRED → NODE_FOUND → DOWNLOADING → IMAGE_PROCESSED → DONE
                        ↘ ALREADY_DOWNLOADED → DONE
                        ↘ NOT_FOUND → DONE
```

状态说明：

- `INDEX_REQUIRED` 不满足时直接结束：依赖本地索引确定节点信息。
- `ALREADY_DOWNLOADED` 表示节点已下载且未传 `--force`，跳过下载。
- `IMAGE_PROCESSED` 是 download 流程的内置环节，默认随 download 一并执行（与 batch 模式共用同一 `processImagesInFile` 管线）。

### 关键业务规则

- 单节点下载不自动执行索引：必须先运行 `sync`。
- 根据 `node_token` 直接从索引数据库查询节点信息，不请求飞书远端。
- `--force` 参数可以强制重新下载已是最新的节点（与 `--node-token` 联用时自动开启）。
- 图片处理是 download 的内置环节：单节点模式与批量模式共用同一 `processImagesInFile` 管线，行为完全一致。
- `--parse-human-path` 已预留参数，尚未实现解析逻辑。

## 飞书文档分组与多归档目录

支持文档按 `group` 维度归档：作者在 YAML 写 `group: <name>` → 节点标记为该 group → `copy-docs` 不指定时自动按 DB 中所有 unique group 分批复制到各自 `feishu.{group}.aimDirectory`。

### 状态机

```text
GROUP_RESOLVED → AIM_DIRECTORY_LOOKUP
                ├── HIT → COPY_DOCS_FOR_GROUP → DONE
                └── MISSING → SKIPPED → CONTINUE
```

### 关键业务规则

- group 名严格匹配 `[a-z0-9-]+`；非法值（空、大写、含路径字符、中文等）降级为 `'default'`
- `nodes.group` 由 `download` 阶段覆盖写；`sync` 阶段 INSERT 列清单包含 `group='default'`，但 `ON CONFLICT DO UPDATE SET` **不**包含 `group`，保留作者已设置的值（沿用 `is_ignore` 模式）
- `copy-docs` 不传 `--group` 时进入 fan-out 分支：取 DB 中 unique group（`ORDER BY group` 保证顺序稳定）→ 串行执行每个 group 的复制
- `copy-docs --group <name>` 时仅过滤该 group（`WHERE "group" = ?`），未配置该 group 的 aimDirectory 时报错退出
- 缺 aimDirectory 的 group 在 fan-out 模式下 `console.log` 警告并跳过，不阻断其他 group
- aimDirectory 解析优先级：`feishu.{group}.aimDirectory` → fallback 到 `feishu.default.aimDirectory`
- `download` 不加 `--group` 过滤（保持全量下载，group 仅在 `copydocs` 阶段消费）
- 删除文档（3380003）按节点的 `group` 字段定位 aimDirectory，未配置时跳过 aimDirectory 副本清理（仅清理本地 `.md` + DB 行）
- sheet/file 节点不解析 `group`（与 `is_ignore` 边界一致）

## 飞书目标目录孤儿副本检测 (diff-with)

`copy-docs` 是单向写入（`Bun.write` 覆盖同名文件，不删旧文件），任何 source 端的状态变化（节点被 `sync` 清掉、`human_path` 改名/清空、文档 `is_ignore=1`、文档换 `group`）都会让 `aimDirectory` 里残留孤儿 `.md` 副本，且**永远不会被自动清理**。`sync-orphan-node-cleanup` 已经为 source 端补齐反向清理路径，但 aimDirectory 一直是盲区。

`cmd.feishu diff-with <group>` 是只读反查工具：扫描 `feishu.{group}.aimDirectory` 下的所有 `.md` 副本，三级判定后输出清单，供用户手动 `rm`。**只列不删**，避免误清。

### 状态机

```text
LOAD_CONFIG → GROUP_VALID_RE → RESOLVE_AIM_DIR
                                     ├── null → throw
                                     └── 命中  → WALK_DIR
                                                  ↓
                                            PER_FILE
                                              ├── L1 (human_path + group 命中) → SILENT
                                              ├── L1 miss → 读 frontmatter title
                                              │              ├── null → WARN "frontmatter 缺失"
                                              │              └── title → 全库匹配
                                              │                       ├── 0 个 → WARN "无任何匹配"
                                              │                       └── N 个 → LIST + N 行 URL
```

### 关键业务规则

- **只读**：不写 DB、不删文件、不调外部 API
- **group 必填位置参数**：`<group>` 不传则 parse-args 阶段 throw；group 名严格匹配 `[a-z0-9-]+`，非法值 throw
- **三级判定**：
  - **L1 路径+group 命中** → 静默（不出现在清单；同时匹配带/不带前导斜杠两种形式，DB 历史写入可能带 `/`）
  - **L2 标题全库匹配（≥1 都输出）**：
    - 命中 1 个 → 列出文件 + 1 行 URL（可能是 slug 改名后留在 aimDirectory 的旧副本，让用户自己判断）
    - 命中 ≥2 个 → 列出文件 + 每个匹配节点一行 URL（同标题多文档是可疑，需要人工核对）
    - 格式：
      ```
      ⚠ [group] <human_path>.md — 标题 "X" 匹配 N 个:
        \`\`\`yaml
        slug: /<human_path>           # 带前导斜杠,无 .md 后缀,对应 DB human_path 格式
        \`\`\`
        https://feishu.cn/wiki/<token>
        ...
      ```
  - **L3 无匹配** → 警告 `标题 "X" 无任何匹配` + 子行块 `\`\`\`yaml ... slug: /<human_path> ... \`\`\``
  - **L1 miss + frontmatter title 缺失/空** → 警告"无法按标题反查" + 子行块 `\`\`\`yaml ... slug: /<human_path> ... \`\`\``
- **title 跨 group 全库匹配**：不按 group 过滤（同标题跨 group 节点都列出），让用户能定位原 group 之外的同名节点
- **title 读取**：`src/feishu/utils/markdown.ts:parseFrontmatterTitle`，从 `--- ... ---` frontmatter 块的 `head: [og:title] content` 取标题
- **反查范围**：`aimDirectory` 下的所有 `.md` 文件（含子目录如 `guide/install.md`），排除 `images/` 与 `data/` 子目录（沿用 `findMdFiles` 行为）
- **0 orphan**：打印一行总结 `✓ 扫描 N 个文件, 列出 X 个待匹配, 警告 Y 个`，不静默退出
- **退出码**：0（孤儿副本不视为错误）；预检查失败（DB 缺失、group 非法、group 未配置 aimDirectory）非 0
- **aimDirectory 解析**：复用 `src/feishu/aim-dir.ts:resolveAimDirectory`，与 `copy-docs` 共享 helper
- **不支持 fan-out**：v2 强制单 group（CLI 设计简化）；未来如需 fan-out 再讨论
- **不引入 `--group` flag**：v2 位置参数是唯一入参；CLI 破坏性变更（v1 未发布，无用户影响）
- **飞书 URL**：硬编码 `https://feishu.cn/wiki/<node_token>`，依赖 Feishu 跨租户跳转机制保证可用

## 飞书可疑标题扫描

### 状态机

```text
INDEX_REQUIRED → INDEX_LOADED → MATCHED → REPORTED
                         ↘ NO_MATCH → DONE
```

状态说明：

- `INDEX_REQUIRED` 不满足时直接结束：扫描依赖同步索引，不能绕过索引直接判断知识库内容。
- `NO_MATCH` 是正常结果：没有可疑标题时无需产生修复动作。

### 关键业务规则

- 只扫描标题不扫描正文：目标是发现疑似自动生成或异常命名的文档，不判断内容质量。
- 连续字母数字长度可配置：不同知识库对“异常标题”的容忍阈值不同，需要允许人工调整。
- 结果按匹配长度降序展示：更长的随机串通常更值得优先排查。
- 报告需要包含知识库、本地路径和飞书链接：排查人员需要能从结果定位到本地同步文件和远端文档。

## 配置优先级

- 飞书默认目录来源：CLI `--output` 参数 > `config.json` 中 `feishu.dir` 字段 > `./docs/feishu`。
- 配置文件路径：`$XDG_CONFIG_HOME/cmd4bun/config.json`，未设置 `XDG_CONFIG_HOME` 时回退 `~/.config/cmd4bun/config.json`。
- 配置文件中 `feishu.dir` 同时影响所有 `cmd.feishu` 子命令的默认目录。相对路径按当前运行目录解析。
- OSS 配置仅在运行 `download` 命令时需要（图片处理是 download 的内置环节），用于将飞书图片上传为公网可访问 URL。OSS 未配置时图片降级保存到本地路径。
- `oss.urlPrefix` 只包含协议和域名，不含路径；最终 URL 由 `urlPrefix`、`pathPrefix` 和文件名共同生成。

## 飞书文档描述生成

文档下载时同步生成页面描述（og:description），用于 Vitepress frontmatter。

### 状态机

```text
SLUG_FOUND → DESC_CACHE_CHECK
           ├── CACHE_HIT → BUILD_FRONTMATTER → INJECTED
           └── CACHE_MISS → RESOLVE_DESCRIPTION → GENERATE_DESCRIPTION
                            ├── DEEPSEEK_OK → SAVE_TO_DB → BUILD_FRONTMATTER → INJECTED
                            └── DEEPSEEK_FAIL → BUILD_FRONTMATTER_WITH_EMPTY → INJECTED
```

### 关键业务规则

- 描述生成仅在节点有 `human_path`（即解析到 slug）时执行。无 slug 的节点不生成 frontmatter。
- slug 代码块在解析阶段即被移除（`parseAndStripSlug`），因此 `resolveDescription` 的摘要源（`cleanedContent`）不包含 slug 标记内容，生成的描述更干净。
- `resolveDescription` 优先使用文档标题（headings）作为摘要源。当标题中的中文字符数不超过 10 个时，改使用正文前 500 个字符作为源。
- `generateDescription` 调用 DeepSeek API。请求超时或认证失败时返回空字符串，不会阻塞下载流程。
- 生成的描述写入 SQLite `nodes.description` 列，下次下载时直接复用，避免重复调用 API。
- frontmatter 中的 `og:url` 依赖 `config.feishu.{group}.aimUrl`（或 fallback 到 `feishu.default.aimUrl`）配置。无配置时跳过该行。
- `lastUpdated` 使用 sync 阶段写入的 `updated_at`（ISO 8601），通过 `formatUpdatedAt()` 格式化为 "YYYY-MM-DD HH:mm:ss"。`updated_at` 为空时 `lastUpdated` 为空字符串。
- `og:image` 在图片处理（`processImagesInFile`）完成后从正文第一张图片 URL 自动回写到 frontmatter 的 `head.meta[]` 中。仅对已有 frontmatter 的文件生效。已有 `og:image` 时更新而非重复添加。

## 待确认

- `cmd.feishu` 对 `sheet`、`bitable`、`mindnote`、`slides`、`file` 的长期策略：已采纳"索引层同步所有类型 + 下载层按实现能力渐进扩展"的分层策略。最初仅 doc/docx 生成本地 Markdown，后续扩展支持 file/sheet 走 OSS 通道（`downFileNode` / `downSheetNode` 写 `upload_url`），bitable/mindnote/slides 仍未支持。详见 [sync 同步所有类型节点](../.req-discuss/feishu/sync-all-node-types/discuss.md) 与 `src/feishu/download-flow.ts` 入口分发。
- `docs/feishu/` 是个人本地缓存还是项目共享资料源；当前 `.gitignore` 忽略该目录，但仓库状态中已有未跟踪同步产物。
