-- 004: 新增 description 列，存储 DeepSeek 生成的文档摘要描述
ALTER TABLE nodes ADD COLUMN description TEXT;
