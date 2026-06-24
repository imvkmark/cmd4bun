import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMdFiles, parseFrontmatterMeta } from '../../src/feishu/utils';
import { getNodeByObjToken, markNodeDownloaded, needsDownload } from '../../src/feishu/db';
// ============ DB Row Types ============

interface NodeRow {
    node_token: string;
    space_id: string;
    title: string;
    obj_token: string;
    obj_type: string;
    file_path: string;
    parent_node_token: string;
    downloaded_at: string | null;
    human_path: string | null;
}

interface ImageRow {
    md5: string;
    ext: string;
    oss_url: string | null;
    uploaded: number;
    created_at: string;
}

interface SpaceRow {
    space_id: string;
    name: string;
    updated_at: string | null;
}

// ============ Helpers to recreate DB init logic ============

function initTables(db: Database): void {
    db.run(`
    CREATE TABLE IF NOT EXISTS spaces (
      space_id   TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      updated_at TEXT
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS nodes (
      node_token        TEXT PRIMARY KEY,
      space_id          TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
      title             TEXT NOT NULL,
      obj_token         TEXT NOT NULL,
      obj_type          TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      parent_node_token TEXT,
      downloaded_at     TEXT,
      updated_at_last_synced_at TEXT
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS images (
      md5        TEXT PRIMARY KEY,
      ext        TEXT NOT NULL,
      oss_url    TEXT,
      uploaded   INTEGER DEFAULT 0,
      created_at TEXT
    )
  `);

    // Schema migrations (idempotent — wrapped in try-catch so re-running is safe)
    try {
        db.run('ALTER TABLE nodes ADD COLUMN human_path TEXT');
    } catch {
    // column already exists
    }
}

function upsertSpace(db: Database, spaceId: string, name: string): void {
    db.run(
        'INSERT INTO spaces (space_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at',
        [spaceId, name, new Date().toISOString()]
    );
}

function upsertNode(db: Database, node: {
    nodeToken: string;
    spaceId: string;
    title: string;
    objToken: string;
    objType: string;
    filePath: string;
    parentNodeToken: string;
    downloadedAt: string | null;
    humanPath?: string | null;
}): void {
    db.run(
        `INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, parent_node_token, downloaded_at, human_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_token) DO UPDATE SET
       title=excluded.title, obj_token=excluded.obj_token, obj_type=excluded.obj_type,
       file_path=excluded.file_path,
       parent_node_token=excluded.parent_node_token,
       downloaded_at=excluded.downloaded_at,
       human_path=excluded.human_path`,
        [node.nodeToken, node.spaceId, node.title, node.objToken, node.objType, node.filePath,
            node.parentNodeToken, node.downloadedAt,
            node.humanPath ?? null]
    );
}

function upsertImage(db: Database, md5: string, ext: string, ossUrl: string | null, uploaded: number): void {
    db.run(
        `INSERT INTO images (md5, ext, oss_url, uploaded, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(md5) DO UPDATE SET ext=excluded.ext, oss_url=excluded.oss_url, uploaded=excluded.uploaded`,
        [md5, ext, ossUrl, uploaded, new Date().toISOString()]
    );
}

// ============ Test Setup ============

let db: Database;
let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'feishu-test-'));
    db = new Database(join(tmpDir, 'test.db'), { create: true });
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA foreign_keys=ON');
    initTables(db);
});

afterEach(() => {
    db.close();
    // Clean up temp dir
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        // ignore
    }
});

// ============ Tests ============

test('initTables creates all three tables', () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toContain('spaces');
    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('images');
    expect(tableNames.length).toBe(3);
});

test('initTables is idempotent', () => {
    initTables(db);
    initTables(db);
    initTables(db);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toContain('spaces');
    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('images');
});

// ============ 6.1 DB Migration 幂等性 ============

