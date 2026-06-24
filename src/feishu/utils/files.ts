// 文件遍历：递归查找 .md 文件、清理空目录
// 注意：images / data 子目录被排除，避免把数据目录里的文件当文档

import { existsSync, readdirSync, statSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

export function findMdFiles(dir: string): string[] {
    const result: string[] = [];
    if (!existsSync(dir)) return result;

    try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
            const full = join(dir, entry);
            try {
                const stat = statSync(full);
                if (stat.isDirectory()) {
                    if (entry === 'images' || entry === 'data') continue;
                    result.push(...findMdFiles(full));
                } else if (entry.endsWith('.md')) {
                    result.push(full);
                }
            } catch {
                // ignore
            }
        }
    } catch {
    // ignore
    }

    return result;
}

export function cleanupEmptyDirs(dir: string) {
    if (!existsSync(dir)) return;

    try {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            try {
                if (statSync(full).isDirectory()) {
                    cleanupEmptyDirs(full);
                }
            } catch {
                // ignore
            }
        }

        if (readdirSync(dir).length === 0) {
            rmdirSync(dir);
        }
    } catch {
    // ignore
    }
}
