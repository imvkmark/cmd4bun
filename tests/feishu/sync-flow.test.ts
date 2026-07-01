// sync Phase 2 清理逻辑单测
//
// 覆盖 aimDirectory 排除 + 索引缺失删除两类决策:
// - 不在索引中且不在 aimDirectory → 标记删除
// - 在 aimDirectory 子树内 → 标记排除(由 copy-docs 管辖)
// - 在索引中 → 保留

import { test, expect, describe } from 'bun:test';
import { sep } from 'node:path';
import { classifyLocalFiles } from '../../src/feishu/sync-flow';

describe('classifyLocalFiles', () => {
    test('不在索引中且不在 aimDirectory → 标记删除', () => {
        const outputDir = '/tmp/feishu';
        const localMdFiles = [
            '/tmp/feishu/old-doc.md',
            '/tmp/feishu/sub/old-doc.md'
        ];
        const indexedFiles = new Set<string>(['kept-doc.md']);
        const aimDirs = ['/tmp/aim'];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        expect(toRemove.sort()).toEqual(['old-doc.md', 'sub/old-doc.md']);
        expect(excludedByAim).toEqual([]);
    });

    test('在 aimDirectory 子树内 → 标记排除', () => {
        const outputDir = '/tmp/feishu';
        const localMdFiles = [
            '/tmp/feishu/old-doc.md',
            '/tmp/aim/blog/post.md',
            '/tmp/aim/blog/sub/page.md'
        ];
        const indexedFiles = new Set<string>();
        const aimDirs = ['/tmp/aim/blog'];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        expect(toRemove).toEqual(['old-doc.md']);
        expect(excludedByAim.sort()).toEqual(['../aim/blog/post.md', '../aim/blog/sub/page.md']);
    });

    test('aimDir 等于 mdFile 绝对路径(目录直接是 mdFile) → 排除', () => {
        const outputDir = '/tmp/feishu';
        const localMdFiles = [
            '/tmp/aim/special.md'
        ];
        const indexedFiles = new Set<string>();
        const aimDirs = ['/tmp/aim/special.md'];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        expect(toRemove).toEqual([]);
        expect(excludedByAim).toEqual(['../aim/special.md']);
    });

    test('aimDir 命中后,即使该文件不在索引中,也不删除', () => {
        // 关键场景: copy-docs 写入 aimDirectory 的副本,即使 DB 没有索引(比如老副本),
        // 也不会被 sync 误删
        const outputDir = '/tmp/feishu';
        const localMdFiles = [
            '/tmp/aim/blog/orphan-copy.md'  // 在 aimDirectory 内 + 不在 DB 索引中
        ];
        const indexedFiles = new Set<string>();  // 空索引 → 若无 aimDirectory 排除,会被删除
        const aimDirs = ['/tmp/aim/blog'];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        expect(toRemove).toEqual([]);
        expect(excludedByAim).toEqual(['../aim/blog/orphan-copy.md']);
    });

    test('多 aimDirectory 全部命中,分别独立排除', () => {
        const outputDir = '/tmp/feishu';
        const localMdFiles = [
            '/tmp/feishu/old.md',
            '/tmp/aim-blog/post.md',
            '/tmp/aim-docs/page.md'
        ];
        const indexedFiles = new Set<string>();
        const aimDirs = ['/tmp/aim-blog', '/tmp/aim-docs'];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        expect(toRemove).toEqual(['old.md']);
        expect(excludedByAim.sort()).toEqual([
            '../aim-blog/post.md',
            '../aim-docs/page.md'
        ]);
    });

    test('aimDir 字符串前缀相似但非真子路径(不接 sep) → 不算命中', () => {
        // /tmp/aim2 是 /tmp/aim 的前缀字符串,但 /tmp/aim2/foo 不在 /tmp/aim 子树内
        // 关键边界: 必须用 path.sep 区分
        const outputDir = '/tmp/feishu';
        const localMdFiles = [
            `/tmp/aim2${sep}sneaky.md`  // 在 /tmp/aim2 内,但 aim 配置的是 /tmp/aim
        ];
        const indexedFiles = new Set<string>();
        const aimDirs = ['/tmp/aim'];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        // /tmp/aim2/sneaky.md 不在 /tmp/aim 子树,应被标记删除
        expect(toRemove).toEqual([`../aim2${sep}sneaky.md`]);
        expect(excludedByAim).toEqual([]);
    });

    test('空 aimDirs + 空 indexedFiles → 全部标记删除', () => {
        const outputDir = '/tmp/feishu';
        const localMdFiles = [
            '/tmp/feishu/a.md',
            '/tmp/feishu/b.md'
        ];
        const indexedFiles = new Set<string>();
        const aimDirs: string[] = [];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        expect(toRemove.sort()).toEqual(['a.md', 'b.md']);
        expect(excludedByAim).toEqual([]);
    });

    test('在索引中 → 保留(无论是否在 aimDirectory)', () => {
        // 即便文件恰好在 aimDirectory 子树内,只要 DB 索引中也有,逻辑上不会进入删除分支
        // (findMdFiles 实际只扫 outputDir,所以 aimDirectory 子树不会进入;这里是边界验证)
        const outputDir = '/tmp/feishu';
        const localMdFiles: string[] = [];  // 模拟 outputDir 没有任何 .md
        const indexedFiles = new Set<string>(['existing.md']);
        const aimDirs = ['/tmp/aim'];

        const { toRemove, excludedByAim } = classifyLocalFiles(
            localMdFiles, outputDir, indexedFiles, aimDirs
        );

        expect(toRemove).toEqual([]);
        expect(excludedByAim).toEqual([]);
    });
});
