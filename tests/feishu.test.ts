import { test, expect, beforeEach, afterEach } from 'bun:test';
import { parseArgs, sanitize, xmlToReadable } from '../src/feishu';
import type { SyncArgs, DownloadArgs, SyncUpdatedAtArgs } from '../src/feishu';

// ============ Helpers ============

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

// ============ 6.1 解析 cmd.feishu 子命令测试 ============

test('6.1 parseArgs 解析 sync 子命令', () => {
    setArgv(['sync']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync');
});

test('6.1 parseArgs 解析 download 子命令', () => {
    setArgv(['download']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
});

test('6.1 parseArgs 默认显示 help', () => {
    setArgv([]);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('help');
});

test('6.1 parseArgs --help 显示 help', () => {
    setArgv(['--help']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('help');
});

test('6.1 parseArgs sync --space 解析正确', () => {
    setArgv(['sync', '--space', 'space123']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync');
    expect((result.args as SyncArgs).spaces).toEqual(['space123']);
});

test('6.1 parseArgs download 参数解析正确', () => {
    setArgv(['download', '--force', '--concurrency', '8']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('download');
    expect((result.args as DownloadArgs).force).toBe(true);
    expect((result.args as DownloadArgs).concurrency).toBe(8);
});

test('6.1 parseArgs --output / -o 通用参数解析正确', () => {
    setArgv(['sync', '--output', '/custom/path']);
    const result = parseArgs('./docs/feishu');
    expect(result.args.output).toBe('/custom/path');
});

// ============ 工具函数测试 ============

test('sanitize 移除非法文件名字符', () => {
    expect(sanitize('hello/world')).toBe('hello_world');
    expect(sanitize('test:file')).toBe('test_file');
    expect(sanitize('a?b"c')).toBe('a_b_c');
});

test('xmlToReadable 转换标题标签', () => {
    const xml = '<heading1>Title</heading1>';
    const result = xmlToReadable(xml);
    expect(result).toBe('# Title');
});

// ============ init-db 命令 ============

test('parseArgs 解析 init-db 子命令', () => {
    setArgv(['init-db']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('init-db');
});

// ============ sync-updated-at 命令 ============

test('parseArgs 解析 sync-updated-at 子命令', () => {
    setArgv(['sync-updated-at']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync-updated-at');
});

test('parseArgs sync-updated-at --space 多次指定', () => {
    setArgv(['sync-updated-at', '--space', 'space1', '--space', 'space2']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync-updated-at');
    expect((result.args as SyncArgs).spaces).toEqual(['space1', 'space2']);
});

test('parseArgs sync-updated-at --space 简写 -s', () => {
    setArgv(['sync-updated-at', '-s', 'space1', '-s', 'space2']);
    const result = parseArgs('./docs/feishu');
    expect((result.args as SyncArgs).spaces).toEqual(['space1', 'space2']);
});

test('parseArgs sync-updated-at --node-token 单节点', () => {
    setArgv(['sync-updated-at', '--node-token', 'abc123']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync-updated-at');
    expect((result.args as SyncUpdatedAtArgs).nodeToken).toBe('abc123');
});

test('parseArgs sync-updated-at --node-token 简写 -n', () => {
    setArgv(['sync-updated-at', '-n', 'abc123']);
    const result = parseArgs('./docs/feishu');
    expect((result.args as SyncUpdatedAtArgs).nodeToken).toBe('abc123');
});

test('parseArgs sync-updated-at 组合 --space 和 --node-token', () => {
    setArgv(['sync-updated-at', '--space', 's1', '--node-token', 'n1']);
    const result = parseArgs('./docs/feishu');
    expect(result.command).toBe('sync-updated-at');
    expect((result.args as SyncArgs).spaces).toEqual(['s1']);
    expect((result.args as SyncUpdatedAtArgs).nodeToken).toBe('n1');
});

test('xmlToReadable 转换列表项', () => {
    const xml = '<list_item>Item 1</list_item><list_item>Item 2</list_item>';
    const result = xmlToReadable(xml);
    expect(result).toContain('- Item 1');
    expect(result).toContain('- Item 2');
});
