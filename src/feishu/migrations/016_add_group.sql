-- 016: 新增 group 列。
-- 下载管线在解析 YAML group 字段时覆盖写,默认 'default' 与存量"未分组"语义对齐,无需回填。
-- 复制文档阶段按 group 分发到各自 feishu.{group}.aimDirectory。
-- group 是 SQLite 保留字，必须双引号转义作为标识符（与 db.ts:181 / copy-docs-flow.ts 一致）
ALTER TABLE nodes ADD COLUMN "group" TEXT NOT NULL DEFAULT 'default';