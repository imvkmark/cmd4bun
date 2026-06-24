// 终端交互选择器，文件多选和操作菜单

import { execSync } from 'child_process';
import { C } from '../shared/colors';
import { STATUS_STYLES } from './tree';

// ============ 暂存路径 ============

export function getStagedPaths(): Set<string> {
    try {
        const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8' }).trim();
        return new Set(staged ? staged.split('\n') : []);
    } catch {
        return new Set();
    }
}

// ============ 文件多选 ============

export async function selectFiles(
    changes: { path: string; status: string }[]
): Promise<string[]> {
    const stagedPaths = getStagedPaths();

    // 初始时所有非暂存文件都被选中
    const selected = new Set(changes.map((c) => c.path));

    // 暂存文件始终选中且不可取消
    for (const p of stagedPaths) selected.add(p);

    let cursorIndex = 0;
    const visibleLines = changes.length;

    return new Promise((resolve) => {
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();

        function visibleStart(): number {
            const rows = process.stdout.rows;
            const maxVisible = rows - 5;
            if (visibleLines <= maxVisible) return 0;
            if (cursorIndex < 0) return 0;
            const half = Math.floor(maxVisible / 2);
            return Math.max(0, Math.min(cursorIndex - half, visibleLines - maxVisible));
        }

        function render() {
            const start = visibleStart();
            const rows = process.stdout.rows;
            const maxVisible = rows - 5;
            const end = Math.min(start + maxVisible, visibleLines);

            process.stdout.write('\x1b[?25l');
            process.stdout.write('\x1b[H\x1b[2J');

            const selectedCount = changes.filter((c) => selected.has(c.path)).length;
            const stagedCount = changes.filter((c) => stagedPaths.has(c.path)).length;
            const header = `${C.bold}Select files to commit${C.reset} ${C.dim}(${selectedCount}/${changes.length} files selected, ${stagedCount} staged)${C.reset}`;
            process.stdout.write(`\n  ${header}\n\n`);

            for (let i = start; i < end; i++) {
                const change = changes[i]!;
                const isCursor = i === cursorIndex;
                const isStaged = stagedPaths.has(change.path);
                const isChecked = selected.has(change.path);

                const cursorMark = isCursor ? `${C.bold}${C.cyan}>${C.reset} ` : '  ';

                let checkbox: string;
                if (isStaged) {
                    checkbox = `${C.dim}[●]${C.reset}`;
                } else {
                    checkbox = isChecked
                        ? `${C.green}[✓]${C.reset}`
                        : `${C.dim}[ ]${C.reset}`;
                }

                const style = STATUS_STYLES[change.status] ?? STATUS_STYLES['?']!;
                const icon = style.icon;
                const pathColor = isStaged ? C.dim : (isChecked ? C.reset : C.dim);
                const line = `${cursorMark}${checkbox} ${icon} ${pathColor}${change.path}${C.reset}`;

                if (isCursor) {
                    process.stdout.write(`  ${C.reverse}${line}${C.reset}\n`);
                } else {
                    process.stdout.write(`  ${line}\n`);
                }
            }

            process.stdout.write(`\n  ${C.dim}↑↓: navigate  Space: toggle  Enter: confirm  Esc/Ctrl+C: cancel${C.reset}`);
            process.stdout.write('\x1b[?25h');
        }

        render();

        const onData = (buf: Buffer) => {
            const first = buf.readUInt8(0);

            // Ctrl+C (0x03) → 取消
            if (first === 0x03) {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                console.log('\n');
                resolve([]);
                return;
            }

            // ESC (0x1b, length 1) → 取消
            if (first === 0x1b && buf.length === 1) {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                console.log('\n');
                resolve([]);
                return;
            }

            // 方向键序列: ESC [ A/B
            if (first === 0x1b && buf.length >= 3 && buf.readUInt8(1) === 0x5b) {
                const dir = buf.readUInt8(2);
                if (dir === 0x41) {
                    // Up
                    cursorIndex = (cursorIndex - 1 + changes.length) % changes.length;
                    render();
                    return;
                }
                if (dir === 0x42) {
                    // Down
                    cursorIndex = (cursorIndex + 1) % changes.length;
                    render();
                    return;
                }
                return;
            }

            // Space (0x20) → 切换选中
            if (first === 0x20) {
                const change = changes[cursorIndex]!;
                const isStaged = stagedPaths.has(change.path);
                if (!isStaged) {
                    if (selected.has(change.path)) {
                        selected.delete(change.path);
                    } else {
                        selected.add(change.path);
                    }
                }
                render();
                return;
            }

            // Enter (0x0d or 0x0a) → 确认
            if (first === 0x0d || first === 0x0a) {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                console.log('\n');
                resolve(changes.filter((c) => selected.has(c.path)).map((c) => c.path));
                return;
            }
        };

        stdin.on('data', onData);
    });
}

// ============ 操作菜单 ============

interface ActionOption {
    key: string;
    label: string;
    color: string;
}

export async function selectAction(options: ActionOption[]): Promise<string> {
    let selectedIndex = 0;
    let skipNextNewline = false;

    return new Promise((resolve) => {
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();

        function render() {
            process.stdout.write('\r\x1b[K  ');

            const parts = options.map((opt, i) => {
                const isSelected = i === selectedIndex;
                const indicator = isSelected ? '●' : '○';
                const label = isSelected
                    ? `${C.bold}${opt.color}${indicator} ${opt.label}${C.reset}`
                    : `${C.dim}${indicator} ${opt.label}${C.reset}`;
                return label;
            });

            process.stdout.write(parts.join(`  ${C.dim}│${C.reset}  `));
        }

        render();

        const onData = (buf: Buffer) => {
            const first = buf.readUInt8(0);

            // 跳过 Enter (\r\n) 后的残留 \n
            if (skipNextNewline && first === 0x0a) {
                skipNextNewline = false;
                return;
            }
            skipNextNewline = false;

            // Ctrl+C (0x03) → 退出
            if (first === 0x03) {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                console.log(`\n  ${C.dim}Cancelled${C.reset}`);
                process.exit(0);
            }

            // ESC (0x1b) → 退出
            if (first === 0x1b && buf.length === 1) {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                console.log(`\n  ${C.dim}Cancelled${C.reset}`);
                process.exit(0);
            }

            // 方向键序列: ESC [ A/B/C/D
            if (first === 0x1b && buf.length >= 3 && buf.readUInt8(1) === 0x5b) {
                const dir = buf.readUInt8(2);
                if (dir === 0x42) { // Down
                    selectedIndex = (selectedIndex + 1) % options.length;
                    render();
                    return;
                }
                if (dir === 0x41) { // Up
                    selectedIndex = (selectedIndex - 1 + options.length) % options.length;
                    render();
                    return;
                }
                if (dir === 0x43) { // Right
                    selectedIndex = (selectedIndex + 1) % options.length;
                    render();
                    return;
                }
                if (dir === 0x44) { // Left
                    selectedIndex = (selectedIndex - 1 + options.length) % options.length;
                    render();
                    return;
                }
            }

            // Enter (0x0d or 0x0a)
            if (first === 0x0d || first === 0x0a) {
                stdin.removeListener('data', onData);
                skipNextNewline = (first === 0x0d);
                console.log();
                resolve(options[selectedIndex]!.key);
                return;
            }

            // 直接按键
            const ch = buf.toString().toLowerCase();
            const matchIndex = options.findIndex(o => o.key === ch);
            if (matchIndex >= 0) {
                selectedIndex = matchIndex;
                render();
                return;
            }
        };

        stdin.on('data', onData);
    });
}
