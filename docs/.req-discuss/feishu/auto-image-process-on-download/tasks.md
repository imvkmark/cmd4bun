# download 默认图片处理 任务清单

> 来源：[discuss.md](./discuss.md)
> 模式：完整讨论 → 执行落地

## 任务状态

- [ ] 待开始
- [~] 进行中
- [x] 已完成

## Agent 执行约定

> 以下约定对执行本任务清单的 Agent 有约束力。

- **开始子任务**：将对应行的 `- [ ]` 改为 `- [~]`（进行中）
- **完成子任务**：将对应行的 `- [~]` 改为 `- [x]`（已完成）
- **粒度(必须)**：每完成一个叶子任务（如 `1.1`、`2.3`）立即更新该行，不要等到阶段结束
- **不可修改**：不要修改 Agent 约定块本身、任务编号和任务描述文字，只修改 `[ ]` / `[~]` / `[x]` 状态标记

## 1. 前置依赖检查

> 进入开发前先把"会被改动的符号"摸清，避免漏改。

- [x] **1.1** 全仓 grep `cmd.feishu upload` / `runUpload` / `getImageUploadQueue` / `uploadImages` / `--upload-images`，记录所有调用点（已确认：`src/feishu/cli/registry.ts:7, 69-70, 183, 197, 201-204, 227`；`src/feishu/cli/types.ts:16, 19, 28, 37`；`src/feishu/cli/parse-args.ts:76`；`src/feishu/cli/main.ts:27-30`；`src/feishu/download-flow.ts:148, 246-247, 309-310, 340`；`src/feishu/upload-flow.ts` 整个文件；`src/feishu/db.ts:175-179`；`tests/feishu-cli.test.ts:51-56, 91-95, 165-172, 191-198`；`tests/feishu.test.ts:35-39`；`tests/feishu/db-integration.test.ts:277-279`；`README.md:8, 10, 19`；`docs/feishu/overview.md:19, 54, 64, 99-103`；`docs/feishu/business.md:143, 150, 179`；`docs/feishu/flows.md:234, 238, 267, 338, 348, 367`）
- [x] **1.2** 确认 `processImagesInFile` 末尾的 per-node diff 块（`images.ts:366-377`）当前实现是否覆盖"该节点不再引用的图片清理"——答案是 ✅，本次变更不需改这段代码
- [x] **1.3** 确认 `cleanupGlobalOrphans` 的调用方只有 `upload-flow.ts:96`，调用时机是 upload 末尾

## 2. db.ts: 移除 `getImageUploadQueue`

> 修改范围：`src/feishu/db.ts` line 175-179
> 验证：移除后 `src/feishu/db.ts` 中 `getImageUploadQueue` 不再被引用

- [ ] **2.1** 从 `src/feishu/db.ts` 删 `getImageUploadQueue` 函数定义
- [ ] **2.2** 全仓 grep `getImageUploadQueue` 确认无残留引用
- [ ] **2.3** `image_uploaded` 列保留（`copy-docs` 与 download 主流程仍依赖）

## 3. 删除 `upload-flow.ts`

> 整个文件删除
> 验证：删除后 `src/feishu/upload-flow.ts` 不存在

- [x] **3.1** 删 `src/feishu/upload-flow.ts` 整个文件
- [x] **3.2** 全仓 grep `runUpload` / `from.*upload-flow` 确认无残留引用（无残留）

## 4. cli/types.ts: 清理类型定义

> 修改范围：`src/feishu/cli/types.ts`
> 验证：编译通过，TS 联合收敛

- [ ] **4.1** 删 `UploadArgs` 类型（line 19）
- [ ] **4.2** 删 `DownloadArgs.uploadImages: boolean` 字段（line 16）
- [ ] **4.3** 删 `CommandName` 联合中的 `'upload'`（line 28）
- [ ] **4.4** 删 `ParsedCommand` 联合中的 `{ command: 'upload'; args: UploadArgs }` 分支（line 37）

## 5. cli/registry.ts: 清理命令注册

> 修改范围：`src/feishu/cli/registry.ts`
> 验证：编译通过，`cmd.feishu help` 列表里没有 upload

