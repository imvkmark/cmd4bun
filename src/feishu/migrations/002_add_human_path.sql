-- 002: 新增 human_path 列，存储从 YAML frontmatter slug 解析的人类可读路径
ALTER TABLE nodes ADD COLUMN human_path TEXT;
