-- 006: 重建 images 表主键为复合键 (md5, node_token)
-- 解决旧 schema 中 md5 作为单主键无法支持同一图片被多个节点引用的问题
--
-- 执行前由迁移执行器通过 PRAGMA table_info(images) 检查 node_token 列是否存在；
-- 若已存在（新 schema），自动跳过本迁移。

CREATE TABLE IF NOT EXISTS images_new (
  md5        TEXT NOT NULL,
  node_token TEXT NOT NULL,
  ext        TEXT NOT NULL,
  oss_url    TEXT,
  uploaded   INTEGER DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY (md5, node_token)
);

INSERT INTO images_new (md5, node_token, ext, oss_url, uploaded, created_at)
SELECT md5, '__legacy__', ext, oss_url, uploaded, created_at FROM images;

DROP TABLE images;

ALTER TABLE images_new RENAME TO images;