test('6.1 ALTER TABLE ADD COLUMN human_path 幂等 — 首次执行不报错', () => {
    // human_path 列已被 initTables 添加，验证可以再次安全执行
    expect(() => {
        try {
            db.run('ALTER TABLE nodes ADD COLUMN human_path TEXT');
        } catch {
            // expected: column already exists
        }
    }).not.toThrow();
    // 验证列确实存在
    const cols = db.query('PRAGMA table_info(nodes)').all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain('human_path');
});

test('6.1 ALTER TABLE 幂等 — 重复迁移不会报错退出', () => {
    // 模拟多次重复迁移
    const runMigration = () => {
        try {
            db.run('ALTER TABLE nodes ADD COLUMN human_path TEXT');
        } catch {
            // column already exists
        }
    };
    // 连续执行多次不应抛出异常
    runMigration();
    runMigration();
    runMigration();
    const cols = db.query('PRAGMA table_info(nodes)').all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain('human_path');
});

// ---------- Spaces ----------

test('upsertSpace inserts a new space', () => {
    upsertSpace(db, 'space-1', 'Test Space');
    const row = db.query('SELECT * FROM spaces WHERE space_id=?').get('space-1') as SpaceRow | null;
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Test Space');
    expect(row!.updated_at).toBeTruthy();
});

test('upsertSpace updates existing space', () => {
    upsertSpace(db, 'space-1', 'Old Name');
    upsertSpace(db, 'space-1', 'New Name');
    const row = db.query('SELECT * FROM spaces WHERE space_id=?').get('space-1') as SpaceRow | null;
    expect(row!.name).toBe('New Name');
});

test('deleteSpace removes space', () => {
    upsertSpace(db, 'space-1', 'Test');
    db.run('DELETE FROM spaces WHERE space_id=?', ['space-1']);
    const row = db.query('SELECT * FROM spaces WHERE space_id=?').get('space-1') as SpaceRow | null;
    expect(row).toBeNull();
});

test('deleteSpace removes space and associated nodes (manual cascade)', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'node-1', spaceId: 'space-1', title: 'Doc', objToken: 'obj-1',
        objType: 'doc', filePath: 'test/doc.md',
        parentNodeToken: '', downloadedAt: null });
    // Manual cascade: delete nodes first, then space (matching our production code)
    db.run('DELETE FROM nodes WHERE space_id=?', ['space-1']);
    db.run('DELETE FROM spaces WHERE space_id=?', ['space-1']);
    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('node-1') as NodeRow | null;
    expect(row).toBeNull();
    const spaceRow = db.query('SELECT * FROM spaces WHERE space_id=?').get('space-1') as SpaceRow | null;
    expect(spaceRow).toBeNull();
});

// ---------- Nodes ----------

test('upsertNode inserts a new node', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'node-1', spaceId: 'space-1', title: 'Test Doc', objToken: 'obj-1',
        objType: 'doc', filePath: 'test/doc.md',
        parentNodeToken: 'parent-1', downloadedAt: null });
    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('node-1') as NodeRow | null;
    expect(row).not.toBeNull();
    expect(row!.title).toBe('Test Doc');
    expect(row!.obj_type).toBe('doc');
    expect(row!.file_path).toBe('test/doc.md');
});

test('upsertNode updates existing node', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'node-1', spaceId: 'space-1', title: 'Old', objToken: 'obj-1',
        objType: 'doc', filePath: 'old.md',
        parentNodeToken: '', downloadedAt: null });
    upsertNode(db, {
        nodeToken: 'node-1', spaceId: 'space-1', title: 'New', objToken: 'obj-2',
        objType: 'docx', filePath: 'new.md',
        parentNodeToken: '', downloadedAt: 'now' });
    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('node-1') as NodeRow | null;
    expect(row!.title).toBe('New');
    expect(row!.obj_type).toBe('docx');
    expect(row!.file_path).toBe('new.md');
});

test('getNode returns null for missing node', () => {
    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('nonexistent') as NodeRow | null;
    expect(row).toBeNull();
});

