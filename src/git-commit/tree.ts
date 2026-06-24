// 文件树构建与渲染，从 git 状态生成终端树形视图

import { execSync } from 'child_process';
import { C } from '../shared/colors';

// ============ Types ============

interface FileNode {
    name: string;
    isDir: boolean;
    children: Record<string, FileNode>;
    status?: string;
}

interface StatusStyle {
    icon: string;
    badge: string;
    color: string;
    summaryFn: (n: number) => string;
}

export const STATUS_STYLES: Record<string, StatusStyle> = {
    A: {
        icon: `${C.green}+${C.reset}`,
        badge: `${C.dim}[+]${C.reset}`,
        color: C.green,
        summaryFn: (n) => `${C.green}+${n} added${C.reset}`
    },
    M: {
        icon: `${C.yellow}●${C.reset}`,
        badge: `${C.dim}[m]${C.reset}`,
        color: C.yellow,
        summaryFn: (n) => `${C.yellow}●${n} modified${C.reset}`
    },
    D: {
        icon: `${C.red}x${C.reset}`,
        badge: `${C.dim}[-]${C.reset}`,
        color: C.red,
        summaryFn: (n) => `${C.red}x${n} deleted${C.reset}`
    },
    R: {
        icon: `${C.cyan}→${C.reset}`,
        badge: `${C.dim}[→]${C.reset}`,
        color: C.cyan,
        summaryFn: (n) => `${C.cyan}→${n} renamed${C.reset}`
    },
    C: {
        icon: `${C.cyan}⎘${C.reset}`,
        badge: `${C.dim}[c]${C.reset}`,
        color: C.cyan,
        summaryFn: (n) => `${C.cyan}⎘${n} copied${C.reset}`
    },
    '?': {
        icon: `${C.magenta}?${C.reset}`,
        badge: `${C.dim}[?]${C.reset}`,
        color: C.magenta,
        summaryFn: (n) => `${C.magenta}?${n} untracked${C.reset}`
    },
    '!': {
        icon: `${C.gray}!${C.reset}`,
        badge: `${C.dim}[!]${C.reset}`,
        color: C.gray,
        summaryFn: (n) => `${C.gray}!${n} ignored${C.reset}`
    }
};

// ============ Git 变更收集 ============

export function getFileChanges(): { path: string; status: string }[] {
    const results: { path: string; status: string }[] = [];
    const seenPaths = new Set<string>();

    // 已暂存的变更
    try {
        const staged = execSync('git diff --cached --name-status', { encoding: 'utf-8' }).trim();
        if (staged) {
            for (const line of staged.split('\n')) {
                if (!line) continue;
                const parts = line.split('\t');
                const status = parts[0]?.charAt(0);
                const path = parts[parts.length - 1];
                if (status && path) {
                    results.push({ status, path });
                    seenPaths.add(path);
                }
            }
        }
    } catch { /* ignore */ }

    // 未暂存的变更
    try {
        const unstaged = execSync('git diff --name-status', { encoding: 'utf-8' }).trim();
        if (unstaged) {
            for (const line of unstaged.split('\n')) {
                if (!line) continue;
                const parts = line.split('\t');
                const status = parts[0]?.charAt(0);
                const path = parts[parts.length - 1];
                if (status && path && !seenPaths.has(path)) {
                    results.push({ status, path });
                    seenPaths.add(path);
                }
            }
        }
    } catch { /* ignore */ }

    // 未跟踪的文件
    try {
        const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf-8' }).trim();
        if (untracked) {
            for (const path of untracked.split('\n')) {
                if (!path) continue;
                if (!seenPaths.has(path)) {
                    results.push({ status: '?', path });
                    seenPaths.add(path);
                }
            }
        }
    } catch { /* ignore */ }

    return results;
}

// ============ 树构建 ============

export function buildTree(files: { path: string; status: string }[]): FileNode {
    const root: FileNode = { name: '', isDir: true, children: {} };

    for (const file of files) {
        const parts = file.path.split('/');
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i] ?? '';
            if (!part) continue;
            if (!(part in current.children)) {
                current.children[part] = {
                    name: part,
                    isDir: i < parts.length - 1,
                    children: {},
                    status: i === parts.length - 1 ? file.status : undefined
                };
            }
            current = current.children[part] ?? current;
        }
    }

    return root;
}

function sortChildren(children: Record<string, FileNode>): FileNode[] {
    return Object.values(children).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

// ============ 渲染辅助 ============

function stripAnsi(s: string): number {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function findMaxNameLen(node: FileNode): number {
    let max = node.name.length;
    for (const child of Object.values(node.children)) {
        max = Math.max(max, findMaxNameLen(child));
    }
    return max;
}

function findMaxBadgeLen(node: FileNode): number {
    let max = 0;
    if (node.status) {
        const style = STATUS_STYLES[node.status];
        if (style) max = Math.max(max, stripAnsi(style.badge));
    }
    for (const child of Object.values(node.children)) {
        max = Math.max(max, findMaxBadgeLen(child));
    }
    return max;
}

function printTreeNode(node: FileNode, prefix: string, isLast: boolean, _maxNameLen: number, maxBadgeLen: number) {
    const connector = isLast ? '└── ' : '├── ';
    const newPrefix = prefix + (isLast ? '    ' : '│   ');
    const badgeColWidth = maxBadgeLen + 1;

    if (node.isDir) {
        const pad = ' '.repeat(badgeColWidth);
        console.log(`${pad}${C.gray}${prefix}${connector}${C.bold}${node.name}/${C.reset}`);
    } else {
        const style = STATUS_STYLES[node.status ?? 'A'] ?? STATUS_STYLES.A!;
        const badgeLen = stripAnsi(style.badge);
        const badgePad = ' '.repeat(Math.max(0, maxBadgeLen - badgeLen) + 1);
        console.log(`${style.badge}${badgePad}${C.gray}${prefix}${connector}${C.reset}${style.color}${node.name}${C.reset}`);
    }

    const children = sortChildren(node.children);
    children.forEach((child, i) => {
        printTreeNode(child, newPrefix, i === children.length - 1, _maxNameLen, maxBadgeLen);
    });
}

// ============ 入口 ============

export function printFileTree(): { hasChanges: boolean; fileCount: number; changes: { path: string; status: string }[] } {
    const changes = getFileChanges();

    if (changes.length === 0) {
        console.log(`\n  ${C.dim}No changes to commit${C.reset}\n`);
        return { hasChanges: false, fileCount: 0, changes: [] };
    }

    // 统计各状态数量
    const stats: Record<string, number> = {};
    for (const change of changes) {
        stats[change.status] = (stats[change.status] ?? 0) + 1;
    }

    // 头部：Changes to commit
    console.log(`\n  ${C.bold}Changes to commit${C.reset} ${C.dim}(${changes.length} files)${C.reset}\n`);

    // 统计摘要行
    const statParts: string[] = [];
    for (const [status, count] of Object.entries(stats)) {
        const style = STATUS_STYLES[status];
        if (style) {
            statParts.push(`  ${style.summaryFn(count)}`);
        }
    }
    console.log(statParts.join(`  ${C.dim}│${C.reset}  `));
    console.log();

    // 打印树形结构
    const tree = buildTree(changes);
    const maxNameLen = findMaxNameLen(tree);
    const maxBadgeLen = findMaxBadgeLen(tree);
    const children = sortChildren(tree.children);
    children.forEach((child, i) => {
        printTreeNode(child, '  ', i === children.length - 1, maxNameLen, maxBadgeLen);
    });
    console.log();

    return { hasChanges: true, fileCount: changes.length, changes };
}