- [ ] **5.1** 删 `UPLOAD_HELP` 常量（line 80-92）
- [ ] **5.2** 删 `ArgsByCommand` 接口中的 `upload: CommonArgs`（line 151）
- [ ] **5.3** 删 `upload` spec 整块（line 221-228）
- [ ] **5.4** 删 `download` help 文本里的 `--upload-images` 行（line 70）
- [ ] **5.5** 删 `download` help 文本里"使用 --node-token 时仅下载单个节点，默认开启 force 和图片上传"里的"和图片上传"措辞（line 77）
- [ ] **5.6** 删 `download` spec 的 `--upload-images` flag 定义（line 201-204）
- [ ] **5.7** 删 `--node-token` 解析里的 `args.uploadImages = true` 副作用（line 197），保留 `args.force = true`
- [ ] **5.8** 删 `download` spec 的 `buildArgs` 中 `uploadImages: false` 字段（line 183）

## 6. cli/parse-args.ts: 清理 case

> 修改范围：`src/feishu/cli/parse-args.ts` line 76

- [ ] **6.1** 删 `case 'upload':` 分支（line 76）

## 7. cli/main.ts: 清理 case

> 修改范围：`src/feishu/cli/main.ts` line 27-30

- [ ] **7.1** 删 `case 'upload':` 分支（line 27-30）

## 8. download-flow.ts: 默认开启图片处理 + 全局兜底

> 修改范围：`src/feishu/download-flow.ts`
> 验证：默认 download 调用即处理图片；OSS 缺失降级；末尾全局孤儿清理

### 8.1 默认开启图片处理

