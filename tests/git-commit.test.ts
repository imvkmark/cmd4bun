import { test, expect, describe } from 'bun:test';

// ============ 测试辅助函数（提取自 selectFiles 的纯逻辑） ============

/**
 * 构建初始选中状态：所有非暂存文件默认选中，暂存文件强制选中
 */
function buildInitialSelected(
    changes: { path: string; status: string }[],
    stagedPaths: Set<string>
): Set<string> {
    const selected = new Set(changes.map((c) => c.path));
    for (const p of stagedPaths) selected.add(p);
    return selected;
}

/**
 * 切换文件的选中/取消状态
 * @returns 新的选中 Set（不修改原 Set）
 */
function toggleSelection(
    index: number,
    changes: { path: string; status: string }[],
    selected: Set<string>,
    stagedPaths: Set<string>
): Set<string> {
    const change = changes[index];
    if (!change) return selected;
    if (stagedPaths.has(change.path)) return selected; // staged 文件不可取消
    const next = new Set(selected);
    if (next.has(change.path)) {
        next.delete(change.path);
    } else {
        next.add(change.path);
    }
    return next;
}

/**
 * 从选中状态中提取路径列表
 */
function getSelectedPaths(
    changes: { path: string; status: string }[],
    selected: Set<string>
): string[] {
    return changes.filter((c) => selected.has(c.path)).map((c) => c.path);
}

/**
 * 构建显示行（不含 ANSI 转义码用于断言）
 */
function buildPlainFileLines(
    changes: { path: string; status: string }[],
    selected: Set<string>,
    cursorIndex: number,
    stagedPaths: Set<string>
): { text: string; isCursor: boolean }[] {
    return changes.map((change, i) => {
        const isCursor = i === cursorIndex;
        const isStaged = stagedPaths.has(change.path);
        const isChecked = selected.has(change.path);

        let checkbox: string;
        if (isStaged) {
            checkbox = '[●]';
        } else {
            checkbox = isChecked ? '[✓]' : '[ ]';
        }
        return {
            text: `${checkbox} ${change.path}`,
            isCursor
        };
    });
}

// ============ 3.1 渲染输出正确 ============

describe('3.1 buildPlainFileLines - 渲染输出正确', () => {
    const changes = [
        { path: 'src/index.ts', status: 'M' },
        { path: 'README.md', status: '?' },
        { path: 'src/utils.ts', status: 'A' },
        { path: 'old.ts', status: 'D' }
    ];

    test('显示勾选框和状态图标：选中文件显示 [✓]，未选中显示 [ ]', () => {
        const selected = new Set(['src/index.ts', 'src/utils.ts', 'old.ts']);
        const stagedPaths = new Set<string>();
        const lines = buildPlainFileLines(changes, selected, 0, stagedPaths);

        expect(lines[0]!.text).toContain('[✓]');
        expect(lines[1]!.text).toContain('[ ]');
        expect(lines[2]!.text).toContain('[✓]');
        expect(lines[3]!.text).toContain('[✓]');
    });

    test('暂存文件显示 [●] 标记', () => {
        const selected = new Set(['src/index.ts', 'README.md', 'src/utils.ts', 'old.ts']);
        const stagedPaths = new Set(['src/index.ts']);
        const lines = buildPlainFileLines(changes, selected, 0, stagedPaths);

        expect(lines[0]!.text).toContain('[●]');
        expect(lines[1]!.text).toContain('[✓]');
        expect(lines[2]!.text).toContain('[✓]');
        expect(lines[3]!.text).toContain('[✓]');
    });

    test('当前光标行标记正确', () => {
        const selected = new Set(changes.map((c) => c.path));
        const stagedPaths = new Set<string>();
        const lines = buildPlainFileLines(changes, selected, 2, stagedPaths);

        expect(lines[0]!.isCursor).toBe(false);
        expect(lines[1]!.isCursor).toBe(false);
        expect(lines[2]!.isCursor).toBe(true);
        expect(lines[3]!.isCursor).toBe(false);
    });

    test('空的变更列表返回空数组', () => {
        const lines = buildPlainFileLines([], new Set(), 0, new Set());
        expect(lines).toEqual([]);
    });
});

// ============ 3.2 默认全选 ============

describe('3.2 buildInitialSelected - 默认全选', () => {
    test('初始状态所有文件已勾选', () => {
        const changes = [
            { path: 'src/index.ts', status: 'M' },
            { path: 'README.md', status: '?' },
            { path: 'src/utils.ts', status: 'A' }
        ];
        const stagedPaths = new Set<string>();
        const selected = buildInitialSelected(changes, stagedPaths);

        expect(selected.has('src/index.ts')).toBe(true);
        expect(selected.has('README.md')).toBe(true);
        expect(selected.has('src/utils.ts')).toBe(true);
        expect(selected.size).toBe(3);
    });

    test('暂存文件强制加入选中', () => {
        const changes = [
            { path: 'src/index.ts', status: 'M' },
            { path: 'README.md', status: '?' }
        ];
        // stagedPaths 中有 changes 中不存在的路径
        const stagedPaths = new Set(['src/index.ts', 'already-staged.ts']);
        const selected = buildInitialSelected(changes, stagedPaths);

        expect(selected.has('src/index.ts')).toBe(true);
        expect(selected.has('already-staged.ts')).toBe(true); // 不在 changes 中也被加入
        expect(selected.has('README.md')).toBe(true);
        expect(selected.size).toBe(3);
    });

    test('空文件列表返回空 Set', () => {
        const selected = buildInitialSelected([], new Set());
        expect(selected.size).toBe(0);
    });
});

