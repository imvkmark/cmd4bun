// 时间格式化：Unix 时间戳 / ISO 8601 → "YYYY-MM-DD HH:mm:ss"

/** 把 Date 格式化为本地时间 "YYYY-MM-DD HH:mm:ss"。 */
function formatYmdHms(d: Date): string {
    const y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${M}-${D} ${h}:${m}:${s}`;
}

/**
 * 将 Unix 时间戳字符串转换为本地时间 "YYYY-MM-DD HH:mm:ss" 格式。
 * 传入空字符串或非法格式时返回空字符串。
 */
export function toDatetime(ts: string): string {
    if (!ts) return '';
    const ms = Number(ts);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    // 飞书时间戳单位为秒，转为毫秒
    const d = new Date(ms * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return formatYmdHms(d);
}

/**
 * 将 ISO 8601 时间字符串（如 "2026-04-07T14:31:49Z"）转换为 "YYYY-MM-DD HH:mm:ss" 格式。
 * 传入空字符串或非法格式时返回空字符串。
 */
export function formatUpdatedAt(iso8601: string): string {
    if (!iso8601) return '';
    const d = new Date(iso8601);
    if (Number.isNaN(d.getTime())) return '';
    return formatYmdHms(d);
}
