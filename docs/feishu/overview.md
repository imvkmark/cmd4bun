# 飞书同步模块 (feishu)

## 服务职责

飞书知识库文档同步工具，负责将飞书知识库文档导出为本地 Markdown 文件，支持图片自动下载并上传 OSS 以生成公网可访问的完整文档。

## 模块结构

| 模块 | 职责 |
|------|------|
| `feishu.ts` | CLI 入口：参数解析、子命令路由（init-db / sync / sync-updated-at / download / copy-docs / diff-with） |
| `feishu/api.ts` | 飞书 Wiki API 调用：知识库扫描、节点 BFS 遍历、文档内容获取、节点元数据查询、DeepSeek 描述生成 |
| `feishu/db.ts` | SQLite 数据库操作：spaces / nodes / images 三张表的 CRUD、连接管理、数据库迁移跟踪 |
| `feishu/init-db-flow.ts` | 数据库迁移执行器：按序执行 SQL 迁移文件，通过 _migrations 表保证幂等 |
| `feishu/sync-flow.ts` | 索引同步流程：知识库元数据扫描 + 节点级孤儿清理（diff 本次扫描 vs DB）+ 过期本地文档清理（不再负责 updated_at 获取） |
| `feishu/sync-updated-at-flow.ts` | 编辑时间批量更新流程：从 DB 查询节点队列并发调用 API 获取并写入 updated_at |
| `feishu/download-flow.ts` | 文档下载流程：并发下载 + 断点续传（基于 updated_at），默认自动处理图片（下载/去重/上传 OSS/URL 替换/节点级 diff）+ 末尾全局孤儿兜底 |
| `feishu/copy-docs-flow.ts` | 已下载文档复制：按 group 分发到 `feishu.{group}.aimDirectory`，目标文件名 `human_path.md` |
| `feishu/diff-with-flow.ts` | 目标目录孤儿副本检测：按 `human_path` 反查 DB，列出两类孤儿（只读） |
| `feishu/aim-dir.ts` | `aimDirectory` 解析共享 helper：按 group 名 → fallback 到 default，copy-docs 与 diff-with 共用 |
| `feishu/images.ts` | 图片处理核心：URL 提取、下载、MD5 去重、OSS 上传、Markdown 链接替换、全局孤儿扫描 |
| `feishu/utils.ts` | 工具函数：Shell 封装、XML→文本转换、文件遍历、限流器、进度输出、时间格式化、Markdown 标题提取与正文预览 |
| `feishu/migrations/` | 数据库迁移 SQL 文件（001_initial.sql ~ 010_split_images.sql） |
| `config.ts` | XDG 配置文件加载（config.json）、token 解析、飞书目录解析、aimUrl 配置 |
| `shared/colors.ts` | ANSI 终端颜色常量 |

## 技术栈

| 组件 | 用途 |
|------|------|
| `bun:sqlite` | 索引存储（替代旧版 `.index.json`） |
| `lark-cli` | 飞书 Open API 调用（wiki/docs 域） |
| `aliyun` CLI | 图片上传 OSS（OSS 未配置时降级本地路径） |
| `Bun.CryptoHasher` | 图片 MD5 计算 |

## 功能入口

| 命令 | 说明 |
|------|------|
| `bun run src/feishu.ts init-db` | 初始化数据库表结构（首次使用需先执行） |
| `bun run src/feishu.ts sync` | 同步知识库索引，清理过期文档 |
| `bun run src/feishu.ts sync-updated-at` | 批量更新节点编辑时间（updated_at） |
| `bun run src/feishu.ts download` | 根据索引下载文档内容（自动处理图片：下载/去重/上传 OSS/URL 替换/节点级 diff） |
| `bun run src/feishu.ts copy-docs` | 复制已上传图片的文档到归档目录 |
| `bun run src/feishu.ts diff-with <group>` | 列出指定 group 目标目录中的孤儿副本（三级判定 + 飞书 URL） |

## 构建后的命令

```bash
# 统一入口
cmd.feishu init-db
cmd.feishu sync
cmd.feishu sync-updated-at
cmd.feishu download
cmd.feishu download --node-token <node_token>
cmd.feishu copy-docs
cmd.feishu diff-with <group>     # group 是必填位置参数
```

## API 依赖

| 服务 | 交互方式 | 说明 |
|------|---------|------|
| 飞书知识库 | `lark-cli` 用户态 API 调用 | 扫描知识库、读取节点元数据和文档内容 |
| 本地 SQLite | `bun:sqlite` | 保存空间、节点和图片索引 |
| 阿里云 OSS | `aliyun` CLI | `download` 命令下上传图片（OSS 未配置时降级为本地路径） |

## 边界说明

- 不负责飞书账号登录、权限开通和 token 管理。
- 不负责远端飞书文档的重命名、移动、删除或权限管理。
- 不提供长期运行服务、HTTP API 或后台任务调度。
- 当前正文同步主要面向可转成 Markdown 的文档内容；表格、多维表、脑图、演示和普通文件需要单独扩展读取逻辑。

## 配置

### config.json

```json
{
  "feishu": {
    "dir": "./docs/feishu",
    "default": {
      "aimDirectory": "./docs",
      "aimUrl": "https://example.com/docs"
    },
    "blog": {
      "aimDirectory": "./blog",
      "aimUrl": "https://example.com/blog"
    }
  },
  "oss": {
    "profile": "my-aliyun-profile",
    "bucket": "my-bucket",
    "region": "oss-cn-hangzhou",
    "pathPrefix": "feishu-images",
    "urlPrefix": "https://static.example.com"
  }
}
```

