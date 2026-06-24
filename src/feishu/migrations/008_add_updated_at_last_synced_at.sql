-- 008: 新增 updated_at_last_synced_at 列，记录上次同步节点 updated_at 的时间，配合 sync-updated-at --max-age 实现增量同步
ALTER TABLE nodes ADD COLUMN updated_at_last_synced_at TEXT;
