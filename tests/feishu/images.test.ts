// 飞书图片处理单元测试
import { test, expect, describe } from 'bun:test';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { updateFrontmatterOgImage, extractImageUrls, findOrphanImages, cleanupGlobalOrphans, md5Bytes, mimeToExt, guessExtFromUrl } from '../../src/feishu/images';

describe('extractImageUrls', () => {
    test('单张图片应正确提取', () => {
        const md = '正文 ![alt](https://example.com/img.png) 结尾';
        const result = extractImageUrls(md);
        expect(result.length).toBe(1);
        expect(result[0]!.url).toBe('https://example.com/img.png');
        expect(result[0]!.altText).toBe('alt');
    });

    test('无图片应返回空数组', () => {
        const md = '纯文本内容';
        expect(extractImageUrls(md)).toEqual([]);
    });

    test('多张图片应全部提取', () => {
        const md = '![a](https://example.com/a.jpg) 文字 ![b](https://example.com/b.jpg)';
        const result = extractImageUrls(md);
        expect(result.length).toBe(2);
    });

    test('空 alt 文本应正确处理', () => {
        const md = '![](https://example.com/img.png)';
        const urls = extractImageUrls(md);
        expect(urls.length).toBe(1);
        expect(urls[0]!.altText).toBe('');
        expect(urls[0]!.url).toBe('https://example.com/img.png');
    });

    test('含 query params 的 URL 应完整提取', () => {
        const md = '![img](https://example.com/img.png?token=abc&size=large)';
        const urls = extractImageUrls(md);
        expect(urls.length).toBe(1);
        expect(urls[0]!.url).toBe('https://example.com/img.png?token=abc&size=large');
    });

    test('不应匹配普通链接', () => {
        const md = '[link text](https://example.com/page)';
        const urls = extractImageUrls(md);
        expect(urls.length).toBe(0);
    });
});

describe('updateFrontmatterOgImage', () => {
    test('有 frontmatter 且含图片时应添加 og:image', () => {
        const tmpFile = join(tmpdir(), `test-og-${Date.now()}.md`);
        const content = [
            '---',
            'head:',
            '  - meta:',
            "      name: 'og:title'",
            "      content: 'Test'",
            "lastUpdated: '2026-04-07 14:31:49'",
            '---',
            '',
            '# Test',
            '![logo](./images/abc.png)'
        ].join('\n');
        writeFileSync(tmpFile, content);

        updateFrontmatterOgImage(tmpFile);

        const result = readFileSync(tmpFile, 'utf-8');
        expect(result).toContain('og:image');
        expect(result).toContain('./images/abc.png');
        // Cleanup
        unlinkSync(tmpFile);
    });

    test('无 frontmatter 文件应跳过', () => {
        const tmpFile = join(tmpdir(), `test-og-${Date.now()}2.md`);
        const content = '# Just content\n![img](test.png)';
        writeFileSync(tmpFile, content);

        updateFrontmatterOgImage(tmpFile);

        const result = readFileSync(tmpFile, 'utf-8');
        expect(result).not.toContain('og:image');
        unlinkSync(tmpFile);
    });

    test('已有 og:image 时应更新而非重复添加', () => {
        const tmpFile = join(tmpdir(), `test-og-${Date.now()}3.md`);
        const content = [
            '---',
            'head:',
            '  - meta:',
            "      name: 'og:image'",
            "      content: 'old-image.png'",
            '  - meta:',
            "      name: 'og:title'",
            "      content: 'Test'",
            "lastUpdated: '2026-04-07 14:31:49'",
            '---',
            '',
            '# Test',
            '![new](./images/new.png)'
        ].join('\n');
        writeFileSync(tmpFile, content);

        updateFrontmatterOgImage(tmpFile);

        const result = readFileSync(tmpFile, 'utf-8');
        // og:image 内容应已被更新
        expect(result).toContain("content: './images/new.png'");
        // 不应出现旧值
        expect(result).not.toContain('old-image.png');
        // og:image 仍应只出现一次
        const ogImageCount = (result.match(/og:image/g) ?? []).length;
        expect(ogImageCount).toBe(1);
        unlinkSync(tmpFile);
    });
});

// ============ findOrphanImages ============