// ============ 3.3 Space 切换 ============

describe('3.3 toggleSelection - Space 切换', () => {
    const changes = [
        { path: 'file1.ts', status: 'M' },
        { path: 'file2.ts', status: '?' },
        { path: 'file3.ts', status: 'D' }
    ];

    test('已选中文件切换为未选中', () => {
        const selected = new Set(['file1.ts', 'file2.ts', 'file3.ts']);
        const stagedPaths = new Set<string>();

        const next = toggleSelection(0, changes, selected, stagedPaths);
        expect(next.has('file1.ts')).toBe(false);
        expect(next.has('file2.ts')).toBe(true);
        expect(next.has('file3.ts')).toBe(true);
        expect(next.size).toBe(2);
    });

    test('未选中文件切换为已选中', () => {
        const selected = new Set(['file2.ts', 'file3.ts']);
        const stagedPaths = new Set<string>();

        const next = toggleSelection(0, changes, selected, stagedPaths);
        expect(next.has('file1.ts')).toBe(true);
        expect(next.has('file2.ts')).toBe(true);
        expect(next.has('file3.ts')).toBe(true);
        expect(next.size).toBe(3);
    });

    test('多次切换往返正确', () => {
        const selected = new Set(['file1.ts', 'file2.ts', 'file3.ts']);
        const stagedPaths = new Set<string>();

        const s1 = toggleSelection(0, changes, selected, stagedPaths);
        expect(s1.has('file1.ts')).toBe(false);

        const s2 = toggleSelection(0, changes, s1, stagedPaths);
        expect(s2.has('file1.ts')).toBe(true);
    });

    test('不修改原 Set（不可变）', () => {
        const selected = new Set(['file1.ts', 'file2.ts', 'file3.ts']);
        const stagedPaths = new Set<string>();

        toggleSelection(0, changes, selected, stagedPaths);
        expect(selected.has('file1.ts')).toBe(true); // 原 Set 不变
        expect(selected.size).toBe(3);
    });
});

// ============ 3.4 Enter 确认返回值 ============

describe('3.4 getSelectedPaths - Enter 确认返回值', () => {
    const changes = [
        { path: 'src/index.ts', status: 'M' },
        { path: 'README.md', status: '?' },
        { path: 'src/utils.ts', status: 'A' },
        { path: 'old.ts', status: 'D' }
    ];

    test('选中路径列表与勾选状态一致', () => {
        const selected = new Set(['src/index.ts', 'src/utils.ts']);
        const paths = getSelectedPaths(changes, selected);

        expect(paths).toEqual(['src/index.ts', 'src/utils.ts']);
        expect(paths.length).toBe(2);
    });

    test('全选时返回所有路径', () => {
        const selected = new Set(changes.map((c) => c.path));
        const paths = getSelectedPaths(changes, selected);

        expect(paths).toEqual(['src/index.ts', 'README.md', 'src/utils.ts', 'old.ts']);
        expect(paths.length).toBe(4);
    });

    test('返回顺序与 changes 顺序一致', () => {
        const selected = new Set(['old.ts', 'README.md']); // 乱序加入
        const paths = getSelectedPaths(changes, selected);

        expect(paths).toEqual(['README.md', 'old.ts']); // 按 changes 顺序返回
    });
});

// ============ 3.5 边界情况 ============

describe('3.5 边界情况', () => {
    test('空文件列表 getSelectedPaths 返回空数组', () => {
        const paths = getSelectedPaths([], new Set());
        expect(paths).toEqual([]);
    });

    test('全部取消后 getSelectedPaths 返回空数组', () => {
        const changes = [
            { path: 'file1.ts', status: 'M' },
            { path: 'file2.ts', status: '?' }
        ];
        const selected = new Set<string>(); // 全部取消
        const paths = getSelectedPaths(changes, selected);
        expect(paths).toEqual([]);
    });

    test('buildInitialSelected 空文件列表返回空 Set', () => {
        expect(buildInitialSelected([], new Set()).size).toBe(0);
    });

    test('toggleSelection 越界索引不改变状态', () => {
        const changes = [{ path: 'file1.ts', status: 'M' }];
        const selected = new Set(['file1.ts']);
        const stagedPaths = new Set<string>();

        expect(toggleSelection(-1, changes, selected, stagedPaths)).toBe(selected);
        expect(toggleSelection(5, changes, selected, stagedPaths)).toBe(selected);
    });
});

