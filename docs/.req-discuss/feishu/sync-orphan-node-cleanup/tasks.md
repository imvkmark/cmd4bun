# sync 孤儿节点清理 任务清单

## 任务状态

- [ ] 待开始
- [~] 进行中
- [x] 已完成

## Agent 执行约定

> 以下约定对执行本任务清单的 Agent 有约束力。

- **开始子任务**：将对应行的 `- [ ]` 改为 `- [~]`（进行中）
- **完成子任务**：将对应行的 `- [~]` 改为 `- [x]`（已完成）
- **粒度(必须)**：每完成一个叶子任务（如 `2.1`）立即更新该行，不要等到阶段结束
- **不可修改**：不要修改 Agent 约定块本身、任务编号和任务描述文字，只修改 `[ ]` / `[~]` / `[x]` 状态标记

## 1. 前置依赖检查

- [ ] **1.1** 全仓 grep `deleteNodesBySpace` 与 `getImagesByNode` 引用，记录所有调用点（已知：`deleteNodesBySpace` 在 `src/feishu/sync-flow.ts:9, 175`；`getImagesByNode` 在 `src/feishu/download-flow.ts:7, 101`、`src/feishu/images.ts:6, 362`、`src/feishu/sync-flow.ts:9, 192, 251`）
- [ ] **1.2** 确认 `cleanupOrphanImages` 的签名 `(db, md5List, nodeToken, outputDir, ossConfig)` 与 images 行依赖：`getImageByMd5` 用于查 ext，必须在 images 行删除前调用

## 2. db.ts: 新增 `purgeOrphanNodes`

> **顺序约束（重要）**：`cleanupOrphanImages` 内部依赖 `getImageByMd5` 查 ext 才能删本地 temp + OSS，所以 images 行必须保留到 `cleanupOrphanImages` 调用之后。正确顺序：`SELECT → DELETE nodes → rmSync 本地文件 → cleanupOrphanImages(自动 DELETE images 行)`。discuss.md 里写的"先 DELETE images"是错的，实施时按本任务清单的顺序。

- [ ] **2.1** 在 `src/feishu/db.ts` 中新增 `purgeOrphanNodes(db: Database, nodeTokens: string[], outputDir: string, ossConfig: OssClientConfig | null): { filePaths: string[] }` 函数
- [ ] **2.2** 函数入口短路：`nodeTokens.length === 0` 直接返回 `{ filePaths: [] }`，避免 `IN ()` SQL 错误
- [ ] **2.3** 用占位符 `?` 拼接 SQL：`SELECT file_path FROM nodes WHERE node_token IN (?,?,...)`，防 SQL 注入
- [ ] **2.4** 同占位符拼接：`SELECT md5, node_token FROM images WHERE node_token IN (?,?,...)`，收集 `(md5, node_token)` 对
- [ ] **2.5** 同占位符拼接：`DELETE FROM nodes WHERE node_token IN (?,?,...)`
- [ ] **2.6** 遍历 `filePaths`，`rmSync(join(outputDir, fp))`（`existsSync` 判定）
- [ ] **2.7** 遍历 `(md5, nodeToken)` 对，调 `cleanupOrphanImages(db, [md5], nodeToken, outputDir, ossConfig)`，让 `deleteImageByMd5AndNode` 副作用负责清 images 行
- [ ] **2.8** 返回 `{ filePaths }` 给 sync-flow 用于日志
- [ ] **2.9** 从 `./images` 引入 `cleanupOrphanImages` 与 `OssClientConfig` 类型（注意 `db.ts` 当前不依赖 `./images`，需要确认 import 方向避免循环依赖；若出现循环，把 `cleanupOrphanImages` 的内联逻辑搬到 `db.ts`，或抽到一个新文件）

## 3. sync-flow.ts: 重构空间级清理分支

> 修改范围：`src/feishu/sync-flow.ts` line 167-203

- [ ] **3.1** line 167 的 `if (args.spaces.length === 0)` 判断保留（全量模式才清整个空间）
- [ ] **3.2** line 168-169 计算 `activeSpaceIds` 保留
- [ ] **3.3** line 170-202 的 for 循环内：先收集 `tokens = SELECT node_token FROM nodes WHERE space_id=?`（在调 `deleteSpace` 之前），再调 `purgeOrphanNodes(db, tokens, outputDir, ossConfig)`，再 `deleteSpace(db, spaceId)`
- [ ] **3.4** line 173 `spaceNodeTokens` 收集代码删除（已被 3.3 替代）
- [ ] **3.5** line 175 `const { name, filePaths } = deleteNodesBySpace(db, spaceId)` 改为 `const name = ...`（直接查 spaces 表取 name）+ 3.3 的 `filePaths`
- [ ] **3.6** line 188-200 整段 `try { for (const nt of spaceNodeTokens) { ... } }` 图片清理块移除（已在 `purgeOrphanNodes` 内部处理）
- [ ] **3.7** line 186 日志 `console.log` 保留（孤儿文件清理提示仍然有价值）
- [ ] **3.8** line 9 的 import 调整：删除 `deleteNodesBySpace`、`getImagesByNode`，保留 `getSpaceIds`、`deleteSpace`（仍在用）

## 4. sync-flow.ts: 新增节点级 diff

> 修改范围：`src/feishu/sync-flow.ts` line 88-161（每个 space 扫描循环内）