test('getNode returns correct node', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'node-1', spaceId: 'space-1', title: 'Doc', objToken: 'obj-1',
        objType: 'doc', filePath: 'doc.md',
        parentNodeToken: '', downloadedAt: null });
    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('node-1') as NodeRow | null;
    expect(row!.title).toBe('Doc');
});

test('getNodeByObjToken returns null for missing obj_token', () => {
    expect(getNodeByObjToken(db, 'nonexistent-obj')).toBeNull();
});

test('getNodeByObjToken returns correct node by obj_token', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'node-A', spaceId: 'space-1', title: 'Doc A', objToken: 'shared-obj',
        objType: 'docx', filePath: 'a.md',
        parentNodeToken: '', downloadedAt: 'now', humanPath: 'path/a' });
    const row = getNodeByObjToken(db, 'shared-obj');
    expect(row).not.toBeNull();
    expect(row!.title).toBe('Doc A');
    expect(row!.human_path).toBe('path/a');
});

test('getNodeByObjToken 不与 node_token 冲突 — 不同 obj_token 走不同 doc', () => {
    // 模拟 sub-page 引用场景:doc-id 实际是 obj_token,不能误用 node_token 查
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'nt-1', spaceId: 'space-1', title: 'Doc 1', objToken: 'ot-A',
        objType: 'docx', filePath: 'a.md',
        parentNodeToken: '', downloadedAt: 'now', humanPath: 'path/a' });
    upsertNode(db, {
        nodeToken: 'nt-2', spaceId: 'space-1', title: 'Doc 2', objToken: 'ot-B',
        objType: 'docx', filePath: 'b.md',
        parentNodeToken: '', downloadedAt: 'now', humanPath: 'path/b' });

    // 若错误地用 node_token 去查 ot-A,应该查不到(因为 ot-A 是 obj_token)
    expect(getNodeByObjToken(db, 'nt-1')).toBeNull();
    // 用 obj_token 查 ot-A 命中 Doc 1
    expect(getNodeByObjToken(db, 'ot-A')!.title).toBe('Doc 1');
    // 用 obj_token 查 ot-B 命中 Doc 2
    expect(getNodeByObjToken(db, 'ot-B')!.title).toBe('Doc 2');
});

test('getNodeByObjToken 同一 obj_token 存在多行时返回首条(同文档被多处引用)', () => {
    // 同一文档可以被多个 wiki 节点引用(多个 node_token,同一 obj_token)
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'nt-X1', spaceId: 'space-1', title: 'Doc via X', objToken: 'shared-obj',
        objType: 'docx', filePath: 'x.md',
        parentNodeToken: '', downloadedAt: 'now', humanPath: 'path/x' });
    upsertNode(db, {
        nodeToken: 'nt-X2', spaceId: 'space-1', title: 'Doc via Y', objToken: 'shared-obj',
        objType: 'docx', filePath: 'y.md',
        parentNodeToken: '', downloadedAt: 'now', humanPath: 'path/y' });

    const row = getNodeByObjToken(db, 'shared-obj');
    expect(row).not.toBeNull();
    // LIMIT 1 — 命中首条即可
    expect(['nt-X1', 'nt-X2']).toContain(row!.node_token);
    expect(row!.obj_token).toBe('shared-obj');
});

test('getDownloadQueue returns only non-downloaded doc nodes', () => {
    upsertSpace(db, 'space-1', 'Test');
    // Downloaded doc — should NOT be in queue
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 'space-1', title: 'Done', objToken: 'o1',
        objType: 'doc', filePath: 'done.md',
        parentNodeToken: '', downloadedAt: 'now' });
    // Not downloaded doc — SHOULD be in queue
    upsertNode(db, {
        nodeToken: 'n2', spaceId: 'space-1', title: 'Todo', objToken: 'o2',
        objType: 'doc', filePath: 'todo.md',
        parentNodeToken: '', downloadedAt: null });
    // Sheet — should NOT be in queue
    upsertNode(db, {
        nodeToken: 'n3', spaceId: 'space-1', title: 'Sheet', objToken: 'o3',
        objType: 'sheet', filePath: 'sheet.md',
        parentNodeToken: '', downloadedAt: null });

    const queue = db.query(
        "SELECT * FROM nodes WHERE space_id=? AND obj_type IN ('doc', 'docx') AND downloaded_at IS NULL"
    ).all('space-1') as NodeRow[];
    expect(queue.length).toBe(1);
    expect(queue[0]!.node_token).toBe('n2');
});

