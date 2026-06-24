-- 015: 新增 is_ignore 列。
-- 下载管线在解析 YAML ignore: Y 时覆盖写 0/1，copydocs 阶段过滤掉非零行。
-- 默认值 0 与存量数据"未忽略"语义对齐，无需回填。
ALTER TABLE nodes ADD COLUMN is_ignore INTEGER NOT NULL DEFAULT 0;