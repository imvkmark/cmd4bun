-- 001: 初始化核心表结构 (spaces, nodes, images)
-- 每个语句均使用 IF NOT EXISTS 保证幂等执行

CREATE TABLE IF NOT EXISTS spaces (
  space_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  node_token        TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  obj_token         TEXT NOT NULL,
  obj_type          TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  obj_edit_time     TEXT,
  parent_node_token TEXT,
  downloaded_at     TEXT
);

CREATE TABLE IF NOT EXISTS images (
  md5        TEXT NOT NULL,
  node_token TEXT NOT NULL,
  ext        TEXT NOT NULL,
  oss_url    TEXT,
  uploaded   INTEGER DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY (md5, node_token)
);