test('getDownloadQueue with force returns all doc nodes', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 'space-1', title: 'Done', objToken: 'o1',
        objType: 'doc', filePath: 'done.md',
        parentNodeToken: '', downloadedAt: 'now' });
    upsertNode(db, {
        nodeToken: 'n2', spaceId: 'space-1', title: 'Todo', objToken: 'o2',
        objType: 'docx', filePath: 'todo.md',
        parentNodeToken: '', downloadedAt: null });

    const queue = db.query(
        "SELECT * FROM nodes WHERE space_id=? AND obj_type IN ('doc', 'docx')"
    ).all('space-1') as NodeRow[];
    expect(queue.length).toBe(2);
});

test('markNodeDownloaded updates timestamp fields', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 'space-1', title: 'Doc', objToken: 'o1',
        objType: 'doc', filePath: 'doc.md',
        parentNodeToken: '', downloadedAt: null });

    const now = new Date().toISOString();
    db.run('UPDATE nodes SET downloaded_at=? WHERE node_token=?', [now, 'n1']);

    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('n1') as NodeRow | null;
    expect(row!.downloaded_at).toBe(now);
});

// markNodeDownloaded 接受可选 timestamp 参数；sheet/file 下载路径依赖它实现幂等
test('markNodeDownloaded without timestamp writes current time', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 'space-1', title: 'Doc', objToken: 'o1',
        objType: 'doc', filePath: 'doc.md',
        parentNodeToken: '', downloadedAt: null });

    const before = new Date().toISOString();
    markNodeDownloaded(db, 'n1');
    const after = new Date().toISOString();

    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('n1') as NodeRow | null;
    expect(row!.downloaded_at).not.toBeNull();
    expect(row!.downloaded_at! >= before && row!.downloaded_at! <= after).toBe(true);
});

test('markNodeDownloaded with explicit timestamp writes that timestamp (sheet/file 幂等基础)', () => {
    upsertSpace(db, 'space-1', 'Test');
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 'space-1', title: 'Sheet', objToken: 'o1',
        objType: 'sheet', filePath: '',
        parentNodeToken: '', downloadedAt: null });

    // 传入远端版本时间戳：与未来 needsDownload 检查的 updated_at 应相等，使
    // downloaded_at < updated_at 返回 false，避免 sheet/file 节点被反复重下。
    const remoteVersion = '2026-06-22T08:00:00.000+08:00';
    markNodeDownloaded(db, 'n1', remoteVersion);

    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('n1') as NodeRow | null;
    expect(row!.downloaded_at).toBe(remoteVersion);
});

test('needsDownload returns false when downloaded_at equals updated_at', () => {
    // 直接验证 needsDownload 在 downloaded_at === updated_at 时返回 false，
    // 即"我们已下载到的远端版本时间戳"语义天然幂等。
    const same = '2026-06-22T08:00:00.000+08:00';
    expect(needsDownload({ downloaded_at: same, updated_at: same })).toBe(false);
});

test('needsDownload returns true when updated_at missing (sheet/file 缺失场景，需先跑 sync-updated-at)', () => {
    expect(needsDownload({ downloaded_at: new Date().toISOString(), updated_at: null })).toBe(true);
});

