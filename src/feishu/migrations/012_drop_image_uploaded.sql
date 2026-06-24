-- 012: 删除 image_uploaded 列。downloaded_at 已升级为"下载 + 图片处理完毕"的统一标记,image_uploaded 不再需要
ALTER TABLE nodes DROP COLUMN image_uploaded;
