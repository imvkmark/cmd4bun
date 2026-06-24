# download 默认图片处理 需求变更讨论

## 需求背景

`cmd.feishu download` 当前需要显式传 `--upload-images` 才会处理图片（下载 + MD5 去重 + 上传 OSS + Markdown URL 替换）。这条 flag 名字有歧义——它实际触发的是"图片处理"完整管线，OSS 上传是 `ossConfig` 配置后的副作用。

与此同时 `processImagesInFile`（[images.ts:280](src/feishu/images.ts#L280)）末尾已经实现了"节点级图片 diff"（[images.ts:366-377](src/feishu/images.ts#L366-L377)），但因为只在 `--upload-images` / `upload` 子命令下才触发，这块逻辑今天形同虚设。

`cmd.feishu upload` 是独立子命令，干的是"扫描 `image_uploaded=0` 节点 → 重做图片处理 → 末尾 `cleanupGlobalOrphans`"。

变更动机：

- **简化心智模型**：download 即"下载文档 + 处理图片"，不再分两阶段
- **消除歧义**：去掉 `--upload-images` 命名问题，去掉独立的 `upload` 子命令
- **激活已有能力**：让现成的 per-node diff 自动随每次下载生效
- **保持一致**：download 完成后 `image_uploaded=1` 自动成立，下游 `copy-docs` 不再依赖额外步骤

## 讨论后的关键结论

- **`cmd.feishu download` 默认执行完整图片处理管线**：下载图片 + MD5 去重 + 上传 OSS（无配置降级本地路径）+ 替换 Markdown 链接 + 节点级 diff
- **移除 `--upload-images` flag**：语义已并入默认行为
- **移除 `cmd.feishu upload` 子命令**：被 download 吸收后无独立价值
- **节点级 diff 自动激活**：`processImagesInFile` 末尾的 diff 块（[images.ts:366-377](src/feishu/images.ts#L366-L377)）已存在，本次随默认行为全面生效
- **`cleanupGlobalOrphans` 迁移到 `download` 末尾**：废弃 `upload` 后兜底机制不丢
- **OSS 未配置降级保留**：`ossConfig=null` 时仍把图片存到 `./images/{md5}.{ext}` 并替换 URL，不阻断只想下文档的人
- **存量 `image_uploaded=0` 节点**：通过 README 一句话引导用户首次升级后 `download --force` 一次

## 需求目标

把 `cmd.feishu download` 升级为"下载文档 + 处理图片（下载 + OSS 上传 + 节点级 diff）"的一体化流程，同时移除 `--upload-images` flag 和 `cmd.feishu upload` 子命令。

**边界**：
- 不改 `sync` / `sync-updated-at` / `init-db` 流程
- 不动 `processImagesInFile` 的核心管线（已具备 diff 能力）
- 不改 `cmd.feishu copy-docs` 的过滤逻辑（`image_uploaded=1` 仍然有效，且新流程下自然满足）
- 不动 `purgeOrphanNodes` / `cleanupOrphanImages`（已是成熟机制）
- 不改 `cmd.feishu download-item`（之前讨论中已废弃为独立子命令，仅作参数 `--node-token` 形式存在）
- 不做"自动识别升级场景"的存量扫尾（保持 `getDownloadQueue` 的续传语义纯粹）

## 当前流程

```
runDownload(args):
  ossConfig = buildOssConfig(cfg) || null
  if (args.nodeToken) 单节点模式:
    ok = downNode(...)
    if (args.uploadImages) uploadImagesForNode(...)   ← 仅 flag 开
  else 批量模式:
    for node in downloadQueue (并发):
      downNode(...)
      if (args.uploadImages) uploadImagesForNode(...)  ← 仅 flag 开

processImagesInFile(...)  ← 内部已带 diff 块（images.ts:366-377），仅未触发
  → 提取图片 URL
  → 下载 + MD5 去重
  → OSS 上传 (if ossConfig) / 本地路径
  → 替换 Markdown
  → markNodeImageUploaded
  → Diff 清理: cleanupOrphanImages(old - new)  ← 已存在

runUpload(args):
  uploadQueue = getImageUploadQueue(db)  ← image_uploaded=0 的节点
  for each node:
    processImagesInFile(...)
    markNodeImageUploaded
  → cleanupGlobalOrphans(db, outputDir, ossConfig)  ← 全局兜底
```

参考：
- [docs/feishu/overview.md](../../../feishu/overview.md)
- [docs/feishu/business.md](../../../feishu/business.md)
- [docs/feishu/flows.md](../../../feishu/flows.md)
- `src/feishu/download-flow.ts`
- `src/feishu/upload-flow.ts`
- `src/feishu/images.ts`

## 影响分析

### 1. `src/feishu/cli/types.ts`

- `DownloadArgs.uploadImages: boolean` 字段删除
- `CommandName` 联合去掉 `'upload'`
- `UploadArgs` 类型删除
- `ParsedCommand` 联合去掉 `{ command: 'upload'; args: UploadArgs }`

### 2. `src/feishu/cli/registry.ts`

- 删 `--upload-images` flag 定义（[registry.ts:201-204](src/feishu/cli/registry.ts#L201-L204)）
- 删 `--node-token` 解析里的 `args.uploadImages = true` 副作用（[registry.ts:197](src/feishu/cli/registry.ts#L197)）
- 删 `download` help 里的 `--upload-images` 行 + "默认开启" 措辞
- 删 `upload` spec 整块（[registry.ts:221-228](src/feishu/cli/registry.ts#L221-L228)）
- 删 `UPLOAD_HELP` 常量
- `ArgsByCommand` 接口去掉 `upload: CommonArgs`

### 3. `src/feishu/cli/parse-args.ts`

- 删 `case 'upload':` 分支（[parse-args.ts:76](src/feishu/cli/parse-args.ts#L76)）

### 4. `src/feishu/cli/main.ts`

- 删 `case 'upload':` 分支（[main.ts:27-30](src/feishu/cli/main.ts#L27-L30)）

### 5. `src/feishu/download-flow.ts`

- 单节点模式：[download-flow.ts:246-252](src/feishu/download-flow.ts#L246-L252) 的 `if (args.uploadImages)` 块改为无条件执行
- 批量模式：[download-flow.ts:309-313](src/feishu/download-flow.ts#L309-L313) 的 `if (args.uploadImages)` 块改为无条件执行
- 汇总输出：[download-flow.ts:340-345](src/feishu/download-flow.ts#L340-L345) 的图片处理统计日志改为始终输出
- 顶部 `ossConfig` 加载段（[download-flow.ts:217-223](src/feishu/download-flow.ts#L217-L223)）补加 aliyun CLI 存在性检查（从 `upload-flow.ts:25-30` 平移），CLI 缺失时打 warning 并把 `ossConfig` 置 null
- `runDownload` 末尾（`cleanupGlobalOrphans` 兜底）：
  - `processImagesInFile` 内部已有的 per-node diff + download-flow 末尾的 `cleanupGlobalOrphans` 双兜底
  - 输出统计："图片处理: N 失败: M" + "全局孤儿清理: K"
- `uploadImagesForNode` 函数保留为单节点/批量 worker 调用的封装，或考虑内联到 `downNode` 内（倾向保留独立函数以维持"下载一篇 → 处理图片一篇"的流水线语义）

### 6. `src/feishu/upload-flow.ts`

- 整个文件删除
- `runUpload` 函数不再被引用

### 7. `src/feishu/images.ts`

- **不需要改业务逻辑**：`processImagesInFile` 末尾的 diff 块（[images.ts:366-377](src/feishu/images.ts#L366-L377)）已经覆盖了"该节点不再引用的图片"清理
- `cleanupGlobalOrphans` 保留在 [images.ts:246](src/feishu/images.ts#L246)，调用方从 `upload-flow.ts` 改为 `download-flow.ts`

### 8. `src/feishu/db.ts`

- `getImageUploadQueue`（[db.ts:175-179](src/feishu/db.ts#L175-L179)）删除（仅 `upload-flow` 使用）
- `image_uploaded` 列保留（`copy-docs` 仍按其过滤；download 内部仍会写该字段）

### 9. 测试

- `tests/feishu-cli.test.ts`：
  - 删 test 51-56（upload 子命令解析）
  - 删 test 91-95（6.5 解析 upload 子命令）
  - 改 test 165-172：去掉 `uploadImages` 断言，仅保留 `nodeToken` / `force` 断言
  - 删 test 191-198（`--upload-images` 批量模式）
- `tests/feishu.test.ts`：删 test 35-39（6.1 解析 upload）
- `tests/feishu-oss.test.ts` / `tests/feishu/db-integration.test.ts`：检查是否有依赖 `upload` 或 `image_uploaded=0` 队列的 case（如有，对应调整或删除）

### 10. 文档

- `docs/feishu/overview.md`：
  - 模块结构表删 `feishu/upload-flow.ts` 一行
  - `feishu/download-flow.ts` 描述改为"下载文档 + 自动处理图片"
  - 功能入口表删 `cmd.feishu upload` 一行
  - 改 OSS 配置必填场景（之前是 `upload` / `download-item --upload-images`，现在统一为 `download`）
  - `nodes` 表 `image_uploaded` 列说明保留（语义微调为"图片处理完成标记"）
- `docs/feishu/business.md`：
  - 删"飞书图片上传"状态机章节
  - 把"图片处理"语义并入"飞书文档下载"章节
  - 改"飞书单节点下载"章节关于 `UPLOAD_IMAGES` 的描述
- `docs/feishu/flows.md`：
  - 删"图片上传流程"章节
  - 把"下载流程"扩为"下载 + 图片处理"，序列图更新
  - 改"单节点下载流程" sequence 图
  - "关键设计决策"中"已公网化图片跳过"等与图片处理相关的描述保留
- `README.md`：删 line 8、10、19 的 `--upload-images` flag；新增一行升级提示（"存量 `image_uploaded=0` 节点首次升级后请 `download --force` 一次"）

### 11. 级联副作用

- **`copy-docs`**：现在 `download → copy-docs` 即可工作，缺一步 `upload` 的事没了
- **`--node-token` 模式**：原本靠自动开 `uploadImages` 让单节点下载后立即处理图片。改后默认就是如此，行为保留
- **OSS 配置缺失场景**：`ossConfig=null` 降级为本地路径 + warning，行为与现有 `--upload-images` 一致
- **aliyun CLI 缺失场景**：warning + `ossConfig` 置 null + 走本地路径降级，与现有 `upload` 行为一致

### 12. 数据一致性与过渡

- 一次性迁移：本次 commit 后第一次 `download` 不会主动处理历史 `image_uploaded=0` 的节点（因为 `downloaded_at` >= `updated_at` 时不入队）。这些节点需要用户主动 `download --force` 一次才能触发图片处理
- 引导方式：README 增加一句升级提示
- 不在事务里（沿用现有风格），单步失败下次 download 自然补回
- 失败节点保留 `image_uploaded=0`，配合重跑机制自然过渡

## 方案对比

### 方案 A：直接采纳本次讨论结论（推荐）

**核心思路**：完全按讨论结果——download 默认处理图片、移除 `--upload-images`、移除 `upload` 子命令、`cleanupGlobalOrphans` 迁移到 download 末尾、OSS 降级保留、存量靠 README 引导。

**优点**：
- 一次到位，符合"简化心智模型"的初衷
- per-node diff 全面激活，"图片不引用即清" 的语义在所有下载场景下成立
- `cmd.feishu` 子命令数量从 6 个减为 5 个（去掉 `upload`），命令空间更干净
- `copy-docs` 不再需要 "先 upload 再 copy" 的两步操作

**缺点**：
- `upload` 子命令废弃属于破坏性变更，外部脚本如果依赖需要改
- 存量 `image_uploaded=0` 节点需要用户主动 `--force` 一次

**实施复杂度**：中（涉及 CLI / download-flow / upload-flow 删除 / images 调用方迁移 / 多份文档同步更新 / 多个测试调整）

### 方案 B：保留 `upload` 作为"重跑"入口

**核心思路**：仍然去掉 `--upload-images`（默认行为），但保留 `cmd.feishu upload` 作为"全量重做图片处理"的入口（去掉 `image_uploaded=0` 过滤）。

**优点**：
- 存量数据可以靠 `upload` 一键过渡，不需要 `--force` 全量重下
- `upload` 仍然有用——失败重试 / OSS 重新配置后的重传

**缺点**：
- 违反"废弃 upload"的方向
- "upload" 这个名字对"全量重做图片"的语义有误导

**实施复杂度**：低（比方案 A 少一个文件删除，但要多一个过滤条件调整）

### 方案 C：保留 `--upload-images` 但语义改为 `--skip-images`

**核心思路**：默认行为改为处理图片，但允许 `--skip-images` 跳过图片处理以加速纯文档下载。

**优点**：
- 保留逃生口：纯文档下载场景不需要碰图片
- 与 `--force` 形成镜像（一个是强制文档重下，一个是跳过图片）

**缺点**：
- 多一个 flag，CLI 复杂度+1
- 大多数场景下用户其实都希望图片被处理，逃生口用得少

**实施复杂度**：中（仅是参数名变化 + 帮助文本 + 一处 if 反转）

## 推荐方案

**方案 A：直接采纳本次讨论结论**

理由：
- 用户的原始诉求"所有下载均需要下载图片"和"删除 upload 子命令"已经明确，方案 A 严格对齐
- per-node diff 已存在，激活它零代码成本
- "图片处理是 download 的固有部分"这条语义在方案 A 下完全成立；方案 B/C 都在不同方向上回避
- 升级成本可控（README 一句话 + 一次性 `--force`）

`cleanupGlobalOrphans` 移到 `download` 末尾（子方案 1a）的理由：废弃 `upload` 后兜底机制不能丢——sync `purgeOrphanNodes` 只在 sync 命中时清理，per-node diff 只清"被显式重下的节点"的孤儿图。"所有节点都正常但 images 表有完全无人引用的行"这种角落情况仍要兜底。性能成本可接受（与 `upload` 触发频率相近，download 也不会每天跑）。

OSS 降级保留（子方案 3）的理由：与现有 `--upload-images` 在无 OSS 配置下的行为一致，避免在 OSS 不可用时 download 直接报错退出。

## 待确认事项

- [x] 是否废弃 `cmd.feishu upload` —— ✅ 确认废弃
- [x] OSS 缺失行为 —— ✅ 降级本地路径 + warning
- [x] 存量 `image_uploaded=0` 节点处理 —— ✅ 文档引导 `--force` 一次
- [ ] README 升级提示的具体措辞（实施时定）
- [ ] `uploadImagesForNode` 保留为独立函数 vs 内联到 `downNode`（倾向保留，但需在实施时验证可读性）

## 实施建议

按优先级：

1. **`src/feishu/db.ts`**：删 `getImageUploadQueue` 函数（确认无其他引用）。
2. **`src/feishu/upload-flow.ts`**：删整个文件。
3. **`src/feishu/cli/types.ts`**：删 `UploadArgs`、删 `DownloadArgs.uploadImages`、删 `CommandName` 中的 `'upload'`、删 `ParsedCommand` 中的 `upload` 分支。
4. **`src/feishu/cli/registry.ts`**：删 `UPLOAD_HELP`、删 `upload` spec、删 `--upload-images` flag、删 `--node-token` 解析里的 `uploadImages` 副作用、更新 `DOWNLOAD_HELP`、`ArgsByCommand` 去掉 `upload`。
5. **`src/feishu/cli/parse-args.ts`**：删 `case 'upload':`。
6. **`src/feishu/cli/main.ts`**：删 `case 'upload':`。
7. **`src/feishu/download-flow.ts`**：
   - 单节点 / 批量模式无条件调用 `uploadImagesForNode`
   - 图片处理统计始终输出
   - 顶部补 aliyun CLI 存在性检查（从 `upload-flow.ts:25-30` 平移）
   - `runDownload` 末尾调 `cleanupGlobalOrphans` 并输出统计
8. **测试**：
   - `tests/feishu-cli.test.ts`：删 4 个 test / 改 1 个 test
   - `tests/feishu.test.ts`：删 1 个 test
   - 跑 `bun test` 验证
9. **文档**：
   - `docs/feishu/overview.md`：模块结构 / 功能入口 / OSS 必填场景
   - `docs/feishu/business.md`：合并"图片处理"进"飞书文档下载"，删独立章节
   - `docs/feishu/flows.md`：合并"下载 + 图片处理"流程图，删独立章节
   - `README.md`：删 `--upload-images`，加升级提示
10. **验证**：
    - 跑 `bun run lint`
    - 跑 `bun test`
    - 跑 `bun run build` 确认产物正常
    - （可选）手动 `cmd.feishu download --force --node-token <token>` 验证图片处理 + diff 行为

## 结论

这次变更的本质是把"download 文档"和"处理图片"两件事从两个分立的子命令（download + upload）和一个 flag（--upload-images）合并为 download 默认行为，让 `processImagesInFile` 已有的节点级 diff 能力在所有下载场景下自动生效。改动触及 CLI 入口、download-flow 主流、images 调用方迁移和 upload-flow 文件删除，但每个点的变化都是"删除条件分支 / 删除 flag / 迁移调用"这种收敛式重构，没有引入新概念。配合 README 一句话的升级引导，存量数据可以平滑过渡。
