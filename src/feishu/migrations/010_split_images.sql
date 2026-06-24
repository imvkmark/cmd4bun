-- 010: 拆 images 表为 images (单 md5 主键) + image_vs_node (多对多联结表)
-- 解决 006 之后 images 中 ext/oss_url/uploaded 仍按 (md5, node_token) 复制，
-- 导致同一图片被多节点引用时数据冗余、oss_url 不一致的问题。
--
-- 执行前由迁移执行器通过 PRAGMA table_info(images) 检查 image_vs_node
-- 表是否存在；若已存在（新 schema），自动跳过本迁移。

CREATE TABLE IF NOT EXISTS images_new (
  md5        TEXT PRIMARY KEY,
  ext        TEXT NOT NULL,
  oss_url    TEXT,
  uploaded   INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS image_vs_node (
  md5        TEXT NOT NULL,
  node_token TEXT NOT NULL,
  PRIMARY KEY (md5, node_token)
);

-- 迁移 images 主体：按 md5 去重，ext/created_at 取最早一行，
-- oss_url 优先保留非 NULL 的（说明该图至少被成功上传过），
-- uploaded 取 MAX（只要任一节点对应行标记为已上传即视为已上传）。
INSERT INTO images_new (md5, ext, oss_url, uploaded, created_at)
SELECT
  md5,
  ext,
  (SELECT oss_url FROM images i2
     WHERE i2.md5 = images.md5 AND i2.oss_url IS NOT NULL
     ORDER BY i2.rowid LIMIT 1) AS oss_url,
  MAX(uploaded) AS uploaded,
  MIN(created_at) AS created_at
FROM images
GROUP BY md5;

-- 迁移多对多引用：所有 (md5, node_token) 对进联结表
INSERT OR IGNORE INTO image_vs_node (md5, node_token)
SELECT md5, node_token FROM images;

DROP TABLE images;

ALTER TABLE images_new RENAME TO images;

-- 通过 node_token 反查引用时需要的索引
CREATE INDEX IF NOT EXISTS idx_image_vs_node_node
  ON image_vs_node(node_token);