- [ ] **4.1** 在 line 161（`writeProgress` 之前）插入节点级 diff 段
- [ ] **4.2** 收集 `dbTokens = SELECT node_token FROM nodes WHERE space_id=?`
- [ ] **4.3** 计算 `orphanTokens = dbTokens.filter(t => !nodeMap.has(t))`（`nodeMap` 是 line 91 的本 space 节点索引）
- [ ] **4.4** 若 `orphanTokens.length > 0`，调 `purgeOrphanNodes(db, orphanTokens, outputDir, ossConfig)`，并按 `filePaths.filter(fp => existsSync(...)).length` 输出日志 `console.log(`    ${C.yellow}−${C.reset} ${space.name} 清理 ${removedCount} 个孤儿节点`);`
- [ ] **4.5** 确认 `writeProgress` 行（line 160）的输出仍准确反映 `nodeCount`/`docNodeCount`/`skipNodeCount`（这些是"本次扫到的"，与孤儿无关）

## 5. db.ts: 移除 `deleteNodesBySpace`

> 依赖：任务 3 完成（确认 sync-flow.ts 不再 import `deleteNodesBySpace`）

- [ ] **5.1** 从 `src/feishu/db.ts` 删 `deleteNodesBySpace` 函数定义（line 186-193）
- [ ] **5.2** 全仓再次 grep `deleteNodesBySpace` 确认无残留引用
- [ ] **5.3** 同步检查 `docs/.req-discuss/feishu/global-orphan-image-cleanup/discuss.md` 等历史文档是否引用此函数名（如有，更新为新名称或标注废弃）

## 6. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循 architecture.md）
> 其他要求：测试标签使用中文（`describe` / `test` 的中文描述）
> 测试目录：`tests/feishu/db.test.ts`（已有 `describe` 风格的 feishu db 测试，可追加 `describe('purgeOrphanNodes')` 块）

- [ ] **6.1** **空数组短路**：传入 `[]` 时，`purgeOrphanNodes` 返回 `{ filePaths: [] }`，不执行任何 SQL（用 spy 或 mock 验证 db.prepare 未被调用，或直接验证 nodes/images 行数不变）
- [ ] **6.2** **删除 nodes 行**：插入若干 nodes 行，传入对应 nodeTokens，验证对应 nodes 行被删，其他 nodes 行保留
- [ ] **6.3** **images 行清理**：插入 images 行（关联到待删 nodeToken），验证 `purgeOrphanNodes` 调用后 images 行被 `deleteImageByMd5AndNode` 清掉
- [ ] **6.4** **本地文件删除**：用 `tmpDir` 创建若干 `.md` 文件，传入对应 `file_path`，验证 `rmSync` 后文件不存在（`existsSync` 返回 false）
- [ ] **6.5** **cleanupOrphanImages 调用**：用 spy / mock 包裹 `cleanupOrphanImages`，验证传入 `(db, [md5], nodeToken, outputDir, ossConfig)` 参数正确
- [ ] **6.6** **占位符 SQL 防注入**：传入 `'a"b'`、`"a'b"` 等特殊字符的 token，验证 SQL 不报错且按字面匹配

## 7. 验证与审查

- [ ] **7.1** 运行 `bun run lint`，修复格式问题
- [ ] **7.2** 运行 `bun test`，所有测试通过（特别确认现有 `tests/feishu/db.test.ts` 与 `tests/feishu/db-integration.test.ts` 不回归）
- [ ] **7.3** 手动 `bun run src/feishu.ts sync` 一次，验证孤儿节点被清理、日志输出正确（构造一个 fake 孤儿：先 sync 一次，再手动往 nodes 表插一行 + 在 outputDir 创建对应 .md 文件 + 在 images 表插一行 + 在 data/temp/ 放对应图片文件，再 sync 第二次，验证孤儿节点 + images 行 + 本地文件 + OSS 都被清掉）
- [ ] **7.4** 运行 `/code-review` skill 审查全部 diff，按审查意见修复

## 8. 文档更新

> 任务 9 在任务 1-7 全部完成且通过验收后执行。

- [ ] **8.1** 更新 `docs/feishu/flows.md` 的"索引同步流程"段：在 Phase 1 末尾加"节点级 diff → 清理孤儿节点"步骤，Phase 2 之前的清理逻辑新增"`purgeOrphanNodes` 统一节点清理路径"
- [ ] **8.2** 更新 `docs/feishu/business.md` 的"飞书知识库索引 - 关键业务规则"：新增"以本次扫描结果为准"规则——本次扫到进入索引，本次未扫到（包括历史孤儿）从索引、本地文件、OSS 同步清理
- [ ] **8.3** 更新 `docs/feishu/overview.md` 的"数据库结构"表：确认 `nodes` / `images` 表描述已反映"同步阶段同步清理"，无需新增列；模块结构表中 `db.ts` 注释里 `deleteNodesBySpace` 改为 `purgeOrphanNodes`（如 overview.md 有此引用）

## 任务依赖关系

- **执行顺序**：
  - 1（前置）→ 2（db.ts 新增函数）→ 3、4（sync-flow.ts 两处改动可串行）→ 5（db.ts 移除旧函数）→ 6（单测）→ 7（验证）→ 8（审查）→ 9（文档）
- **依赖关系**：
  - 任务 2 必须先于 3、4（提供函数）
  - 任务 3、4 串行（同文件改动）
  - 任务 5 依赖任务 3（确保 sync-flow.ts 不再 import）
  - 任务 6 依赖任务 2（函数存在才能测）
  - 任务 7 依赖任务 5、6
  - 任务 8 依赖任务 7
  - 任务 9 依赖任务 8（审查通过后再更新文档）
- **并行约束**：
  - 任务 3、4 之间不建议并行（同文件改动，git diff 冲突风险）
  - 任务 6（单测）理论上可与 3、4 并行（不同文件），但建议串行，避免 commit 粒度过大
- **其他约束**：
  - `cleanupOrphanImages` 调用顺序约束（images 行必须保留到 `cleanupOrphanImages` 调用之后）在任务 2.7 严格执行
  - 任务 3.8 的 import 调整必须在任务 5 之前完成，否则会出现"import 已不存在函数"