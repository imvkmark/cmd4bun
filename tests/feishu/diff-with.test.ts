// 飞书 diff-with 流程单元测试 (v2: 位置参数 group + 三级判定)
//
// 覆盖:
//  - absPathToHumanPath 路径转换 helper
//  - readTitleFromFrontmatter 文件读取 helper
//  - buildFeishuUrl URL 构造 helper
//  - runDiffWith 端到端(用 tmpdir 隔离 XDG_CONFIG_HOME 与 DB / aimDirectory)
//  15 个场景见 describe('runDiffWith 端到端')

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Database } from 'bun:sqlite';
import {
    absPathToHumanPath,
    readTitleFromFrontmatter,
    buildFeishuUrl,
    runDiffWith
} from '../../src/feishu/diff-with-flow';
import { buildFrontmatter } from '../../src/feishu/download-flow';
import { closeDB } from '../../src/feishu/db';
import type { DiffWithArgs } from '../../src/feishu/cli/types';

// ============ absPathToHumanPath ============

describe('absPathToHumanPath', () => {
    const aimDir = '/tmp/aim';

    test('顶层 .md 转为 human_path', () => {
        expect(absPathToHumanPath(aimDir, '/tmp/aim/intro.md')).toBe('intro');
    });

    test('子目录 .md 保留子路径', () => {
        expect(absPathToHumanPath(aimDir, '/tmp/aim/guide/install.md')).toBe('guide/install');
    });

    test('无 .md 后缀时不去尾', () => {
        expect(absPathToHumanPath(aimDir, '/tmp/aim/no-ext')).toBe('no-ext');
    });

    test('多级嵌套路径', () => {
        expect(absPathToHumanPath(aimDir, '/tmp/aim/a/b/c/d.md')).toBe('a/b/c/d');
    });
});

// ============ buildFeishuUrl ============

describe('buildFeishuUrl', () => {
    test('拼接飞书 wiki URL', () => {
        expect(buildFeishuUrl('abc123')).toBe('https://feishu.cn/wiki/abc123');
    });

    test('长 token 也正确', () => {
        expect(buildFeishuUrl('abcdefghij1234567890')).toBe(
            'https://feishu.cn/wiki/abcdefghij1234567890'
        );
    });
});

// ============ readTitleFromFrontmatter ============

describe('readTitleFromFrontmatter', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'cmd4bun-title-'));
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test('正常 buildFrontmatter 输出能提取 og:title', async () => {
        const f = join(tmpDir, 'normal.md');
        // 使用真实的 buildFrontmatter 函数,确保测试与生产代码一致
        const fm = buildFrontmatter('Hello World', 'hello', 'desc', '2026-04-07 14:31:49', 'https://example.com');
        writeFileSync(f, fm + '\n# body\n');
        expect(await readTitleFromFrontmatter(f)).toBe('Hello World');
    });

    test('无 frontmatter 块 → null', async () => {
        const f = join(tmpDir, 'no-frontmatter.md');
        writeFileSync(f, '# body\n');
        expect(await readTitleFromFrontmatter(f)).toBeNull();
    });

    test('无 og:title 字段 → null', async () => {
        const f = join(tmpDir, 'no-ogtitle.md');
        writeFileSync(f, '---\ndescription: x\n---\n# body\n');
        expect(await readTitleFromFrontmatter(f)).toBeNull();
    });

    test('buildFrontmatter title 含撇号 → 正确反转义', async () => {
        const f = join(tmpDir, 'apostrophe.md');
        // buildFrontmatter 会把 ' 转义为 ''(YAML 单引号字符串规则)
        const fm = buildFrontmatter("What's New", 'whats-new', 'desc', '2026-04-07 14:31:49', 'https://example.com');
        writeFileSync(f, fm + '\n# body\n');
        expect(await readTitleFromFrontmatter(f)).toBe("What's New");
    });

    test('文件不存在 → null', async () => {
        expect(await readTitleFromFrontmatter(join(tmpDir, 'nope.md'))).toBeNull();
    });
});

// ============ runDiffWith 端到端(用 tmpdir 隔离) ============

