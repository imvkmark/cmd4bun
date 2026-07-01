// 飞书下载流程单元测试
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downNode, buildFrontmatter, uploadImagesForNode, processDocContent } from '../../src/feishu/download-flow';
import { parseAndStripFrontmatter } from '../../src/feishu/utils';
import type { DBNode } from '../../src/feishu/db';

// ============ Mock 数据 ============

function makeMockNode(overrides: Partial<import('../../src/feishu/db').DBNode> = {}): import('../../src/feishu/db').DBNode {
    return {
        node_token: 'mock-token',
        space_id: 'mock-space',
        title: '测试文档标题',
        obj_token: 'mock-obj-token',
        obj_type: 'doc',
        file_path: 'test/doc.md',
        updated_at: '2026-04-05T06:31:49.000Z',
        updated_at_last_synced_at: null,
        parent_node_token: '',
        downloaded_at: '2026-04-05T06:31:49.000Z',
        human_path: 'test-page',
        scanned_at: null,
        description: '这是一段测试描述',
        priority: 0,
        is_ignore: 0,
        upload_url: null,
        group: 'default',
        ...overrides
    };
}

// ============ buildFrontmatter ============

describe('buildFrontmatter', () => {
    test('YAML 格式应正确包含所有必需字段', () => {
        const node = makeMockNode({ title: '测试文档' });
        const result = buildFrontmatter(node.title, 'test-page', '测试描述', '2026-04-07 14:31:49', 'https://example.com');

        expect(result.startsWith('---\n')).toBe(true);
        expect(result).toContain('og:title');
        expect(result).toContain('og:type');
        expect(result).toContain('og:description');
        expect(result).toContain('og:url');
        expect(result).toContain('lastUpdated');
        expect(result).toMatch(/lastUpdated: '[\d\-: ]+'/);
    });

    test('og:title 应包含文档标题', () => {
        const node = makeMockNode({ title: '我的测试文档' });
        const result = buildFrontmatter(node.title, 'slug-a', '描述', '2026-04-07 14:31:49', 'https://example.com');
        expect(result).toContain("content: '我的测试文档'");
    });

    test('og:description 应包含描述文本', () => {
        const result = buildFrontmatter('测试文档标题', 'slug-b', '这是一段描述', '2026-04-07 14:31:49', 'https://example.com');
        expect(result).toContain("content: '这是一段描述'");
    });

    test('og:url 应正确拼接 aimUrl + slug', () => {
        const result = buildFrontmatter('测试文档标题', 'my-slug', 'desc', '2026-04-07 14:31:49', 'https://docs.example.com');
        expect(result).toContain("content: 'https://docs.example.com/my-slug.html'");
    });

    test('slug 含前导斜杠时应被剥离,避免 og:url 出现 //', () => {
        // 实际场景:slug 形如 /wr-1.x/module/index 来自飞书页面路径
        // aimUrl 末尾与 slug 头部各有一个 /,拼接时若不去重会产生 https://host//path.html
        const result = buildFrontmatter('T', '/wr-1.x/module/index', 'desc', '2026-04-07 14:31:49', 'https://weiran.tech');
        expect(result).toContain("content: 'https://weiran.tech/wr-1.x/module/index.html'");
        expect(result).not.toMatch(/weiran\.tech\/\//);
    });

    test('aimUrl 带尾部斜杠 + slug 带前导斜杠:两者去重后单 /', () => {
        const result = buildFrontmatter('T', '/wr-1.x/module/index', 'desc', '2026-04-07 14:31:49', 'https://weiran.tech/');
        expect(result).toContain("content: 'https://weiran.tech/wr-1.x/module/index.html'");
        expect(result).not.toMatch(/weiran\.tech\/\//);
    });

    test('og:url 行应在 aimUrl 为空时被跳过', () => {
        const result = buildFrontmatter('测试文档标题', 'slug-c', 'desc', '2026-04-07 14:31:49', '');
        expect(result).not.toContain('og:url');
    });

    test('og:url 行应在 aimUrl 为 undefined 时被跳过', () => {
        const result = buildFrontmatter('测试文档标题', 'slug-d', 'desc', '2026-04-07 14:31:49');
        expect(result).not.toContain('og:url');
    });

    test('lastUpdated 应使用传入的格式化时间', () => {
        const result = buildFrontmatter('测试文档标题', 'slug-e', 'desc', '2026-04-07 14:31:49', '');
        expect(result).toContain("lastUpdated: '2026-04-07 14:31:49'");
    });

    test('末尾应有换行分隔 frontmatter 与正文', () => {
        const result = buildFrontmatter('测试文档标题', 'slug-f', 'desc', '2026-04-07 14:31:49', '');
        expect(result.endsWith('---\n')).toBe(true);
    });

    test('title 含英文撇号应被 YAML 单引号转义(双写)', () => {
        // 飞书文档标题常含英文所有格 / 缩写,如 "What's New"、"It's a Test"
        // 必须用 '' 转义,否则 YAML 字符串被提前终止
        const result = buildFrontmatter("What's New", 'slug-q', 'desc', '2026-04-07 14:31:49', '');
        expect(result).toContain("content: 'What''s New'");
        // 不应出现未转义的撇号终止字符串
        expect(result).not.toMatch(/content: 'What's/);
    });

    test('description 含英文撇号应被 YAML 单引号转义', () => {
        const result = buildFrontmatter('T', 's', "It's a test doc", '2026-04-07 14:31:49', '');
        expect(result).toContain("description: 'It''s a test doc'");
        expect(result).toContain("content: 'It''s a test doc'");
    });

    test('description 含多个撇号应全部被双写转义', () => {
        const result = buildFrontmatter("Rock'n'Roll", 's', "It's a 'great' day", '2026-04-07 14:31:49', '');
        expect(result).toContain("content: 'Rock''n''Roll'");
        expect(result).toContain("description: 'It''s a ''great'' day'");
    });

    test('title 与 description 都含撇号时输出仍是合法 YAML frontmatter', () => {
        const result = buildFrontmatter("What's New", 'slug-y', "Today's update", '2026-04-07 14:31:49', 'https://example.com');
        // 全部撇号都被双写
        expect(result).toContain("description: 'Today''s update'");
        expect(result).toContain("content: 'What''s New'");
        expect(result).toContain("content: 'Today''s update'");
    });

    test('title 含尖括号应被 strip 移除(< 和 > 直接删除,内部文本保留)', () => {
        // 飞书 Redis 文档常见签名:PUBSUB <subcommand> [argument [argument …]]
        // 尖括号移除后,内部 subcommand 字面文本保留
        const result = buildFrontmatter('PUBSUB <subcommand> [argument]', 'slug-r', 'desc', '2026-04-07 14:31:49', '');
        expect(result).toContain("content: 'PUBSUB subcommand [argument]'");
        // 不应保留任何尖括号
        expect(result).not.toMatch(/[<>]/);
    });

    test('description 含尖括号应被 strip 移除', () => {
        const result = buildFrontmatter('T', 's', 'exec <script>', '2026-04-07 14:31:49', '');
        expect(result).toContain("description: 'exec script'");
        expect(result).toContain("content: 'exec script'");
    });

    test('title 含多组尖括号应全部被 strip', () => {
        const result = buildFrontmatter('EVAL <script> <numkeys> key', 's', 'desc', '2026-04-07 14:31:49', '');
        expect(result).toContain("content: 'EVAL script numkeys key'");
        expect(result).not.toMatch(/[<>]/);
    });

    test('title 同时含撇号与尖括号应双重处理(YAML 转撇号 + strip 尖括号)', () => {
        // 复杂场景:飞书文档标题 "It's <Redis> & Co."
        // 撇号双写防 YAML 终止;尖括号 strip 移除;& 字符保留(本设计不动)
        const result = buildFrontmatter("It's <Redis> & Co.", 's', 'desc', '2026-04-07 14:31:49', '');
        expect(result).toContain("content: 'It''s Redis & Co.'");
        // 撇号已双写,尖括号已 strip
        expect(result).not.toMatch(/'It[^']/);
        expect(result).not.toMatch(/[<>]/);
    });

    test('title 无任何尖括号或撇号时应原样保留', () => {
        const result = buildFrontmatter('普通标题', 's', '普通描述', '2026-04-07 14:31:49', '');
        expect(result).toContain("content: '普通标题'");
        expect(result).toContain("description: '普通描述'");
    });
});

// ============ slug 清理 + frontmatter 组合行为 ============

describe('slug 清理与 frontmatter 组合', () => {
    test('含 slug 代码块的内容：清理后 slug 代码块不在最终文件中', () => {
        const content = `# 测试文档

这是一段正文。

\`\`\`yaml
slug: my-test-page
\`\`\`

更多内容。`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(content);

        expect(slug).toBe('my-test-page');
        expect(cleanedContent).not.toContain('slug:');
        expect(cleanedContent).not.toContain('```yaml');
        expect(cleanedContent).toContain('# 测试文档');
        expect(cleanedContent).toContain('更多内容');

        // frontmatter + cleanedContent
        const frontmatter = buildFrontmatter('测试文档', slug!, '测试描述', '2026-04-07 14:31:49', 'https://example.com');
        const finalContent = frontmatter + cleanedContent;

        expect(finalContent).not.toContain('```yaml');
        expect(finalContent).not.toContain('slug: my-test-page');
        expect(finalContent).toContain('og:title');
        expect(finalContent).toContain('og:url');
    });

    test('无 slug 代码块的内容：原样保留不注入 frontmatter', () => {
        const content = `# 普通文档

正文内容，没有任何 YAML 代码块。`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(content);

        expect(slug).toBeNull();
        expect(cleanedContent).toBe(content);

        // 无 slug 时不构建 frontmatter，内容原样写入
        expect(cleanedContent).not.toContain('og:title');
    });

    test('仅第一个含 slug 的 YAML 块被移除，其他 YAML 块保留', () => {
        const content = `# 文档

\`\`\`yaml
slug: first-slug
\`\`\`

中间段落。

\`\`\`yaml
name: 其他配置
version: "2.0"
\`\`\`

结尾。`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(content);

        expect(slug).toBe('first-slug');
        // 第二个 YAML 块应保留
        expect(cleanedContent).toContain('name: 其他配置');
        expect(cleanedContent).toContain('version: "2.0"');
        // 第一个 YAML 块的 slug 不应出现
        expect(cleanedContent).not.toContain('first-slug');

        const frontmatter = buildFrontmatter('配置文档', slug!, '描述', '2026-04-07 14:31:49', '');
        const finalContent = frontmatter + cleanedContent;

        // 第二个 YAML 块在最终文件中保留
        expect(finalContent).toContain('name: 其他配置');
    });

    test('同时含 slug 和 ignore: Y 的 YAML 块应被整体移除', () => {
        const content = `# 内部草稿

\`\`\`yaml
slug: my-draft
ignore: Y
\`\`\`

仅供内部参考的草稿内容。`;
        const { slug, ignore, cleanedContent } = parseAndStripFrontmatter(content);

        expect(slug).toBe('my-draft');
        expect(ignore).toBe(true);
        expect(cleanedContent).not.toContain('slug:');
        expect(cleanedContent).not.toContain('ignore:');
        expect(cleanedContent).not.toContain('```yaml');
        expect(cleanedContent).toContain('仅供内部参考');
    });
});

// ============ downNode 入口校验 ============

describe('downNode 入口校验 — 非 doc/docx 节点应直接抛错', () => {
    function makeNodeWithType(objType: string): import('../../src/feishu/db').DBNode {
        return {
            node_token: 'mock-token',
            space_id: 'mock-space',
            title: '非文档节点',
            obj_token: 'mock-obj-token',
            obj_type: objType,
            file_path: '',
            updated_at: null,
            updated_at_last_synced_at: null,
            parent_node_token: '',
            downloaded_at: null,
            human_path: null,
            scanned_at: null,
            description: null,
            priority: 0,
            is_ignore: 0,
            upload_url: null,
            group: 'default'
        };
    }

    const noopSlot = () => Promise.resolve();

    async function expectThrows<T>(p: Promise<T>, msg: string | RegExp): Promise<void> {
        let thrown: unknown;
        try {
            await p;
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        if (typeof msg === 'string') {
            expect((thrown as Error).message).toContain(msg);
        } else {
            expect((thrown as Error).message).toMatch(msg);
        }
    }

    test('bitable 类型节点抛错', async () => {
        const node = makeNodeWithType('bitable');
        await expectThrows(downNode('/tmp', {} as never, node, noopSlot), '暂不支持下载 obj_type=bitable 的节点');
    });

    test('mindnote 类型节点抛错', async () => {
        const node = makeNodeWithType('mindnote');
        await expectThrows(downNode('/tmp', {} as never, node, noopSlot), '暂不支持下载 obj_type=mindnote 的节点');
    });

    test('slides 类型节点抛错', async () => {
        const node = makeNodeWithType('slides');
        await expectThrows(downNode('/tmp', {} as never, node, noopSlot), '暂不支持下载 obj_type=slides 的节点');
    });

    test('未知类型节点抛错并包含原始类型值', async () => {
        const node = makeNodeWithType('unknown_type');
        await expectThrows(downNode('/tmp', {} as never, node, noopSlot), /obj_type=unknown_type/);
    });
});

// ============ uploadImagesForNode 空 file_path 防御守卫 ============

describe('uploadImagesForNode — file/sheet 节点的空 file_path 防御短路', () => {
    const noopSlot = () => Promise.resolve();

    test('file_path 为空字符串时短路返回零计数，不抛错', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'feishu-test-'));

        const node = { file_path: '', node_token: 'file-token' };
        const result = await uploadImagesForNode(tempDir, {} as never, node, null, noopSlot);

        expect(result).toEqual({ processed: 0, failed: 0, failures: [] });
        expect(existsSync(tempDir)).toBe(true);
    });

    test('file_path 为空时不读到 outputDir 当文件', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'feishu-test-'));

        const node = { file_path: '', node_token: 'file-token' };

        // 如果短路失效，Bun.file(outputDir).text() 会抛 "Directories cannot be read like files"
        expect(
            uploadImagesForNode(tempDir, {} as never, node, null, noopSlot)
        ).resolves.toBeDefined();
    });
});

