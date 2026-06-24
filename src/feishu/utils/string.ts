// 字符串处理：清理文件名

export function sanitize(name: string): string {
    let s = name.replace(/[\\/:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim();
    if (s.length > 80) s = s.slice(0, 80).trim();
    return s || '_';
}