/**
 * 在 tmpdir 下建一个完整可跑的 runDiffWith 环境:
 *  - {tmp}/feishu/data/feishu.db  (DB,getDBPath 路径约定)
 *  - {tmp}/aim/                   (aimDirectory 目标目录)
 *  - {tmp}/cfg/cmd4bun/config.json  (config.json 模拟,设置 XDG_CONFIG_HOME 后位于 {XDG}/cmd4bun/)
 *
 * 返回 {root, outputDir, aimDir, cleanup};调用方负责 cleanup。
 */
function setupEnv(opts: {
    dbSetup?: (db: Database) => void;
    files?: { relPath: string; content?: string }[];
    config?: object;
}) {
    const root = mkdtempSync(join(tmpdir(), 'cmd4bun-diffwith-'));
    const outputDir = join(root, 'feishu');
    const aimDir = join(root, 'aim');
    const cfgCmd4bunDir = join(root, 'cfg', 'cmd4bun');

    mkdirSync(outputDir, { recursive: true });
    mkdirSync(aimDir, { recursive: true });
    mkdirSync(cfgCmd4bunDir, { recursive: true });

    // 初始化 DB(getDBPath 约定路径为 {outputDir}/data/feishu.db)
    const dbPath = join(outputDir, 'data', 'feishu.db');
    mkdirSync(join(outputDir, 'data'), { recursive: true });
    const db = new Database(dbPath);
    db.run(`CREATE TABLE nodes (
        node_token TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        title TEXT NOT NULL,
        obj_token TEXT NOT NULL,
        obj_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        "group" TEXT NOT NULL DEFAULT 'default',
        human_path TEXT,
        downloaded_at TEXT,
        is_ignore INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`CREATE TABLE spaces (
        space_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at TEXT
    )`);
    if (opts.dbSetup) opts.dbSetup(db);
    db.close();

    // 写 aimDirectory 文件
    if (opts.files) {
        for (const f of opts.files) {
            const abs = join(aimDir, f.relPath);
            mkdirSync(join(abs, '..'), { recursive: true });
            writeFileSync(abs, f.content ?? `# ${f.relPath}\n`);
        }
    }

    // 写 config.json(getConfigPath 约定在 {XDG}/cmd4bun/config.json)
    writeFileSync(
        join(cfgCmd4bunDir, 'config.json'),
        JSON.stringify(opts.config ?? {})
    );

    return {
        root,
        outputDir,
        aimDir,
        cleanup: () => { rmSync(root, { recursive: true, force: true }); }
    };
}

/** 捕获 console.log 输出,便于断言 */
function captureConsoleLog() {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
    };
    return {
        lines,
        restore: () => { console.log = orig; },
        text: () => lines.join('\n')
    };
}

/** 标准 frontmatter 模板:用 buildFrontmatter 生成,与生产代码一致 */
function fm(title: string, slug?: string): string {
    const s = slug ?? title.toLowerCase().replace(/\s+/g, '-');
    return buildFrontmatter(title, s, 'desc', '2026-04-07 14:31:49', 'https://example.com') + '\n# body\n';
}