// ============ processDocContent 跨 group 引用解析 ============

describe('processDocContent — 跨 group 引用解析', () => {
    let tempDir: string;
    let prevXdg: string | undefined;

    /**
     * 构造仅含 nodes 表的最小 SQLite DB,列结构对齐 DBNode 接口。
     * 不依赖完整 migration 流程,便于测试聚焦 resolveLink 决策。
     */
    function createTestDb(): Database {
        const db = new Database(':memory:');
        db.run(`
            CREATE TABLE nodes (
                node_token TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                title TEXT NOT NULL,
                obj_token TEXT NOT NULL,
                obj_type TEXT NOT NULL,
                file_path TEXT NOT NULL,
                updated_at TEXT,
                updated_at_last_synced_at TEXT,
                parent_node_token TEXT,
                downloaded_at TEXT,
                scanned_at TEXT,
                human_path TEXT,
                description TEXT,
                priority INTEGER DEFAULT 0,
                is_ignore INTEGER DEFAULT 0,
                upload_url TEXT,
                "group" TEXT NOT NULL DEFAULT 'default'
            )
        `);
        return db;
    }

    function insertNode(db: Database, node: Partial<DBNode> & { node_token: string; obj_token: string }): void {
        db.run(
            `INSERT INTO nodes (
                node_token, space_id, title, obj_token, obj_type, file_path,
                updated_at, updated_at_last_synced_at, parent_node_token,
                downloaded_at, scanned_at, human_path, description,
                priority, is_ignore, upload_url, "group"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                node.node_token,
                node.space_id ?? 's1',
                node.title ?? node.node_token,
                node.obj_token,
                node.obj_type ?? 'docx',
                node.file_path ?? '',
                node.updated_at ?? '2026-04-05T00:00:00.000Z',
                node.updated_at_last_synced_at ?? null,
                node.parent_node_token ?? '',
                node.downloaded_at ?? '2026-04-05T00:00:00.000Z',
                node.scanned_at ?? null,
                node.human_path ?? null,
                node.description ?? 'test description',
                node.priority ?? 0,
                node.is_ignore ?? 0,
                node.upload_url ?? null,
                node.group ?? 'default'
            ]
        );
    }

    beforeEach(() => {
        // 用临时 XDG 目录注入测试 config,避免污染真实配置
        tempDir = mkdtempSync(join(tmpdir(), 'feishu-test-cfg-'));
        mkdirSync(join(tempDir, 'cmd4bun'), { recursive: true });
        prevXdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = tempDir;
    });

    afterEach(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        rmSync(tempDir, { recursive: true, force: true });
    });

    function writeConfig(cfg: unknown): void {
        writeFileSync(join(tempDir, 'cmd4bun', 'config.json'), JSON.stringify(cfg));
    }

    /**
     * 构造当前节点:group=blog,有 slug,有 description(避免触发 resolveDescription)。
     */
    function makeCurrentNode(group: string, overrides: Partial<DBNode> = {}): DBNode {
        return makeMockNode({
            node_token: 'current',
            obj_token: 'obj-current',
            obj_type: 'docx',
            human_path: 'current-page',
            description: 'current desc',
            group,
            file_path: 'blog/current.md',
            ...overrides
        });
    }

    test('cite 同 group 引用应输出相对路径 .md', async () => {
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        // 被引节点同组 + human_path 已就绪
        insertNode(db, {
            node_token: 'ref-same',
            obj_token: 'obj-ref-same',
            obj_type: 'docx',
            human_path: 'referenced-page',
            group: 'blog'
        });
        const content = '正文 <cite doc-id="ref-same" file-type="wiki" title="同组引用" type="doc"></cite> 结尾';

        const { processedContent } = await processDocContent(
            content, '当前', '2026-04-05T00:00:00.000Z', db, current
        );

        expect(processedContent).toContain('[同组引用](referenced-page.md)');
        expect(processedContent).not.toContain('https://');
    });

    test('cite 跨 group + 被引方 aimUrl 命中 → 绝对 URL .html', async () => {
        writeConfig({
            feishu: {
                default: { aimUrl: 'https://docs.example.com' },
                blog: { aimUrl: 'https://blog.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        // 被引节点跨组 + human_path 已就绪
        insertNode(db, {
            node_token: 'ref-cross',
            obj_token: 'obj-ref-cross',
            obj_type: 'docx',
            human_path: 'cross-page',
            group: 'docs'
        });
        const content = '正文 <cite doc-id="ref-cross" file-type="wiki" title="跨组引用" type="doc"></cite> 结尾';

        const { processedContent } = await processDocContent(
            content, '当前', '2026-04-05T00:00:00.000Z', db, current
        );

        expect(processedContent).toContain('[跨组引用](https://docs.example.com/cross-page.html)');
        expect(processedContent).not.toContain('cross-page.md');
    });

    test('cite 跨 group + 被引方 aimUrl 缺失 → 保留原文 + warning', async () => {
        // 只有 blog group 配 aimUrl;被引方 docs 没配
        writeConfig({
            feishu: {
                blog: { aimUrl: 'https://blog.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        insertNode(db, {
            node_token: 'ref-noaim',
            obj_token: 'obj-ref-noaim',
            obj_type: 'docx',
            human_path: 'orphan-page',
            group: 'docs'
        });
        const content = '正文 <cite doc-id="ref-noaim" file-type="wiki" title="缺aimUrl" type="doc"></cite> 结尾';

        // capture stdout for warning
        const captured: string[] = [];
        const origWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk: string | Uint8Array): boolean => {
            captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
            return true;
        };

        try {
            const { processedContent } = await processDocContent(
                content, '当前', '2026-04-05T00:00:00.000Z', db, current
            );
            expect(processedContent).toContain('<cite doc-id="ref-noaim"');
            expect(processedContent).not.toContain('orphan-page.md');
            expect(captured.join('')).toContain('cross-group');
            expect(captured.join('')).toContain('docs');
            expect(captured.join('')).toContain('缺少 aimUrl');
        } finally {
            process.stdout.write = origWrite;
        }
    });

    test('cite 跨 group + aimUrl 缺失应不修改被引节点的 priority/downloaded_at', async () => {
        writeConfig({
            feishu: {
                blog: { aimUrl: 'https://blog.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        insertNode(db, {
            node_token: 'ref-no-bump',
            obj_token: 'obj-ref-no-bump',
            obj_type: 'docx',
            human_path: 'orphan-page',
            group: 'docs',
            priority: 0,
            downloaded_at: '2026-04-05T00:00:00.000Z'
        });
        const content = '<cite doc-id="ref-no-bump" file-type="wiki" title="x" type="doc"></cite>';

        // 抑制 stdout
        const origWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = () => true;
        try {
            await processDocContent(content, 'T', '2026-04-05T00:00:00.000Z', db, current);
        } finally {
            process.stdout.write = origWrite;
        }

        const after = db.query('SELECT priority, downloaded_at FROM nodes WHERE node_token = ?').get('ref-no-bump') as { priority: number; downloaded_at: string | null };
        expect(after.priority).toBe(0);
        expect(after.downloaded_at).toBe('2026-04-05T00:00:00.000Z');
    });

    test('cite 未就绪(human_path 缺失) → 原文 + warning 且不 bump', async () => {
        writeConfig({
            feishu: {
                blog: { aimUrl: 'https://blog.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        insertNode(db, {
            node_token: 'ref-not-ready',
            obj_token: 'obj-ref-not-ready',
            obj_type: 'docx',
            human_path: null,
            group: 'blog',
            priority: 5,
            downloaded_at: '2026-04-05T00:00:00.000Z'
        });
        const content = '<cite doc-id="ref-not-ready" file-type="wiki" title="未就绪" type="doc"></cite>';

        const origWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = () => true;
        try {
            const { processedContent } = await processDocContent(
                content, 'T', '2026-04-05T00:00:00.000Z', db, current
            );
            expect(processedContent).toContain('<cite doc-id="ref-not-ready"');
        } finally {
            process.stdout.write = origWrite;
        }

        const after = db.query('SELECT priority, downloaded_at FROM nodes WHERE node_token = ?').get('ref-not-ready') as { priority: number; downloaded_at: string | null };
        // priority 未变(原本就是 5,不被 bump)
        expect(after.priority).toBe(5);
        // downloaded_at 不被清空(原本就非空,旧版会被清空)
        expect(after.downloaded_at).toBe('2026-04-05T00:00:00.000Z');
    });

    test('sub-page 跨 group + aimUrl 命中 → 绝对 URL .html', async () => {
        writeConfig({
            feishu: {
                default: { aimUrl: 'https://docs.example.com' },
                blog: { aimUrl: 'https://blog.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        // sub-page 用 obj_token 查,需要 obj_token 唯一
        insertNode(db, {
            node_token: 'sp-cross-node',
            obj_token: 'sp-cross-obj',
            obj_type: 'docx',
            human_path: 'sp-cross',
            group: 'docs'
        });
        const content = '<sub-page-list>'
            + '<sub-page doc-id="sp-cross-obj" file-type="docx" title="子页跨组"/>'
            + '</sub-page-list>';

        const { processedContent } = await processDocContent(
            content, 'T', '2026-04-05T00:00:00.000Z', db, current
        );

        expect(processedContent).toContain('- [子页跨组](https://docs.example.com/sp-cross.html)');
        expect(processedContent).not.toContain('sp-cross.md');
    });

    test('sub-page 同 group 应输出相对路径 .md', async () => {
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        insertNode(db, {
            node_token: 'sp-same-node',
            obj_token: 'sp-same-obj',
            obj_type: 'docx',
            human_path: 'sp-same',
            group: 'blog'
        });
        const content = '<sub-page-list>'
            + '<sub-page doc-id="sp-same-obj" file-type="docx" title="子页同组"/>'
            + '</sub-page-list>';

        const { processedContent } = await processDocContent(
            content, 'T', '2026-04-05T00:00:00.000Z', db, current
        );

        expect(processedContent).toContain('- [子页同组](sp-same.md)');
        expect(processedContent).not.toContain('https://');
    });
});

// ============ processDocContent callout 内部 <a> 链接替换 ============
//
// 覆盖 4 个场景:callout 内 <a> 同 group / 跨组 aimUrl / 跨组 aimUrl 缺失 / 完整 URL 原样
// 验证 makeResolveLink 共享闭包被 callout 解析器复用,保持 <a> 标签形态只换 href

describe('processDocContent — callout 内部 <a> 链接替换', () => {
    let tempDir: string;
    let prevXdg: string | undefined;

    function createTestDb(): Database {
        const db = new Database(':memory:');
        db.run(`
            CREATE TABLE nodes (
                node_token TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                title TEXT NOT NULL,
                obj_token TEXT NOT NULL,
                obj_type TEXT NOT NULL,
                file_path TEXT NOT NULL,
                updated_at TEXT,
                updated_at_last_synced_at TEXT,
                parent_node_token,
                downloaded_at TEXT,
                scanned_at TEXT,
                human_path TEXT,
                description TEXT,
                priority INTEGER DEFAULT 0,
                is_ignore INTEGER DEFAULT 0,
                upload_url TEXT,
                "group" TEXT NOT NULL DEFAULT 'default'
            )
        `);
        return db;
    }

    function insertNode(db: Database, node: Partial<DBNode> & { node_token: string; obj_token: string }): void {
        db.run(
            `INSERT INTO nodes (
                node_token, space_id, title, obj_token, obj_type, file_path,
                updated_at, updated_at_last_synced_at, parent_node_token,
                downloaded_at, scanned_at, human_path, description,
                priority, is_ignore, upload_url, "group"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                node.node_token, node.space_id ?? 's1', node.title ?? node.node_token,
                node.obj_token, node.obj_type ?? 'docx', node.file_path ?? '',
                node.updated_at ?? '2026-04-05T00:00:00.000Z',
                node.updated_at_last_synced_at ?? null, node.parent_node_token ?? '',
                node.downloaded_at ?? '2026-04-05T00:00:00.000Z', node.scanned_at ?? null,
                node.human_path ?? null, node.description ?? 'test desc',
                node.priority ?? 0, node.is_ignore ?? 0, node.upload_url ?? null,
                node.group ?? 'default'
            ]
        );
    }

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'feishu-test-cfg-'));
        mkdirSync(join(tempDir, 'cmd4bun'), { recursive: true });
        prevXdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = tempDir;
    });

    afterEach(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        rmSync(tempDir, { recursive: true, force: true });
    });

    function writeConfig(cfg: unknown): void {
        writeFileSync(join(tempDir, 'cmd4bun', 'config.json'), JSON.stringify(cfg));
    }

    function makeCurrentNode(group: string, overrides: Partial<DBNode> = {}): DBNode {
        return makeMockNode({
            node_token: 'current',
            obj_token: 'obj-current',
            obj_type: 'docx',
            human_path: 'current-page',
            description: 'current desc',
            group,
            file_path: 'blog/current.md',
            ...overrides
        });
    }

    test('callout 内 <a> 同 group → <a href="${path}.md">', async () => {
        writeConfig({
            feishu: {
                blog: { aimUrl: 'https://blog.example.com' },
                docs: { aimUrl: 'https://docs.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        insertNode(db, {
            node_token: 'co-same',
            obj_token: 'co-same-obj',
            obj_type: 'docx',
            human_path: 'same-page',
            group: 'blog'
        });
        const content = '<callout emoji="📆">查看 <a href="co-same-obj">同组</a></callout>';

        const { processedContent } = await processDocContent(
            content, '当前', '2026-04-05T00:00:00.000Z', db, current
        );

        // 保持 <a> 标签形态,只换 href
        expect(processedContent).toContain('<a href="same-page.md">同组</a>');
        expect(processedContent).not.toContain('https://');
    });

    test('callout 内 <a> 跨 group + aimUrl → <a href="${aimUrl}/${path}.html">', async () => {
        writeConfig({
            feishu: {
                blog: { aimUrl: 'https://blog.example.com' },
                docs: { aimUrl: 'https://docs.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        insertNode(db, {
            node_token: 'co-cross',
            obj_token: 'co-cross-obj',
            obj_type: 'docx',
            human_path: 'cross-page',
            group: 'docs'
        });
        const content = '<callout emoji="💡">参考 <a href="co-cross-obj">跨组</a></callout>';

        const { processedContent } = await processDocContent(
            content, '当前', '2026-04-05T00:00:00.000Z', db, current
        );

        expect(processedContent).toContain('<a href="https://docs.example.com/cross-page.html">跨组</a>');
        expect(processedContent).not.toContain('cross-page.md');
    });

    test('callout 内 <a> 跨 group + aimUrl 缺失 → 保留原文 + warning', async () => {
        // blog 配 aimUrl,docs 没配 → 跨组引用走 reason 失败路径
        writeConfig({
            feishu: {
                blog: { aimUrl: 'https://blog.example.com' }
            }
        });
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        insertNode(db, {
            node_token: 'co-noaim',
            obj_token: 'co-noaim-obj',
            obj_type: 'docx',
            human_path: 'orphan-page',
            group: 'docs'
        });
        const content = '<callout emoji="⚠️">注意 <a href="co-noaim-obj">孤儿</a></callout>';

        const captured: string[] = [];
        const origWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk: string | Uint8Array): boolean => {
            captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
            return true;
        };

        try {
            const { processedContent } = await processDocContent(
                content, '当前', '2026-04-05T00:00:00.000Z', db, current
            );
            // 原文保留
            expect(processedContent).toContain('<a href="co-noaim-obj">孤儿</a>');
            expect(processedContent).not.toContain('orphan-page.md');
            // warning 包含跨组 aimUrl 缺失 + href
            expect(captured.join('')).toContain('cross-group');
            expect(captured.join('')).toContain('docs');
            expect(captured.join('')).toContain('缺少 aimUrl');
            expect(captured.join('')).toContain('href=co-noaim-obj');
        } finally {
            process.stdout.write = origWrite;
        }
    });

    test('callout 内 <a> 完整 URL(http/https) 原样保留', async () => {
        const db = createTestDb();
        const current = makeCurrentNode('blog');
        const content = '<callout emoji="❌">访问 <a href="https://example.com/external">外部</a></callout>';

        const { processedContent } = await processDocContent(
            content, '当前', '2026-04-05T00:00:00.000Z', db, current
        );

        expect(processedContent).toContain('<a href="https://example.com/external">外部</a>');
        // 完整 URL 不应被改写
        expect(processedContent).not.toContain('external.md');
    });
});
