# upload 完成后全局孤儿图片清理 任务清单

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

## 1. 新增全局孤儿图片扫描函数

- [x] **1.1** 在 `src/feishu/images.ts` 中新增 `findOrphanImages(db: Database, outputDir: string)` 函数。逻辑：调用 `findMdFiles(outputDir)` 获取所有 `.md` 文件 → 遍历每个文件提取图片 URL → 正则匹配提取 `{md5}.{ext}` 文件名 → 构建引用 MD5 集合 → 查询 `images` 表所有 `md5` → 返回不在引用集合中的孤儿 `{ md5: string; ext: string }[]`
- [x] **1.2** 在 `src/feishu/images.ts` 中新增 `cleanupGlobalOrphans(db, outputDir, ossConfig)` 函数。逻辑：调用 `findOrphanImages` → 对每个孤儿执行 `countImageRefs` 双重确认 → 删除本地 temp 文件 → `deleteFromOSS` 删除 OSS 文件 → `DELETE FROM images WHERE md5=?` 删除 DB 记录 → 输出清理统计

## 2. 集成到 upload 流程

- [x] **2.1** 在 `src/feishu/upload-flow.ts` 的 `runUpload()` 末尾调用 `cleanupGlobalOrphans()`，在 `closeDB()` 之前执行
- [x] **2.2** 考虑 `download-item-flow.ts` 中 `--upload-images` 路径 → 跳过（per-node diff 已覆盖单节点场景）（单节点 upload 场景，可选）

## 3. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循架构规则）
> 单元测试的标签使用中文

- [x] **3.1** `tests/feishu/images.test.ts` — 新增 `findOrphanImages` 测试：无孤儿时返回空数组、有孤儿时返回正确列表（模拟 markdown 文件和 images 表）、多文档共享图片不被误判为孤儿
- [x] **3.2** `tests/feishu/images.test.ts` — 新增 `cleanupGlobalOrphans` 测试：清理后本地文件不存在、DB 记录已删除、清理统计正确
- [x] **3.3** 运行 `bun test` 确保全部测试通过

## 4. 验证与审查

- [x] **4.1** 运行 `/code-review` skill 审查全部 diff，修复发现的问题
- [x] **4.2** 运行 `bun run build` 确保编译通过

## 5. 文档更新

- [x] **5.1** 更新 `docs/feishu/flows.md` — upload 流程图末尾增加全局孤儿扫描步骤
- [x] **5.2** 更新 `docs/feishu/business.md` — 新增全局孤儿图片清理业务规则

## 任务依赖关系

- 执行顺序：1（findOrphanImages + cleanupGlobalOrphans）→ 2（集成到 upload-flow）→ 3（单元测试）→ 4（验证审查）→ 5（文档更新）
- 依赖关系：任务 2.1 依赖 1.1、1.2 完成；任务 2.2 可选独立执行；任务 3.1 和 3.2 可并行编写
- 其他约束：`cleanupGlobalOrphans` 复用现有的 `deleteFromOSS`、`countImageRefs` 函数，不引入新的 OSS 删除逻辑。`findMdFiles` 从 `utils.ts` 导入