describe('runDiffWith 端到端', () => {
    let origXdg: string | undefined;

    beforeEach(() => {
        origXdg = process.env.XDG_CONFIG_HOME;
    });
    afterEach(() => {
        closeDB();  // 关闭 db.ts 模块级单例
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = origXdg;
    });

    // ----- 场景 1:DB 不存在 -----
    test('场景 1:DB 不存在 → throw 提示先跑 sync', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cmd4bun-diffwith-'));
        const outputDir = join(root, 'feishu');
        mkdirSync(outputDir, { recursive: true });
        const args: DiffWithArgs = { output: outputDir, group: 'default' };

        let err: unknown;
        try {
            await runDiffWith(args);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/数据库不存在/);
        rmSync(root, { recursive: true, force: true });
    });

    // ----- 场景 2:位置参数 group 缺失(由 parse-args 校验,本测试模拟 throw) -----
    // 位置参数缺失校验在 parse-args 层,本流程测试不直接覆盖(parse-args 单测覆盖)
    // 这里只覆盖 runDiffWith 内部:收到 group='' 时的行为
    test('场景 2:group="" 走 GROUP_VALID_RE 校验 → throw 非法', async () => {
        const { root, outputDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'ot1', 'doc', 'a.md', 'default', 'a')`);
            }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');

        const args: DiffWithArgs = { output: outputDir, group: '' };
        let err: unknown;
        try {
            await runDiffWith(args);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/group 名.*非法/);

        cleanup();
    });

    // ----- 场景 3:位置参数 group 非法(大写) -----
    test('场景 3:group 名非法(大写)→ throw 提示命名规则', async () => {
        const { root, outputDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'ot1', 'doc', 'a.md', 'default', 'a')`);
            }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');

        const args: DiffWithArgs = { output: outputDir, group: 'Default' };
        let err: unknown;
        try {
            await runDiffWith(args);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/group 名.*非法/);

        cleanup();
    });

    // ----- 场景 4:位置参数 group 未配置 aimDirectory → throw -----
    test('场景 4:group 未配置 aimDirectory → throw', async () => {
        const { root, outputDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'ot1', 'doc', 'a.md', 'blog', 'a')`);
            },
            config: { feishu: { dir: './docs/feishu' } }  // 不配 aimDirectory
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');

        const args: DiffWithArgs = { output: outputDir, group: 'blog' };
        let err: unknown;
        try {
            await runDiffWith(args);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/未配置 group.*aimDirectory/);

        cleanup();
    });

    // ----- 场景 5:aimDirectory 目录不存在 → 0 输出 -----
    test('场景 5:aimDirectory 不存在 → 0 输出', async () => {
        const { root, outputDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'ot1', 'doc', 'a.md', 'default', 'a')`);
            },
            config: { feishu: { default: { aimDirectory: '/tmp/does-not-exist-xyz' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        // 0 个文件(findMdFiles 返回 [])，所以 0 标题匹配 0 警告
        expect(cap.text()).toMatch(/扫描 0 个文件, 列出 0 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 6:aimDirectory 空目录 → 0 输出 -----
    test('场景 6:aimDirectory 空目录 → 0 输出', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'ot1', 'doc', 'a.md', 'default', 'a')`);
            },
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        expect(cap.text()).toMatch(/扫描 0 个文件, 列出 0 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 7:L1 命中:DB 中有 human_path+group 匹配 → 静默 -----
    test('场景 7:L1 命中 → 静默,不出现在清单', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'MyTitle', 'ot1', 'doc', 'a.md', 'default', 'cover-me')`);
            },
            files: [{ relPath: 'cover-me.md', content: fm('MyTitle', 'cover-me') }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        // cover-me 不应出现在清单(因 L1 命中)
        expect(out).not.toMatch(/cover-me/);
        expect(out).toMatch(/扫描 1 个文件, 列出 0 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 8:L2 命中 1 个 → v3 改为输出(与 >=2 一致) -----
    test('场景 8:L2 命中 1 个 → 输出 title + 1 行 URL(v3 行为)', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                // DB 中节点 human_path=other-slug, 但 title="Ghost Title"
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('tokenA', 's1', 'Ghost Title', 'ot1', 'doc', 'a.md', 'default', 'other-slug')`);
            },
            files: [{ relPath: 'ghost-slug.md', content: fm('Ghost Title', 'ghost-slug') }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        // v3: 1 个匹配也输出(待用户自行判断)
        expect(out).toMatch(/\[default\] ghost-slug\.md — 标题 "Ghost Title" 匹配 1 个:/);
        expect(out).toMatch(/ {4}```yaml/);
        expect(out).toMatch(/ {4}slug: \/ghost-slug/);
        expect(out).toMatch(/ {4}```/);
        expect(out).toMatch(/https:\/\/feishu\.cn\/wiki\/tokenA/);
        expect(out).toMatch(/扫描 1 个文件, 列出 1 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 9:L2 多匹配:title 匹配 3 个 → 列出 + 3 行 URL -----
    test('场景 9:L2 命中 3 个 → 列出 + 3 行 URL', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('t1', 's1', 'SameTitle', 'o1', 'doc', 'a.md', 'default', 's1')`);
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('t2', 's1', 'SameTitle', 'o2', 'doc', 'b.md', 'blog', 's2')`);
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('t3', 's1', 'SameTitle', 'o3', 'doc', 'c.md', 'blog', 's3')`);
            },
            files: [{ relPath: 'some-slug.md', content: fm('SameTitle', 'some-slug') }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        expect(out).toMatch(/\[default\] some-slug\.md — 标题 "SameTitle" 匹配 3 个:/);
        expect(out).toMatch(/ {4}```yaml/);
        expect(out).toMatch(/ {4}slug: \/some-slug/);
        expect(out).toMatch(/ {4}```/);
        expect(out).toMatch(/https:\/\/feishu\.cn\/wiki\/t1/);
        expect(out).toMatch(/https:\/\/feishu\.cn\/wiki\/t2/);
        expect(out).toMatch(/https:\/\/feishu\.cn\/wiki\/t3/);
        expect(out).toMatch(/扫描 1 个文件, 列出 1 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 10:L2 跨 group 匹配(>=2 才展示) -----
    test('场景 10:L2 跨 group 命中 2 个 → 展示(>=2 才输出)', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                // 跨 group 同标题节点 2 个 → 触发"标题匹配 2 个"展示
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('blogToken', 's1', 'CrossTitle', 'o1', 'doc', 'a.md', 'blog', 'orig-slug')`);
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('defaultToken', 's1', 'CrossTitle', 'o2', 'doc', 'b.md', 'default', 'orig-slug-2')`);
            },
            files: [{ relPath: 'old-slug.md', content: fm('CrossTitle', 'old-slug') }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };  // 当前 group 是 default
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        expect(out).toMatch(/\[default\] old-slug\.md — 标题 "CrossTitle" 匹配 2 个:/);
        expect(out).toMatch(/ {4}```yaml/);
        expect(out).toMatch(/ {4}slug: \/old-slug/);
        expect(out).toMatch(/ {4}```/);
        expect(out).toMatch(/https:\/\/feishu\.cn\/wiki\/blogToken/);  // 跨 group 命中
        expect(out).toMatch(/https:\/\/feishu\.cn\/wiki\/defaultToken/);
        cleanup();
    });

    // ----- 场景 11:L3 无匹配:路径 + 标题都无 → 警告 -----
    test('场景 11:L3 无匹配 → 警告', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'OtherTitle', 'o1', 'doc', 'a.md', 'default', 'something-else')`);
            },
            files: [{ relPath: 'orphan.md', content: fm('UniqueOrphanTitle', 'orphan') }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        expect(out).toMatch(/\[default\] orphan\.md — 标题 "UniqueOrphanTitle" 无任何匹配/);
        expect(out).toMatch(/ {4}```yaml/);
        expect(out).toMatch(/ {4}slug: \/orphan/);
        expect(out).toMatch(/ {4}```/);
        expect(out).toMatch(/扫描 1 个文件, 列出 0 个待匹配, 警告 1 个/);
        cleanup();
    });

    // ----- 场景 12:frontmatter 缺失 → 警告 -----
    test('场景 12:frontmatter 缺失 → 警告"无法按标题反查"', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                // L1 不命中:DB 中 human_path 与文件名不同
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'o1', 'doc', 'a.md', 'default', 'other-path')`);
            },
            files: [{ relPath: 'no-fm.md', content: '# Just a body without frontmatter\n' }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        expect(out).toMatch(/\[default\] no-fm\.md — frontmatter 缺失,无法按标题反查/);
        expect(out).toMatch(/ {4}```yaml/);
        expect(out).toMatch(/ {4}slug: \/no-fm/);
        expect(out).toMatch(/ {4}```/);
        expect(out).toMatch(/扫描 1 个文件, 列出 0 个待匹配, 警告 1 个/);
        cleanup();
    });

    // ----- 场景 13:frontmatter 存在但 og:title 为空字符串 → 警告 -----
    test('场景 13:frontmatter title 为空 → 警告', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                // L1 不命中
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'o1', 'doc', 'a.md', 'default', 'other-slug')`);
            },
            // 手动写一个 og:title 为空的 frontmatter
            files: [{
                relPath: 'empty-title.md',
                content: "---\ndescription: ''\nhead:\n  - - meta\n    - name: 'og:title'\n      content: ''\n---\n"
            }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        expect(out).toMatch(/\[default\] empty-title\.md — frontmatter 缺失,无法按标题反查/);
        expect(out).toMatch(/ {4}```yaml/);
        expect(out).toMatch(/ {4}slug: \/empty-title/);
        expect(out).toMatch(/ {4}```/);
        expect(out).toMatch(/扫描 1 个文件, 列出 0 个待匹配, 警告 1 个/);
        cleanup();
    });

    // ----- 场景 14:aimDirectory 排除 images/ 与 data/ 子目录 -----
    test('场景 14:aimDirectory 排除 images/ 与 data/ 子目录', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'o1', 'doc', 'a.md', 'default', 'cover-me')`);
            },
            files: [
                { relPath: 'cover-me.md', content: fm('T', 'cover-me') },
                { relPath: 'images/orphan.png.md' },  // images/ 下的伪图片
                { relPath: 'data/dataset.md' }         // data/ 下的伪数据
            ],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        // images/ 与 data/ 子目录下的 .md 不应被处理
        expect(out).not.toMatch(/orphan\.png\.md/);
        expect(out).not.toMatch(/dataset\.md/);
        // cover-me 命中 DB,静默
        expect(out).not.toMatch(/cover-me/);
        expect(out).toMatch(/扫描 1 个文件, 列出 0 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 15a:L1 命中:DB human_path 带前导斜杠 → 也应静默 -----
    test('场景 15a:L1 命中(DB 带前导斜杠)→ 静默,不出现在清单', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                // 真实数据中 DB 的 human_path 可能带前导 '/'(历史 copy-docs 写入约定)
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'Cache', 'o1', 'doc', 'a.md', 'default', '/database/redis/ha/13-cache')`);
            },
            files: [{
                relPath: 'database/redis/ha/13-cache.md',
                content: fm('Cache', 'database/redis/ha/13-cache')
            }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        // L1 应识别 DB 带前导斜杠的人路径,不出现 "无任何匹配" 警告
        expect(out).not.toMatch(/无任何匹配/);
        expect(out).not.toMatch(/13-cache\.md — /);
        expect(out).toMatch(/扫描 1 个文件, 列出 0 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 15b:L1 命中:DB human_path 不带前导斜杠 → 静默(回归原行为) -----
    test('场景 15b:L1 命中(DB 不带前导斜杠)→ 静默', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'T', 'o1', 'doc', 'a.md', 'default', 'cover-no-slash')`);
            },
            files: [{ relPath: 'cover-no-slash.md', content: fm('T', 'cover-no-slash') }],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        expect(out).not.toMatch(/cover-no-slash/);
        expect(out).toMatch(/扫描 1 个文件, 列出 0 个待匹配, 警告 0 个/);
        cleanup();
    });

    // ----- 场景 15:多级子目录路径 → slug 正确解析 -----
    test('场景 15:多级子目录路径 → slug 正确解析', async () => {
        const { root, outputDir, aimDir, cleanup } = setupEnv({
            dbSetup: (db) => {
                // DB 中有 guide/install 的 L1 命中
                db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, "group", human_path)
                        VALUES ('n1', 's1', 'Install', 'o1', 'doc', 'a.md', 'default', 'guide/install')`);
            },
            files: [
                { relPath: 'guide/install.md', content: fm('Install', 'guide/install') },
                { relPath: 'guide/setup.md', content: fm('Setup', 'guide/setup') }
            ],
            config: { feishu: { default: { aimDirectory: '' } } }
        });
        process.env.XDG_CONFIG_HOME = join(root, 'cfg');
        writeFileSync(
            join(root, 'cfg', 'cmd4bun', 'config.json'),
            JSON.stringify({ feishu: { default: { aimDirectory: aimDir } } })
        );

        const cap = captureConsoleLog();
        const args: DiffWithArgs = { output: outputDir, group: 'default' };
        await runDiffWith(args);
        cap.restore();

        const out = cap.text();
        // guide/install 命中,静默
        expect(out).not.toMatch(/guide\/install/);
        // guide/setup title=Setup,无匹配,警告
        expect(out).toMatch(/\[default\] guide\/setup\.md — 标题 "Setup" 无任何匹配/);
        expect(out).toMatch(/ {4}```yaml/);
        expect(out).toMatch(/ {4}slug: \/guide\/setup/);
        expect(out).toMatch(/ {4}```/);
        expect(out).toMatch(/扫描 2 个文件, 列出 0 个待匹配, 警告 1 个/);
        cleanup();
    });
});

// 防止 TS 报 sep 未用 (测试用 sep 主要是为了文档)
void sep;
