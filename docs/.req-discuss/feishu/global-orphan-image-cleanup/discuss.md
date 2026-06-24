# upload 完成后全局孤儿图片清理 需求变更讨论

## 需求背景

当前图片清理机制是"事件驱动"的：仅在单节点图片 diff（`processImagesInFile` 末尾）、知识库删除（sync Phase 1）、节点文件清理（sync Phase 2）时触发。缺少一个全局扫描机制来回答："images 表中是否还有记录，但其对应的图片已不被任何 markdown 文件引用？"

例如：文档内容变更（图片被替换）但只走了 download 没走 upload，per-node diff 没触发，旧图片残留在 DB 和 OSS。

## 讨论后的关键结论

- 在 `upload` 全部完成后，新增全局孤儿图片扫描步骤
- 遍历所有 markdown 文件提取引用的图片 MD5 集合，与 `images` 表对比找出孤儿
- 清理孤儿：本地文件 + OSS 文件 + DB 记录
- 文档删除时的图片清理：当前 sync-flow 已有处理，确认无需改动

## 需求目标

upload 完成后，全局扫描所有已下载的 markdown 文件，发现并清理 images 表中已不被任何文档引用的孤儿图片（本地 temp 文件 + OSS 文件 + DB 记录）。

**边界**：不修改 per-node diff 逻辑；不修改 sync 阶段的图片清理；不影响图片上传主流程。

## 当前流程

```
runUpload:
  for each node in uploadQueue:
    processImagesInFile(filePath, ...)
      ├── 下载图片 → MD5 去重 → OSS 上传 → URL 替换
      └── per-node diff: 旧图片 - 新图片 → cleanupOrphanImages
    markNodeImageUploaded(node)
  → 输出统计 → 结束
  
  (无全局孤儿扫描)
```

参考：
- `docs/feishu/overview.md`
- `docs/feishu/flows.md`
- `docs/feishu/business.md`

## 影响分析

### 1. images.ts

- 新增 `findOrphanImages(db, outputDir)`：扫描 markdown 文件提取引用 MD5 集合 → 查询 images 表 → 返回孤儿 `{md5, ext}[]`
- 新增 `cleanupGlobalOrphans(db, outputDir, ossConfig)`：批量清理孤儿图片

### 2. upload-flow.ts

- `runUpload()` 末尾调用 `cleanupGlobalOrphans()`

### 3. 级联副作用

- 无。仅在 upload 末尾追加步骤，不改变现有流程

### 4. 数据一致性与过渡

- 通过 `countImageRefs` 双重确认无引用后才删除
- 存量 images 记录如果对应 markdown 无引用，首次全局扫描时一并清理
- OSS 删除依赖 `ossConfig` 可用，不可用时仅清理本地 + DB

### 5. 性能风险

- 遍历所有 markdown 文件提取图片 URL，文档量大时耗时在秒级
- upload 是一次性操作，非热点路径，可接受

## 推荐方案

upload 末尾调用 `cleanupGlobalOrphans()` 进行全局孤儿扫描和清理。

### 实施建议

1. `images.ts` 新增 `findOrphanImages()` 和 `cleanupGlobalOrphans()`
2. `upload-flow.ts` `runUpload()` 末尾调用
3. `download-item-flow.ts` 中 `--upload-images` 路径可选追加（单节点 upload 后也可清理全局孤儿）
4. 更新 `docs/feishu/flows.md` 和 `docs/feishu/business.md`

## 结论

在 upload 管道末尾增加一个"全局孤儿图片清理"步骤，填补事件驱动清理的盲区。改动范围小、零外部依赖、风险低。