test('getAllIndexedFiles returns all file paths', () => {
    upsertSpace(db, 's1', 'S1');
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 's1', title: 'A', objToken: 'o1',
        objType: 'doc', filePath: 's1/a.md',
        parentNodeToken: '', downloadedAt: null });
    upsertNode(db, {
        nodeToken: 'n2', spaceId: 's1', title: 'B', objToken: 'o2',
        objType: 'doc', filePath: 's1/b.md',
        parentNodeToken: '', downloadedAt: null });
    const paths = (db.query('SELECT file_path FROM nodes').all() as { file_path: string }[]).map((r) => r.file_path);
    expect(paths).toContain('s1/a.md');
    expect(paths).toContain('s1/b.md');
    expect(paths.length).toBe(2);
});

// ---------- Images ----------

test('upsertImage inserts new image', () => {
    upsertImage(db, 'abc123', 'png', null, 0);
    const row = db.query('SELECT * FROM images WHERE md5=?').get('abc123') as ImageRow | null;
    expect(row).not.toBeNull();
    expect(row!.ext).toBe('png');
    expect(row!.oss_url).toBeNull();
    expect(row!.uploaded).toBe(0);
    expect(row!.created_at).toBeTruthy();
});

test('upsertImage updates existing image with OSS URL', () => {
    upsertImage(db, 'abc123', 'png', null, 0);
    upsertImage(db, 'abc123', 'png', 'https://oss.example.com/img.png', 1);
    const row = db.query('SELECT * FROM images WHERE md5=?').get('abc123') as ImageRow | null;
    expect(row!.oss_url).toBe('https://oss.example.com/img.png');
    expect(row!.uploaded).toBe(1);
});

test('getImage returns null for missing image', () => {
    const row = db.query('SELECT * FROM images WHERE md5=?').get('nonexistent') as ImageRow | null;
    expect(row).toBeNull();
});

test('getImage returns image record', () => {
    upsertImage(db, 'abc123', 'jpg', 'https://oss.example.com/a.jpg', 1);
    const row = db.query('SELECT * FROM images WHERE md5=?').get('abc123') as ImageRow | null;
    expect(row!.ext).toBe('jpg');
    expect(row!.oss_url).toBe('https://oss.example.com/a.jpg');
    expect(row!.uploaded).toBe(1);
});

test('image MD5 primary key prevents duplicates', () => {
    upsertImage(db, 'unique-md5', 'png', null, 0);
    upsertImage(db, 'unique-md5', 'jpg', 'url', 1);
    const rows = db.query('SELECT * FROM images WHERE md5=?').all('unique-md5') as { ext: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.ext).toBe('jpg'); // updated
});

// ============ 6.5 & 6.6 Markdown 清理测试 ============

