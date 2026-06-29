// Git diff 获取：拆成可独立测试的纯函数

import { execSync } from 'child_process';

// ============ Staged diff ============

/**
 * 获取已暂存（staged）的 diff 内容。
 *
 * 纯函数：失败时返回空字符串，便于测试和组合。
 * 不会触发 process.exit。
 */
export function getStagedDiff(): string {
    try {
        return execSync('git diff --cached', { encoding: 'utf-8' }).trim();
    } catch {
        return '';
    }
}

// ============ Working tree diff ============

/**
 * 获取未暂存（working tree）的 diff 内容。
 *
 * 纯函数：失败时返回空字符串，便于测试和组合。
 * 不会触发 process.exit。
 */
export function getWorkingTreeDiff(): string {
    try {
        return execSync('git diff', { encoding: 'utf-8' }).trim();
    } catch {
        return '';
    }
}
