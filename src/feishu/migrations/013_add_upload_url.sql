-- 013: 新增 upload_url 列，保存非 doc/docx 类型（如 pdf）上传到 OSS 后的公网地址
ALTER TABLE nodes ADD COLUMN upload_url TEXT;