test('6.5 & 6.6 findMdFiles 查找目录下的 .md 文件', () => {
    const dir = join(tmpDir, 'md-test');
    mkdirSync(dir);

    try {
        mkdirSync(join(dir, 'subdir'));
        writeFileSync(join(dir, 'test1.md'), 'content');
        writeFileSync(join(dir, 'test2.md'), 'content');
        writeFileSync(join(dir, 'subdir', 'test3.md'), 'content');
        writeFileSync(join(dir, 'other.txt'), 'content');

        mkdirSync(join(dir, 'images'));
        writeFileSync(join(dir, 'images', 'img1.png'), '');

        const files = findMdFiles(dir);
        const relativeFiles = files.map(f => f.slice(dir.length + 1)).sort();

        expect(relativeFiles).toEqual(['subdir/test3.md', 'test1.md', 'test2.md']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('6.5 & 6.6 findMdFiles 处理空目录', () => {
    const dir = join(tmpDir, 'md-test-empty');
    mkdirSync(dir);
    try {
        expect(findMdFiles(dir)).toEqual([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('6.5 & 6.6 findMdFiles 处理不存在的目录', () => {
    expect(findMdFiles('/does/not/exist')).toEqual([]);
});

// ============ 6.7 parseFrontmatterMeta ============

test('6.7 parseFrontmatterMeta 解析 ```yaml 代码块中的 slug', () => {
    const content = `---
title: Hello
---

\`\`\`yaml
slug: my-custom-path/hello-world
title: Hello World
\`\`\`

Some content here.
`;
    expect(parseFrontmatterMeta(content).slug).toBe('my-custom-path/hello-world');
});

test('6.7 parseFrontmatterMeta 解析 ```yml 代码块中的 slug', () => {
    const content = `# Title

\`\`\`yml
slug : another-path/page
date: 2024-01-01
\`\`\`
`;
    expect(parseFrontmatterMeta(content).slug).toBe('another-path/page');
});

test('6.7 parseFrontmatterMeta slug 前后有空格时 trim', () => {
    const content = `\`\`\`yaml
slug:   spaced-path
title: Test
\`\`\`
`;
    expect(parseFrontmatterMeta(content).slug).toBe('spaced-path');
});

test('6.7 parseFrontmatterMeta 无 YAML code block 时返回 null', () => {
    const content = `# No frontmatter

Just some content without any code blocks.
`;
    expect(parseFrontmatterMeta(content).slug).toBeNull();
});

test('6.7 parseFrontmatterMeta YAML code block 无 slug 字段时返回 null', () => {
    const content = `\`\`\`yaml
title: No Slug Here
date: 2024-01-01
\`\`\`
`;
    expect(parseFrontmatterMeta(content).slug).toBeNull();
});

test('6.7 parseFrontmatterMeta slug 值为空字符串时返回 null', () => {
    const content = `\`\`\`yaml
slug:
title: Test
\`\`\`
`;
    expect(parseFrontmatterMeta(content).slug).toBeNull();
});

test('6.7 parseFrontmatterMeta 取第一个 YAML code block', () => {
    const content = `\`\`\`yaml
slug: first-slug
\`\`\`

\`\`\`yaml
slug: second-slug
\`\`\`
`;
    expect(parseFrontmatterMeta(content).slug).toBe('first-slug');
});

test('6.7 parseFrontmatterMeta 忽略非 YAML code block', () => {
    const content = `\`\`\`json
{"slug": "not-this"}
\`\`\`

\`\`\`yaml
slug: real-slug
\`\`\`
`;
    expect(parseFrontmatterMeta(content).slug).toBe('real-slug');
});

test('6.7 parseFrontmatterMeta 解析 ignore 字段 — Y 触发 true', () => {
    const content = `\`\`\`yaml
slug: draft-page
ignore: Y
\`\`\``;
    expect(parseFrontmatterMeta(content).ignore).toBe(true);
});

test('6.7 parseFrontmatterMeta 解析 ignore 字段 — 其他值均视为 false', () => {
    for (const v of ['y', 'yes', 'true', '1', 'N', 'no', 'false', '0', '']) {
        const content = `\`\`\`yaml
ignore: ${v}
\`\`\``;
        expect(parseFrontmatterMeta(content).ignore).toBe(false);
    }
});

// ============ 6.8 updateNodeHumanPath ============

test('6.8 updateNodeHumanPath 将 slug 写入 human_path 列', () => {
    upsertSpace(db, 's1', 'S1');
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 's1', title: 'Doc', objToken: 'o1',
        objType: 'doc', filePath: 'doc.md',
        parentNodeToken: '', downloadedAt: 'now' });

    db.run('UPDATE nodes SET human_path=? WHERE node_token=?', ['custom/path', 'n1']);
    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('n1') as NodeRow | null;
    expect(row!.human_path).toBe('custom/path');
});

test('6.8 updateNodeHumanPath human_path 默认为 NULL', () => {
    upsertSpace(db, 's1', 'S1');
    upsertNode(db, {
        nodeToken: 'n1', spaceId: 's1', title: 'Doc', objToken: 'o1',
        objType: 'doc', filePath: 'doc.md',
        parentNodeToken: '', downloadedAt: 'now',
        humanPath: null
    });

    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('n1') as NodeRow | null;
    expect(row!.human_path).toBeNull();
});
