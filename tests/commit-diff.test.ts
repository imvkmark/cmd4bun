import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { getStagedDiff, getWorkingTreeDiff } from '../src/commit/diff';

// ============ 测试辅助 ============

describe('commit/diff 纯函数测试', () => {
    let originalCwd: string;
    let tempDir: string;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = mkdtempSync(join(tmpdir(), 'commit-diff-test-'));
        process.chdir(tempDir);
        execSync('git init -q');
        execSync('git config user.email "test@test.com"');
        execSync('git config user.name "Test"');
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    // ============ 3.1 空仓库 ============

    test('3.1 空仓库：两路 diff 都为空', () => {
        expect(getStagedDiff()).toBe('');
        expect(getWorkingTreeDiff()).toBe('');
    });

    // ============ 3.2 纯 staged ============

    test('3.2 纯 staged：staged diff 有内容，working tree diff 为空', () => {
        writeFileSync('staged.txt', 'hello');
        execSync('git add staged.txt');

        const staged = getStagedDiff();
        expect(staged).toContain('staged.txt');
        expect(staged).toContain('hello');

        expect(getWorkingTreeDiff()).toBe('');
    });

    // ============ 3.3 纯 untracked（核心 bug 场景）============

    test('3.3 纯 untracked（核心 bug 场景）：两路 diff 都为空', () => {
        writeFileSync('new1.txt', 'hello');
        writeFileSync('new2.txt', 'world');

        // 修复前：这两路都会返回空字符串 → autoCommitAndPush abort
        expect(getStagedDiff()).toBe('');
        expect(getWorkingTreeDiff()).toBe('');
    });

    // ============ 3.4 staged + untracked 混合 ============

    test('3.4 staged + untracked 混合：staged diff 只含 staged 部分', () => {
        // 建立 baseline：先 commit 一个文件
        writeFileSync('base.txt', 'baseline');
        execSync('git add base.txt');
        execSync('git commit -m initial -q');

        // 修改 tracked 文件（unstaged）+ 新增 untracked + 新增 staged
        writeFileSync('base.txt', 'baseline-modified');
        writeFileSync('new-untracked.txt', 'untracked');
        writeFileSync('new-staged.txt', 'staged');
        execSync('git add new-staged.txt');

        const staged = getStagedDiff();
        expect(staged).toContain('new-staged.txt');
        expect(staged).not.toContain('new-untracked.txt');
        expect(staged).not.toContain('base.txt');

        const unstaged = getWorkingTreeDiff();
        expect(unstaged).toContain('base.txt');
        expect(unstaged).toContain('baseline-modified');
        expect(unstaged).not.toContain('new-untracked.txt');
        expect(unstaged).not.toContain('new-staged.txt');
    });

    // ============ 3.5 stage-first 后 diff 变化（auto 模式修复验证）============

    test('3.5 stage-first 后 diff 变化：模拟 --auto 模式修复', () => {
        // 纯 untracked 场景
        writeFileSync('new1.txt', 'hello');
        writeFileSync('new2.txt', 'world');

        // 修复前：两路都为空
        expect(getStagedDiff()).toBe('');
        expect(getWorkingTreeDiff()).toBe('');

        // 模拟 --auto 模式：先 git add -A
        execSync('git add -A');

        // 修复后：staged diff 包含 untracked 文件
        const staged = getStagedDiff();
        expect(staged).toContain('new1.txt');
        expect(staged).toContain('new2.txt');
        expect(staged).toContain('hello');
        expect(staged).toContain('world');
    });
});
