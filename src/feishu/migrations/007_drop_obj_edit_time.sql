-- 007: 删除已废弃的 obj_edit_time 列，该字段已被 updated_at 完全替代
ALTER TABLE nodes DROP COLUMN obj_edit_time;
