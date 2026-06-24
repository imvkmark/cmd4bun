-- 014: 删除 downloaded 列。下载状态已统一通过 downloaded_at 与 updated_at 的时间比较判断，downloaded 不再需要
ALTER TABLE nodes DROP COLUMN downloaded;