- [ ] **8.1.1** 单节点模式 [download-flow.ts:246-252](src/feishu/download-flow.ts#L246-L252)：把 `if (args.uploadImages)` 块改为无条件执行 `uploadImagesForNode` + 始终输出"图片处理"日志
- [ ] **8.1.2** 批量模式 [download-flow.ts:309-313](src/feishu/download-flow.ts#L309-L313)：把 `if (args.uploadImages)` 块改为无条件执行 `uploadImagesForNode` + 累加 `imagesProcessed` / `imagesFailed`
- [ ] **8.1.3** 汇总输出 [download-flow.ts:340-345](src/feishu/download-flow.ts#L340-L345)：把 `if (args.uploadImages)` 包起来的"图片处理"统计日志改为始终输出
- [ ] **8.1.4** 类型修正：`DownloadArgs` 已经没有 `uploadImages`，`args` 引用不要残留

### 8.2 aliyun CLI 存在性检查

- [ ] **8.2.1** 把 [upload-flow.ts:23-32](src/feishu/upload-flow.ts#L23-L32) 的 OSS 加载 + aliyun CLI 检查逻辑平移到 `download-flow.ts` 的 ossConfig 加载段（[download-flow.ts:217-223](src/feishu/download-flow.ts#L217-L223)）：先 `loadConfig` + `buildOssConfig`；若 `ossConfig` 存在则 `Bun.spawnSync(['aliyun', '--help'])` 探测 CLI；若 `ossConfig` 缺失或 CLI 探测失败，输出 warning 并把 `ossConfig` 置 null（走本地路径降级）
- [ ] **8.2.2** CLI 缺失 warning 文案参考：`  ⚠ aliyun CLI 未安装，将仅保存图片到本地`（保持与 `upload-flow.ts:28` 一致风格）

### 8.3 全局孤儿兜底迁移

- [ ] **8.3.1** 在 `runDownload` 末尾（`closeDB()` 之前）增加 `cleanupGlobalOrphans` 调用 + 输出 `孤儿图片清理: N` 日志
- [ ] **8.3.2** 用 `try/catch` 包住 `cleanupGlobalOrphans` 调用，异常时输出 warning 但不中断主流程（与 [upload-flow.ts:100-102](src/feishu/upload-flow.ts#L100-L102) 风格一致）
- [ ] **8.3.3** 确认 `cleanupGlobalOrphans` 的 import 已在 `download-flow.ts:9` 附近（`processImagesInFile` 旁边）

### 8.4 uploadImagesForNode 封装决策

- [ ] **8.4.1** 复核 `uploadImagesForNode` 函数（[download-flow.ts:148-161](src/feishu/download-flow.ts#L148-L161)）的封装是否仍有价值
  - 倾向保留：单节点 + 批量 worker 复用同一封装，调用方更简洁
  - 若选择内联：把 `processImagesInFile + markNodeImageUploaded` 拆到 `downNode` 与 `downloadWorker` 两个调用点，删除 `uploadImagesForNode` 包装层
  - 决定后按选定的方案执行
- [ ] **8.4.2** 若保留：函数名 `uploadImagesForNode` 仍然准确（封装了"下载图片 + 标记 image_uploaded"），无需改名

## 9. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循 architecture.md）
> 其他要求：测试标签使用中文（`describe` / `test` 的中文描述）
> 测试目录：`tests/feishu-cli.test.ts`（解析测试）、`tests/feishu/download-flow.test.ts`（download 行为测试）

### 9.1 调整现有测试

- [ ] **9.1.1** `tests/feishu-cli.test.ts` test 51-56（"解析 upload 子命令"）：删除整段测试
- [ ] **9.1.2** `tests/feishu-cli.test.ts` test 91-95（"6.5 解析 upload 子命令"）：删除整段测试
- [ ] **9.1.3** `tests/feishu-cli.test.ts` test 165-172（"6.6 download --node-token 自动开启 force 和 upload-images"）：把标题改为"download --node-token 自动开启 force"，删 `expect((result.args as DownloadArgs).uploadImages).toBe(true);` 断言
- [ ] **9.1.4** `tests/feishu-cli.test.ts` test 191-198（"6.6 download --upload-images 批量模式可手动开启"）：删除整段测试
- [ ] **9.1.5** `tests/feishu.test.ts` test 35-39（"6.1 parseArgs 解析 upload 子命令"）：删除整段测试
- [ ] **9.1.6** 跑 `bun test` 验证现有测试无回归

### 9.2 新增测试（中文标签）

- [ ] **9.2.1** `download` 子命令解析后无 `uploadImages` 字段：`expect((result.args as DownloadArgs).uploadImages).toBeUndefined();`（或类似），确认类型层删干净
- [ ] **9.2.2** `download` 子命令不再识别 `--upload-images` flag：调用 `parseArgs(['download', '--upload-images'])` 应走未知参数路径并以非零退出
- [ ] **9.2.3** `upload` 子命令不再识别：调用 `parseArgs(['upload'])` 应走未知参数路径并以非零退出
- [ ] **9.2.4** `download` 默认调用 `uploadImagesForNode` / `processImagesInFile`：通过 mock `processImagesInFile` 验证 `runDownload` 主流程（无 `--upload-images` flag）会调用 `processImagesInFile`
- [ ] **9.2.5** `download` 末尾调用 `cleanupGlobalOrphans`：通过 mock `cleanupGlobalOrphans` 验证 `runDownload` 主流程在 `closeDB` 之前会调用 `cleanupGlobalOrphans(db, outputDir, ossConfig)`
- [ ] **9.2.6** `download` 无 OSS config 时降级本地路径：通过 mock `buildOssConfig` 返回 null，验证 `ossConfig` 在 download-flow 内部被置 null 后 `uploadImagesForNode` 走 `imagesDir` 本地路径分支
- [ ] **9.2.7** `download` aliyun CLI 缺失时打 warning：通过 mock `Bun.spawnSync` 返回非零 exitCode，验证 warning 文本输出
- [ ] **9.2.8** 节点级 diff 行为：复用 `tests/feishu/images.test.ts` 的 diff 场景，确认 `processImagesInFile` 末尾的 `cleanupOrphanImages` 触发——`processImagesInFile` 测试加 case 验证"重下后老图片被 cleanup"

## 10. 验证与审查

- [ ] **10.1** 运行 `bun run lint`，修复格式问题
- [ ] **10.2** 运行 `bun test`，所有测试通过（特别确认 `tests/feishu/db.test.ts` / `tests/feishu/db-integration.test.ts` / `tests/feishu/images.test.ts` / `tests/feishu/download-flow.test.ts` 不回归）
- [ ] **10.3** 运行 `bun run build` 确认产物正常
- [ ] **10.4** 手动验证：`bun run src/feishu.ts --help` 输出列表中没有 `upload`；`bun run src/feishu.ts download --help` 输出中无 `--upload-images`
- [ ] **10.5** 手动验证（可选）：`bun run src/feishu.ts download --force --node-token <token>` 验证默认 download 触发图片处理（用一个已知有图片的 node_token）
- [ ] **10.6** 手动验证（可选）：临时往 `images` 表插一行孤儿（无任何 markdown 引用），跑 `download --force`，验证 `cleanupGlobalOrphans` 末尾清理掉
- [ ] **10.7** 运行 `/code-review` skill 审查全部 diff，按审查意见修复

## 11. 文档更新

> 任务 11 在任务 1-10 全部完成且通过验收后执行。

### 11.1 docs/feishu/overview.md

- [ ] **11.1.1** 模块结构表删 `feishu/upload-flow.ts` 一行
- [ ] **11.1.2** `feishu/download-flow.ts` 描述改为"并发下载 + 断点续传 + 默认处理图片（下载/OSS 上传/URL 替换/节点级 diff）"
- [ ] **11.1.3** 功能入口表删 `cmd.feishu upload` 一行
- [ ] **11.1.4** OSS 配置必填场景：原 "`upload` / `download-item --upload-images` 必填" 统一改为 "`download` 必填（OSS 缺失时降级本地路径）"
- [ ] **11.1.5** 数据库结构 `nodes` 表 `image_uploaded` 列说明：原"图片是否已上传到 OSS"改为"图片处理是否完成（默认 0）"

### 11.2 docs/feishu/business.md

- [ ] **11.2.1** 删"飞书图片上传"状态机章节
- [ ] **11.2.2** "飞书文档下载"章节新增"图片处理"小节：默认随 download 一并处理；行为完全沿用 `processImagesInFile`（下载/去重/OSS 上传/URL 替换/per-node diff）
- [ ] **11.2.3** "飞书单节点下载"章节：删 `UPLOAD_IMAGES` 状态描述
- [ ] **11.2.4** "配置优先级"段：OSS 配置必填场景同步更新为 "`download` 需要 OSS 配置（未配置时降级本地路径）"

### 11.3 docs/feishu/flows.md

- [ ] **11.3.1** 删"图片上传流程"整段章节
- [ ] **11.3.2** "文档下载流程"扩为"下载 + 图片处理"：流程图新增 `processImagesInFile` + `markNodeImageUploaded` + 末尾 `cleanupGlobalOrphans` 步骤
- [ ] **11.3.3** "单节点下载流程" sequence 图：删 `--upload-images` 可选分支，新增"下载后立即处理图片（默认）"
- [ ] **11.3.4** "关键设计决策"段：把"已公网化图片跳过""MD5 去重"等图片相关决策与 download 合并描述

### 11.4 README.md

- [ ] **11.4.1** 删 line 8、10、19 的 `--upload-images` flag
- [ ] **11.4.2** 在"下载"段新增一行升级提示："升级提示：本次变更后 `image_uploaded=0` 的存量节点需要 `download --force` 一次触发图片处理"

## 任务依赖关系

- **执行顺序**：1（前置）→ 2（db.ts 移除）→ 3（删 upload-flow）→ 4、5、6、7（CLI 清理，**可并行**，无文件冲突）→ 8（download-flow 主战场）→ 9（单测）→ 10（验证与审查）→ 11（文档）
- **依赖关系**：
  - 任务 1 必须先于 2-8（避免漏改）
  - 任务 2 完成后才能全仓 grep 验证（2.2 / 3.2）
  - 任务 4、5、6、7 之间无依赖，可并行（不同文件）
  - 任务 8 依赖任务 4-7（CLI 层清理干净后，download-flow 的 `args.uploadImages` 引用才不会出现 TS 报错）
  - 任务 9.2.2、9.2.3 依赖任务 5.6、3.1（flag / 子命令确实移除）
  - 任务 9.2.4、9.2.5 依赖任务 8（download-flow 主流程就绪）
  - 任务 10 依赖任务 2-9 全部完成
  - 任务 11 依赖任务 10.7（审查通过后再更新文档）
- **并行约束**：
  - 任务 4、5、6、7 之间可并行（CLI 类型、registry、parse-args、main 都是独立小文件）
  - 任务 9.1（调整测试）和任务 8（download-flow）不建议并行（测试断言可能在 8 中调整），建议串行
  - 任务 11 内部 11.1/11.2/11.3/11.4 可并行（不同文件）
- **其他约束**：
  - 类型层（任务 4）必须先于逻辑层（任务 8），否则 download-flow 引用 `args.uploadImages` 会编译失败
  - `cleanupGlobalOrphans` 的 `try/catch` 包住（任务 8.3.2）必须严格遵守——单步失败不能阻断整个 download 主流程
  - 任务 9.2.5 的 mock 要注意：`cleanupGlobalOrphans` 是 `import` 自 `images.ts`，需要通过 `mock.module` 或在测试入口替换 `images.ts` 的导出，验证调用
