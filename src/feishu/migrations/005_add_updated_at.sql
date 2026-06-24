-- 005: 新增 updated_at 列，存储文档远端编辑时间 (ISO 8601)，取代 obj_edit_time
ALTER TABLE nodes ADD COLUMN updated_at TEXT;
