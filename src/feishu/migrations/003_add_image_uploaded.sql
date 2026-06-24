-- 003: 新增 image_uploaded 列，标记文档图片是否已上传到 OSS
ALTER TABLE nodes ADD COLUMN image_uploaded INTEGER DEFAULT 0;
