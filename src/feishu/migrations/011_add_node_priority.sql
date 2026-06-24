-- 011: 新增 priority 字段，记录被未就绪被引方引用次数
-- 单调累加，默认 0；下载阶段 callback 在被引方存在但 human_path 为空时 +1
ALTER TABLE nodes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
