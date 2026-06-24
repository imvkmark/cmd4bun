import { test, expect, beforeEach, afterEach } from 'bun:test';
import { parseArgs } from '../src/feishu';
import type { SyncArgs, DownloadArgs } from '../src/feishu';

let savedArgv: string[];

beforeEach(() => {
    savedArgv = [...process.argv];
});

afterEach(() => {
    process.argv = savedArgv;
});

function setArgv(args: string[]) {
    process.argv = ['bun', 'feishu.ts', ...args];
}

test('解析默认命令为 help', () => {
    setArgv([]);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('help');
});

test('解析 sync 的输出目录和知识库过滤', () => {
    setArgv(['sync', '--output', '/custom/path', '--space', 'space-1', '-s', 'space-2']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync');
    expect(result.args.output).toBe('/custom/path');
    expect((result.args as SyncArgs).spaces).toEqual(['space-1', 'space-2']);
});

test('解析 download 的强制下载并发参数', () => {
    setArgv(['download', '--force', '--concurrency', '8', '--space', 'space-1']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
    expect((result.args as DownloadArgs).force).toBe(true);
    expect((result.args as DownloadArgs).concurrency).toBe(8);
    expect((result.args as SyncArgs).spaces).toEqual(['space-1']);
});

test('解析 download 并发下限', () => {
    setArgv(['download', '--concurrency', '0']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
    expect((result.args as DownloadArgs).concurrency).toBe(1);
});

test('解析 --help 为 help 命令', () => {
    setArgv(['--help']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('help');
});

test('未知参数会以非零退出', () => {
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = (code?: number) => {
        exitCode = code;
        throw new Error('exit');
    };

    setArgv(['--unknown']);
    try {
        parseArgs('./docs/feishu');
    } catch (e: unknown) {
        expect((e as Error).message).toBe('exit');
    }
    expect(exitCode).toBe(1);

    process.exit = origExit;
});

// ============ 6.5 命令重命名解析测试 — 新命令名 ============

test('6.5 解析 sync 子命令', () => {
    setArgv(['sync']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync');
});

test('6.5 解析 download 子命令', () => {
    setArgv(['download']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
});

test('6.5 download-item 已移除，不再识别为有效子命令', () => {
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = (code?: number) => {
        exitCode = code;
        throw new Error('exit');
    };

    setArgv(['download-item', 'node-token-123']);
    try {
        parseArgs('./docs/feishu');
    } catch (e: unknown) {
        expect((e as Error).message).toBe('exit');
    }
    expect(exitCode).toBe(1);

    process.exit = origExit;
});

test('6.5 旧命令 index 不再识别为有效子命令', () => {
    setArgv(['index']);
    // 由于 index 不在有效命令列表中，它会被当作未知参数对待
    // parseArgs 在遇到未知参数时调用 printHelp + process.exit(1)
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = (code?: number) => {
        exitCode = code;
        throw new Error('exit');
    };

    setArgv(['index']);
    try {
        parseArgs('./docs/feishu');
    } catch (e: unknown) {
        expect((e as Error).message).toBe('exit');
    }
    expect(exitCode).toBe(1);

    process.exit = origExit;
});

test('6.5 旧命令 image-sync 不再识别为有效子命令', () => {
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = (code?: number) => {
        exitCode = code;
        throw new Error('exit');
    };

    setArgv(['image-sync']);
    try {
        parseArgs('./docs/feishu');
    } catch (e: unknown) {
        expect((e as Error).message).toBe('exit');
    }
    expect(exitCode).toBe(1);

    process.exit = origExit;
});

// ============ 6.6 download --node-token 参数解析测试 ============

test('6.6 download --node-token 自动开启 force', () => {
    setArgv(['download', '--node-token', 'token-abc']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
    expect((result.args as DownloadArgs).nodeToken).toBe('token-abc');
    expect((result.args as DownloadArgs).force).toBe(true);
});

test('6.6 download --node-token 简写 -n', () => {
    setArgv(['download', '-n', 'token-short']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
    expect((result.args as DownloadArgs).nodeToken).toBe('token-short');
    expect((result.args as DownloadArgs).force).toBe(true);
});

test('6.6 download --node-token 与 --concurrency 组合', () => {
    setArgv(['download', '--node-token', 'token-456', '--concurrency', '2']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
    expect((result.args as DownloadArgs).nodeToken).toBe('token-456');
    expect((result.args as DownloadArgs).concurrency).toBe(2);
});

// ============ 自动图片处理: upload 子命令与 --upload-images flag 移除 ============

test('自动图片处理: upload 子命令已废弃，不再识别为有效命令', () => {
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = (code?: number) => {
        exitCode = code;
        throw new Error('exit');
    };

    setArgv(['upload']);
    try {
        parseArgs('./docs/feishu');
    } catch (e: unknown) {
        expect((e as Error).message).toBe('exit');
    }
    expect(exitCode).toBe(1);

    process.exit = origExit;
});

test('自动图片处理: --upload-images flag 已废弃，不再识别为有效参数', () => {
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = (code?: number) => {
        exitCode = code;
        throw new Error('exit');
    };

    setArgv(['download', '--upload-images']);
    try {
        parseArgs('./docs/feishu');
    } catch (e: unknown) {
        expect((e as Error).message).toBe('exit');
    }
    expect(exitCode).toBe(1);

    process.exit = origExit;
});

test('自动图片处理: download 命令不包含 uploadImages 字段', () => {
    setArgv(['download']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
    const args = result.args as DownloadArgs;
    expect('uploadImages' in args).toBe(false);
});
