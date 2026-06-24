-- 009: 新增 scanned_at 列，记录节点最近一次在索引扫描中被发现的时间（sync 阶段写入）
ALTER TABLE nodes ADD COLUMN scanned_at TEXT;