describe('findOrphanImages', () => {
    test('无孤儿图片时应返回空数组', () => {
        const tmpDir = join(tmpdir(), `test-orphan-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });

        // 创建引用了一张图片的 markdown 文件
        const refMd5 = 'aaaa1111222233334444555566667777';
        const mdContent = `# Test\n![img](./images/${refMd5}.png)\n`;
        writeFileSync(join(tmpDir, 'doc1.md'), mdContent);

        // 创建内存 DB，images 表只有被引用的图片
        const db = new Database(':memory:');
        db.run('CREATE TABLE images (md5 TEXT, node_token TEXT, ext TEXT, oss_url TEXT, uploaded INTEGER)');
        db.run(`INSERT INTO images VALUES ('${refMd5}', 'node1', 'png', NULL, 0)`);

        const orphans = findOrphanImages(db, tmpDir);
        expect(orphans).toEqual([]);

        db.close();
        rmSync(tmpDir, { recursive: true });
    });

    test('有孤儿图片时应返回孤儿列表', () => {
        const tmpDir = join(tmpdir(), `test-orphan-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });

        // 创建引用一张图片的 markdown 文件
        const refMd5 = 'aaaa1111222233334444555566667777';
        const orphanMd5 = 'bbbb1111222233334444555566667777';
        const mdContent = `# Test\n![img](./images/${refMd5}.png)\n`;
        writeFileSync(join(tmpDir, 'doc1.md'), mdContent);

        // 创建内存 DB，images 表有一张被引用 + 一张孤儿
        const db = new Database(':memory:');
        db.run('CREATE TABLE images (md5 TEXT, node_token TEXT, ext TEXT, oss_url TEXT, uploaded INTEGER)');
        db.run(`INSERT INTO images VALUES ('${refMd5}', 'node1', 'png', NULL, 0)`);
        db.run(`INSERT INTO images VALUES ('${orphanMd5}', 'node2', 'jpg', NULL, 0)`);

        const orphans = findOrphanImages(db, tmpDir);
        expect(orphans.length).toBe(1);
        expect(orphans[0]!.md5).toBe(orphanMd5);
        expect(orphans[0]!.ext).toBe('jpg');

        db.close();
        rmSync(tmpDir, { recursive: true });
    });

    test('OSS URL 中的图片引用应被识别', () => {
        const tmpDir = join(tmpdir(), `test-orphan-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });

        // 使用 OSS 公网 URL 引用图片
        const refMd5 = 'aaaa1111222233334444555566667777';
        const orphanMd5 = 'cccc1111222233334444555566667777';
        const mdContent = `# Test\n![img](https://static.example.com/feishu-images/${refMd5}.png)\n`;
        writeFileSync(join(tmpDir, 'doc1.md'), mdContent);

        const db = new Database(':memory:');
        db.run('CREATE TABLE images (md5 TEXT, node_token TEXT, ext TEXT, oss_url TEXT, uploaded INTEGER)');
        db.run(`INSERT INTO images VALUES ('${refMd5}', 'node1', 'png', 'https://static.example.com/feishu-images/${refMd5}.png', 1)`);
        db.run(`INSERT INTO images VALUES ('${orphanMd5}', 'node2', 'webp', NULL, 0)`);

        const orphans = findOrphanImages(db, tmpDir);
        expect(orphans.length).toBe(1);
        expect(orphans[0]!.md5).toBe(orphanMd5);

        db.close();
        rmSync(tmpDir, { recursive: true });
    });

    test('多文档共享图片不应被误判为孤儿', () => {
        const tmpDir = join(tmpdir(), `test-orphan-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });

        const sharedMd5 = 'dddd1111222233334444555566667777';
        writeFileSync(join(tmpDir, 'doc1.md'), `# Doc1\n![a](./images/${sharedMd5}.png)\n`);
        writeFileSync(join(tmpDir, 'doc2.md'), `# Doc2\n![b](./images/${sharedMd5}.png)\n`);

        const db = new Database(':memory:');
        db.run('CREATE TABLE images (md5 TEXT, node_token TEXT, ext TEXT, oss_url TEXT, uploaded INTEGER)');
        db.run(`INSERT INTO images VALUES ('${sharedMd5}', 'node1', 'png', NULL, 0)`);
        db.run(`INSERT INTO images VALUES ('${sharedMd5}', 'node2', 'png', NULL, 0)`);

        const orphans = findOrphanImages(db, tmpDir);
        expect(orphans).toEqual([]);

        db.close();
        rmSync(tmpDir, { recursive: true });
    });

    test('无 markdown 文件时应将所有 DB 图片视为孤儿', () => {
        const tmpDir = join(tmpdir(), `test-orphan-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });

        const db = new Database(':memory:');
        db.run('CREATE TABLE images (md5 TEXT, node_token TEXT, ext TEXT, oss_url TEXT, uploaded INTEGER)');
        const orphanMd5 = 'aaaa1111222233334444555566667777';
        db.run(`INSERT INTO images VALUES ('${orphanMd5}', 'node1', 'png', NULL, 0)`);

        const orphans = findOrphanImages(db, tmpDir);
        expect(orphans.length).toBe(1);

        db.close();
        rmSync(tmpDir, { recursive: true });
    });
});

// ============ cleanupGlobalOrphans ============

describe('cleanupGlobalOrphans', () => {
    test('无孤儿时应返回 0 且不删除任何记录', () => {
        const tmpDir = join(tmpdir(), `test-gco-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });

        const refMd5 = 'aaaa1111222233334444555566667777';
        writeFileSync(join(tmpDir, 'doc1.md'), `# Test\n![img](./images/${refMd5}.png)\n`);

        const db = new Database(':memory:');
        db.run('CREATE TABLE images (md5 TEXT, node_token TEXT, ext TEXT, oss_url TEXT, uploaded INTEGER)');
        db.run(`INSERT INTO images VALUES ('${refMd5}', 'node1', 'png', NULL, 0)`);

        const count = cleanupGlobalOrphans(db, tmpDir, null);
        expect(count).toBe(0);

        // DB 记录应保留
        const remaining = db.query('SELECT COUNT(*) AS cnt FROM images').get() as { cnt: number };
        expect(remaining.cnt).toBe(1);

        db.close();
        rmSync(tmpDir, { recursive: true });
    });

    test('有孤儿时应清理 DB 记录和本地文件', () => {
        const tmpDir = join(tmpdir(), `test-gco-${Date.now()}`);
        const tempDir = join(tmpDir, 'data', 'temp');
        mkdirSync(tempDir, { recursive: true });

        const orphanMd5 = 'eeee1111222233334444555566667777';
        // 创建本地 temp 文件
        writeFileSync(join(tempDir, `${orphanMd5}.jpg`), 'fake-image-data');

        // 创建引用一张图片的 markdown
        const refMd5 = 'aaaa1111222233334444555566667777';
        writeFileSync(join(tmpDir, 'doc1.md'), `# Test\n![img](./images/${refMd5}.png)\n`);

        const db = new Database(':memory:');
        db.run('CREATE TABLE images (md5 TEXT, node_token TEXT, ext TEXT, oss_url TEXT, uploaded INTEGER)');
        db.run('CREATE TABLE image_vs_node (md5 TEXT, node_token TEXT)');
        db.run(`INSERT INTO images VALUES ('${refMd5}', 'node1', 'png', NULL, 0)`);
        db.run(`INSERT INTO images VALUES ('${orphanMd5}', 'node2', 'jpg', NULL, 0)`);

        const count = cleanupGlobalOrphans(db, tmpDir, null);
        expect(count).toBe(1);

        // 孤儿 DB 记录应被删除
        const orphans = db.query('SELECT md5 FROM images WHERE md5=?').all(orphanMd5) as { md5: string }[];
        expect(orphans.length).toBe(0);

        // 被引用的记录应保留
        const refs = db.query('SELECT md5 FROM images WHERE md5=?').all(refMd5) as { md5: string }[];
        expect(refs.length).toBe(1);

        // 本地文件应被删除
        expect(existsSync(join(tempDir, `${orphanMd5}.jpg`))).toBe(false);

        db.close();
        rmSync(tmpDir, { recursive: true });
    });
});

// ============ md5Bytes ============

describe('md5Bytes', () => {
    test('生成 32 位十六进制字符串', () => {
        const data = new TextEncoder().encode('hello world').buffer;
        const hash = md5Bytes(data);
        expect(hash.length).toBe(32);
        expect(hash).toMatch(/^[a-f0-9]{32}$/);
    });

    test('确定性：相同输入产生相同哈希', () => {
        const data = new TextEncoder().encode('test data').buffer;
        const h1 = md5Bytes(data);
        const h2 = md5Bytes(data);
        expect(h1).toBe(h2);
    });

    test('不同输入产生不同哈希', () => {
        const h1 = md5Bytes(new TextEncoder().encode('hello').buffer);
        const h2 = md5Bytes(new TextEncoder().encode('world').buffer);
        expect(h1).not.toBe(h2);
    });

    test('已知空字符串 MD5 值', () => {
        const hash = md5Bytes(new ArrayBuffer(0));
        expect(hash).toBe('d41d8cd98f00b204e9800998ecf8427e');
    });
});

// ============ mimeToExt ============

describe('mimeToExt', () => {
    test('已知 MIME 类型映射', () => {
        expect(mimeToExt('image/png')).toBe('png');
        expect(mimeToExt('image/jpeg')).toBe('jpg');
        expect(mimeToExt('image/gif')).toBe('gif');
        expect(mimeToExt('image/webp')).toBe('webp');
        expect(mimeToExt('image/svg+xml')).toBe('svg');
    });

    test('未知类型返回 null', () => {
        expect(mimeToExt('text/html')).toBeNull();
        expect(mimeToExt('application/octet-stream')).toBeNull();
    });

    test('含 charset 的 Content-Type 应匹配', () => {
        expect(mimeToExt('image/png; charset=utf-8')).toBe('png');
    });
});

// ============ guessExtFromUrl ============

describe('guessExtFromUrl', () => {
    test('从路径提取扩展名', () => {
        expect(guessExtFromUrl('https://example.com/image.png')).toBe('png');
        expect(guessExtFromUrl('https://example.com/photo.jpg')).toBe('jpg');
        expect(guessExtFromUrl('https://example.com/animated.gif')).toBe('gif');
    });

    test('jpeg 规范化为 jpg', () => {
        expect(guessExtFromUrl('https://example.com/photo.jpeg')).toBe('jpg');
    });

    test('未知扩展名回退为 png', () => {
        expect(guessExtFromUrl('https://example.com/file.pdf')).toBe('png');
    });

    test('含 query string 时应提取正确', () => {
        expect(guessExtFromUrl('https://example.com/img.png?token=abc')).toBe('png');
    });

    test('畸形 URL 回退为 png', () => {
        expect(guessExtFromUrl('not-a-url')).toBe('png');
    });
});