// ============ 3.6 staged 文件不可取消 ============

describe('3.6 toggleSelection - staged 文件不可取消', () => {
    const changes = [
        { path: 'src/index.ts', status: 'M' },
        { path: 'README.md', status: '?' }
    ];

    test('staged 文件切换无效', () => {
        const selected = new Set(['src/index.ts', 'README.md']);
        const stagedPaths = new Set(['src/index.ts']);

        const next = toggleSelection(0, changes, selected, stagedPaths);
        expect(next.has('src/index.ts')).toBe(true); // 仍然选中
        expect(next.size).toBe(2); // 没有变化
    });

    test('非 staged 文件正常切换', () => {
        const selected = new Set(['src/index.ts', 'README.md']);
        const stagedPaths = new Set(['src/index.ts']);

        const next = toggleSelection(1, changes, selected, stagedPaths);
        expect(next.has('README.md')).toBe(false); // 非 staged 的正常取消
        expect(next.has('src/index.ts')).toBe(true); // staged 的不变
        expect(next.size).toBe(1);
    });

    test('staged 文件与其他文件混合切换', () => {
        const changes = [
            { path: 'a.ts', status: 'M' },
            { path: 'b.ts', status: 'M' },
            { path: 'c.ts', status: '?' }
        ];
        const selected = new Set(['a.ts', 'b.ts', 'c.ts']);
        const stagedPaths = new Set(['a.ts', 'b.ts']);

        // 尝试取消 a (staged) — 无效
        const s1 = toggleSelection(0, changes, selected, stagedPaths);
        expect(s1.has('a.ts')).toBe(true);

        // 尝试取消 b (staged) — 无效
        const s2 = toggleSelection(1, changes, s1, stagedPaths);
        expect(s2.has('b.ts')).toBe(true);

        // 尝试取消 c (非 staged) — 有效
        const s3 = toggleSelection(2, changes, s2, stagedPaths);
        expect(s3.has('c.ts')).toBe(false);
        expect(s3.size).toBe(2);
    });
});

// ============ 多文件完整场景测试 ============

describe('多文件完整场景测试', () => {
    const changes = [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: '?' },
        { path: 'src/c.ts', status: 'A' },
        { path: 'src/d.ts', status: 'D' }
    ];

    test('构建初始选中状态 + 部分取消 + 提取路径', () => {
        const stagedPaths = new Set<string>();
        let selected = buildInitialSelected(changes, stagedPaths);
        expect(selected.size).toBe(4);

        // 取消 file a 和 file c
        selected = toggleSelection(0, changes, selected, stagedPaths);
        selected = toggleSelection(2, changes, selected, stagedPaths);

        const paths = getSelectedPaths(changes, selected);
        expect(paths).toEqual(['src/b.ts', 'src/d.ts']);
    });

    test('staged 文件不可取消 + 非 staged 正常取消', () => {
        const stagedPaths = new Set(['src/a.ts', 'src/b.ts']);
        let selected = buildInitialSelected(changes, stagedPaths);
        expect(selected.size).toBe(4);

        // 尝试取消 staged 文件 — 无效
        selected = toggleSelection(0, changes, selected, stagedPaths);
        selected = toggleSelection(1, changes, selected, stagedPaths);
        expect(selected.has('src/a.ts')).toBe(true);
        expect(selected.has('src/b.ts')).toBe(true);

        // 取消非 staged 文件 — 有效
        selected = toggleSelection(2, changes, selected, stagedPaths);
        selected = toggleSelection(3, changes, selected, stagedPaths);
        expect(selected.has('src/c.ts')).toBe(false);
        expect(selected.has('src/d.ts')).toBe(false);

        const paths = getSelectedPaths(changes, selected);
        expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('全部取消后 Enter 返回空数组', () => {
        const stagedPaths = new Set<string>();
        let selected = buildInitialSelected(changes, stagedPaths);

        for (let i = 0; i < changes.length; i++) {
            selected = toggleSelection(i, changes, selected, stagedPaths);
        }

        const paths = getSelectedPaths(changes, selected);
        expect(paths).toEqual([]);
    });

    test('全选后提取所有路径', () => {
        const stagedPaths = new Set<string>();
        const selected = buildInitialSelected(changes, stagedPaths);

        const paths = getSelectedPaths(changes, selected);
        expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    });

    test('渲染输出与选中状态一致', () => {
        const stagedPaths = new Set<string>();
        let selected = buildInitialSelected(changes, stagedPaths);

        // 取消文件 b
        selected = toggleSelection(1, changes, selected, stagedPaths);

        const lines = buildPlainFileLines(changes, selected, 2, stagedPaths);
        expect(lines[0]!.text).toContain('[✓]');
        expect(lines[1]!.text).toContain('[ ]'); // 已取消
        expect(lines[2]!.text).toContain('[✓]');
        expect(lines[3]!.text).toContain('[✓]');
        expect(lines[2]!.isCursor).toBe(true); // cursorIndex=2
    });
});