| 字段 | 说明 | 必填 |
|------|------|------|
| `feishu.dir` | 同步输出目录 | 否 |
| `feishu.default.aimDirectory` | `group=default` 文档的复制目标目录 | `copy-docs` 命令必填（除非对应 group 单独配置） |
| `feishu.default.aimUrl` | `group=default` 文档的访问 URL 前缀，用于构建 frontmatter 中 og:url | 否 |
| `feishu.{group}.aimDirectory` | `group={group}` 文档的复制目标目录（覆盖 default） | 否（缺省时 fallback 到 default） |
| `feishu.{group}.aimUrl` | `group={group}` 文档的访问 URL 前缀（覆盖 default） | 否（缺省时 fallback 到 default） |
| `oss.profile` | aliyun CLI profile 名称 | `download` 必填（OSS 未配置时图片降级本地路径） |
| `oss.bucket` | OSS bucket 名称 | `download` 必填（OSS 未配置时图片降级本地路径） |
| `oss.region` | OSS region（默认 oss-cn-hangzhou） | 否 |
| `oss.pathPrefix` | OSS 上传路径前缀 | `download` 必填（OSS 未配置时图片降级本地路径） |
| `oss.urlPrefix` | OSS 公网访问 URL 前缀（协议 + 域名，不含路径） | `download` 必填（OSS 未配置时图片降级本地路径） |

> **配置迁移**：旧版 `feishu.aimDirectory` / `feishu.aimUrl` 顶层字段不再被读取。
> 检测到老键时 `loadConfig` 会向 stderr 输出警告，提示迁移到 `feishu.default.*` 命名空间。

## 文档索引

- 业务逻辑 → [business.md](business.md)
- 执行流程 → [flows.md](flows.md)

## 开发约定与后续建议

- CLI 使用 `#!/usr/bin/env bun`，参数解析支持 `--help` / `-h`。
- 正常进度输出到 stdout，错误输出到 stderr；用户输入、环境、认证或运行错误使用非零退出码。
- 修改 SQLite 索引字段时，需要保持旧数据库可读或提供迁移逻辑，并同步更新本文档。
- 修改同步流程、可下载类型或图片处理策略时，同步更新 [business.md](business.md) 与 [flows.md](flows.md)。

## 数据库结构

SQLite 数据库文件：`{outputDir}/feishu.db`

### spaces — 知识库

| 列 | 类型 | 说明 |
|----|------|------|
| space_id | TEXT PK | 知识库 ID |
| name | TEXT | 知识库名称 |
| updated_at | TEXT | 最后更新时间 |

### nodes — 文档节点

| 列 | 类型 | 说明 |
|----|------|------|
| node_token | TEXT PK | 节点 token |
| space_id | TEXT FK | 所属知识库 |
| title | TEXT | 文档标题 |
| obj_token | TEXT | 文档对象 token |
| obj_type | TEXT | 文档类型（doc/docx/sheet/bitable/mindnote/slides/file）；sync 同步所有类型，download 处理 doc/docx (写本地 Markdown) + file/sheet (走 OSS 通道写 upload_url) |
| file_path | TEXT | 相对输出路径（仅 doc/docx 节点有值；非 doc/docx 节点为占位空字符串，不生成本地文件） |
| updated_at | TEXT | 文档最后编辑时间 ISO 8601（sync-updated-at 阶段通过 wiki +node-get 获取并写入，download 阶段直接读取） |
| updated_at_last_synced_at | TEXT | 上次同步 updated_at 的时间（sync-updated-at 写入，配合 --max-age 实现增量同步） |
| scanned_at | TEXT | 索引扫描发现时间（sync 阶段写入） |
| parent_node_token | TEXT | 父节点 token |
| downloaded | INTEGER | ~~是否已下载~~（已废弃，使用 downloaded_at 与 updated_at 的时间比较判断下载状态，列保留兼容存量 DB） |
| downloaded_at | TEXT | 下载完成时间（写入即代表下载 + 图片处理均已完成） |
| human_path | TEXT | 人类可读路径（从 YAML frontmatter slug 解析） |
| description | TEXT | DeepSeek 生成的文档摘要描述，用于构建 og:description frontmatter |
| priority | INTEGER | 节点优先级（默认 0，单调累加）。下载阶段 `<cite>` / `<sub-page>` 解析回调在被引方节点存在但 human_path / upload_url 未就绪时 +1，被多篇文档依赖且尚未就绪的节点会排到下载队列前面；被引方 obj_token 不在 DB 时无法 bump（UPDATE 影响 0 行），需先跑 `sync` 把节点写进索引 |
| is_ignore | INTEGER | 是否被作者标记为内部草稿（默认 0）。下载管线解析 YAML `ignore: Y` 字段后覆盖写 0/1；`copydocs` 阶段过滤掉非零行 |
| group | TEXT | 文档分组（默认 `'default'`）。下载管线解析 YAML `group: <name>` 字段后覆盖写（仅允许 `[a-z0-9-]+`，非法值降级为 `default`）；`copydocs` 阶段按 group 分发到各自 `feishu.{group}.aimDirectory` |

### images — 图片

| 列 | 类型 | 说明 |
|----|------|------|
| md5 | TEXT PK | 图片内容 MD5 |
| ext | TEXT | 图片扩展名 |
| oss_url | TEXT | OSS 公网 URL |
| uploaded | INTEGER | 是否已上传 |
| created_at | TEXT | 创建时间 |
