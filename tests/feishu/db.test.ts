// 飞书数据库操作单元测试
import { test, expect, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    needsDownload,
    ensureDB,
    updateNodeUpdatedAt,
    updateNodeIgnore,
    updateNodeGroup,
    getNode,
    purgeOrphanNodes,
    incrementNodePriority,
    getDownloadQueue,
    getAllIndexedFiles
} from '../../src/feishu/db';

// ============ needsDownload ============

describe('needsDownload', () => {
    const pastIso = '2026-01-01T00:00:00.000Z';       // 2026-01-01
    const futureIso = '2026-05-04T04:00:00.000Z';      // 2026-05-04
    const laterIso = '2026-06-01T00:00:00.000Z';       // 2026-06-01
    const veryOldIso = '2025-01-01T00:00:00.000Z';     // 2025-01-01

    test('从未下载的节点应需要下载', () => {
        expect(needsDownload({ downloaded_at: null, updated_at: futureIso })).toBe(true);
    });

    test('downloaded_at 早于 updated_at 时应需要下载', () => {
    // downloaded_at 2026-01-01 < updated_at 2026-05-04
        expect(needsDownload({ downloaded_at: pastIso, updated_at: futureIso })).toBe(true);
    });

    test('downloaded_at 不早于 updated_at 时应不需要下载', () => {
    // downloaded_at 2026-01-01 >= updated_at 2026-01-01 (相等)
        expect(needsDownload({ downloaded_at: pastIso, updated_at: pastIso })).toBe(false);
    });

    test('updated_at 为 NULL 时应需要下载', () => {
        expect(needsDownload({ downloaded_at: pastIso, updated_at: null })).toBe(true);
    });

    test('updated_at 为空字符串时应需要下载', () => {
        expect(needsDownload({ downloaded_at: pastIso, updated_at: '' })).toBe(true);
    });

    test('downloaded_at 格式异常时应需要下载（NaN 安全）', () => {
        expect(needsDownload({ downloaded_at: 'invalid-date', updated_at: futureIso })).toBe(true);
    });

    test('updated_at 格式异常时应需要下载（NaN 安全）', () => {
        expect(needsDownload({ downloaded_at: pastIso, updated_at: 'not-a-date' })).toBe(true);
    });

    test('downloaded_at 和 updated_at 均为空时应需要下载', () => {
        expect(needsDownload({ downloaded_at: null, updated_at: null })).toBe(true);
    });

    test('downloaded_at 远早于 updated_at 时应需要下载', () => {
        expect(needsDownload({ downloaded_at: veryOldIso, updated_at: futureIso })).toBe(true);
    });

    test('downloaded_at 晚于 updated_at 时应不需要下载', () => {
        expect(needsDownload({ downloaded_at: laterIso, updated_at: pastIso })).toBe(false);
    });
});

// ============ ensureDB ============

describe('ensureDB', () => {
    function createDB(): Database {
        const db = new Database(':memory:');
        db.run('PRAGMA foreign_keys=ON');
        return db;
    }

    test('核心表全部存在时不报错', () => {
        const db = createDB();
        db.run('CREATE TABLE spaces (space_id TEXT PRIMARY KEY)');
        db.run('CREATE TABLE nodes (node_token TEXT PRIMARY KEY)');
        db.run('CREATE TABLE images (md5 TEXT PRIMARY KEY)');
        db.run('CREATE TABLE image_vs_node (md5 TEXT, node_token TEXT, PRIMARY KEY (md5, node_token))');
        expect(() => {
            ensureDB(db);
        }).not.toThrow();
    });

    test('缺失核心表时抛出错误', () => {
        const db = createDB();
        expect(() => {
            ensureDB(db);
        }).toThrow(/init-db/);
    });

    test('部分缺失时只报告缺失的表', () => {
        const db = createDB();
        db.run('CREATE TABLE spaces (space_id TEXT PRIMARY KEY)');
        expect(() => {
            ensureDB(db);
        }).toThrow(/nodes.*images/);
        expect(() => {
            ensureDB(db);
        }).not.toThrow(/spaces/);
    });
});

// ============ updateNodeUpdatedAt ============

describe('updateNodeUpdatedAt', () => {
    function createDB(): Database {
        const db = new Database(':memory:');
        db.run(`CREATE TABLE nodes (
      node_token TEXT PRIMARY KEY, space_id TEXT, title TEXT,
      obj_token TEXT, obj_type TEXT, file_path TEXT,
      parent_node_token TEXT,
      downloaded_at TEXT,
      human_path TEXT,
      description TEXT,
      updated_at TEXT, updated_at_last_synced_at TEXT
    )`);
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T', 'ot', 'doc', 't.md')");
        return db;
    }

    test('写入并读取 updated_at', () => {
        const db = createDB();
        updateNodeUpdatedAt(db, 'n1', '2026-06-01T00:00:00Z');
        const node = getNode(db, 'n1');
        expect(node!.updated_at).toBe('2026-06-01T00:00:00Z');
    });

    test('初始状态 updated_at 为 null', () => {
        const db = createDB();
        const node = getNode(db, 'n1');
        expect(node!.updated_at).toBeNull();
    });

    test('写入 updated_at 时同步写入 updated_at_last_synced_at', () => {
        const db = createDB();
        updateNodeUpdatedAt(db, 'n1', '2026-06-01T00:00:00Z');
        const node = getNode(db, 'n1');
        expect(node!.updated_at).toBe('2026-06-01T00:00:00Z');
        expect(node!.updated_at_last_synced_at).not.toBeNull();
        // 应该是最近几秒内的 ISO 时间戳
        const syncedAt = new Date(node!.updated_at_last_synced_at!).getTime();
        const now = Date.now();
        expect(Math.abs(now - syncedAt)).toBeLessThan(5000);
    });
});

// ============ scanned_at ============

describe('scanned_at', () => {
    function createDB(): Database {
        const db = new Database(':memory:');
        db.run(`CREATE TABLE nodes (
      node_token TEXT PRIMARY KEY, space_id TEXT, title TEXT,
      obj_token TEXT, obj_type TEXT, file_path TEXT,
      parent_node_token TEXT,
      downloaded_at TEXT,
      human_path TEXT,
      description TEXT,
      updated_at TEXT, updated_at_last_synced_at TEXT,
      scanned_at TEXT
    )`);
        return db;
    }

    test('getNode 能正确读取 scanned_at 字段', () => {
        const db = createDB();
        const now = new Date().toISOString();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, scanned_at) VALUES ('n1', 's1', 'T', 'ot', 'doc', 't.md', ?)", [now]);
        const node = getNode(db, 'n1');
        expect(node!.scanned_at).toBe(now);
    });

    test('sync 写入 scanned_at — upsert 后不为 null 且时间接近当前时间', () => {
        const db = createDB();
        const now = new Date().toISOString();

        // 模拟 sync 阶段的 upsert 行为
        db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at, updated_at_last_synced_at, scanned_at, parent_node_token, downloaded_at, human_path)
      VALUES ('n1', 's1', 'T', 'ot', 'doc', 't.md', NULL, NULL, ?, NULL, NULL, NULL)
      ON CONFLICT(node_token) DO UPDATE SET
        title=excluded.title, obj_token=excluded.obj_token, obj_type=excluded.obj_type,
        file_path=excluded.file_path, updated_at=excluded.updated_at,
        updated_at_last_synced_at=excluded.updated_at_last_synced_at,
        scanned_at=excluded.scanned_at,
        parent_node_token=excluded.parent_node_token,
        downloaded_at=excluded.downloaded_at,
        human_path=excluded.human_path`,
        [now]);

        const node = getNode(db, 'n1');
        expect(node!.scanned_at).not.toBeNull();
        const scannedMs = new Date(node!.scanned_at!).getTime();
        expect(Math.abs(Date.now() - scannedMs)).toBeLessThan(5000);
    });

    test('存量数据兼容 — 迁移前插入的节点 scanned_at 为 null', () => {
        const db = createDB();
        // 模拟迁移前插入的节点（不含 scanned_at 列或其值为 NULL）
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n2', 's1', 'T2', 'ot2', 'doc', 't2.md')");
        const node = getNode(db, 'n2');
        expect(node!.scanned_at).toBeNull();
    });
});

// ============ purgeOrphanNodes ============

function setupPurgeTestDb(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE nodes (
    node_token TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    title TEXT NOT NULL,
    obj_token TEXT NOT NULL,
    obj_type TEXT NOT NULL,
    file_path TEXT NOT NULL
  )`);
    db.run('CREATE TABLE images (md5 TEXT PRIMARY KEY, ext TEXT, oss_url TEXT, uploaded INTEGER, created_at TEXT)');
    db.run('CREATE TABLE image_vs_node (md5 TEXT, node_token TEXT, PRIMARY KEY (md5, node_token))');
    return db;
}

describe('purgeOrphanNodes', () => {
    test('传入空数组应短路返回，nodes 表无变化', () => {
        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        const result = purgeOrphanNodes(db, [], '/tmp', null);
        expect(result.filePaths).toEqual([]);
        const remaining = db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
        expect(remaining.c).toBe(1);
    });

    test('删除传入 token 对应的 nodes 行，其他 nodes 保留', () => {
        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        db.run("INSERT INTO nodes VALUES ('n2', 's1', 'T2', 'ot2', 'doc', 'b.md')");
        db.run("INSERT INTO nodes VALUES ('n3', 's1', 'T3', 'ot3', 'doc', 'c.md')");

        const result = purgeOrphanNodes(db, ['n1', 'n2'], '/tmp', null);

        const remaining = db.query('SELECT node_token FROM nodes').all() as { node_token: string }[];
        expect(remaining.map((r) => r.node_token)).toEqual(['n3']);
        expect(result.filePaths.sort()).toEqual(['a.md', 'b.md']);
    });

    test('通过 cleanupOrphanImages 副作用清空 images 行（ossConfig=null 避免 OSS 调用）', () => {
        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        db.run("INSERT INTO images VALUES ('md5_a', 'png', NULL, 0, NULL)");
        db.run("INSERT INTO image_vs_node VALUES ('md5_a', 'n1')");
        db.run("INSERT INTO images VALUES ('md5_b', 'jpg', NULL, 0, NULL)");
        db.run("INSERT INTO image_vs_node VALUES ('md5_b', 'n1')");

        purgeOrphanNodes(db, ['n1'], '/tmp', null);

        const remaining = db.query('SELECT COUNT(*) AS c FROM images').get() as { c: number };
        expect(remaining.c).toBe(0);
    });

    test('删除本地 .md 文件', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'purge-'));
        const mdPath = join(tmpDir, 'orphan.md');
        writeFileSync(mdPath, '# content');

        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'orphan.md')");

        purgeOrphanNodes(db, ['n1'], tmpDir, null);

        expect(existsSync(mdPath)).toBe(false);

        rmSync(tmpDir, { recursive: true, force: true });
    });

    test('磁盘文件不存在时仍清 DB 行，返回的 filePaths 保留记录', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'purge-'));
        // 故意不创建文件

        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'ghost.md')");

        const result = purgeOrphanNodes(db, ['n1'], tmpDir, null);

        // filePaths 反映 DB 记录，不是磁盘实际状态
        expect(result.filePaths).toEqual(['ghost.md']);
        const remaining = db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
        expect(remaining.c).toBe(0);

        rmSync(tmpDir, { recursive: true, force: true });
    });

    test('占位符 SQL 应正确处理含特殊字符的 token', () => {
        const db = setupPurgeTestDb();
        // 含 ' 和 " 的 token
        db.run('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)', ['a\'b"c', 's1', 'T1', 'ot1', 'doc', 'a.md']);

        // 不应抛 SQL 语法错误
        const result = purgeOrphanNodes(db, ['a\'b"c'], '/tmp', null);
        expect(result.filePaths).toEqual(['a.md']);
        const remaining = db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
        expect(remaining.c).toBe(0);
    });

    test('多节点批量清理 — 所有节点和关联 images 全部清空', () => {
        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        db.run("INSERT INTO nodes VALUES ('n2', 's1', 'T2', 'ot2', 'doc', 'b.md')");
        db.run("INSERT INTO images VALUES ('md5_a', 'png', NULL, 0, NULL)");
        db.run("INSERT INTO image_vs_node VALUES ('md5_a', 'n1')");
        db.run("INSERT INTO images VALUES ('md5_b', 'jpg', NULL, 0, NULL)");
        db.run("INSERT INTO image_vs_node VALUES ('md5_b', 'n2')");

        purgeOrphanNodes(db, ['n1', 'n2'], '/tmp', null);

        const nodeCount = (db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
        const imageCount = (db.query('SELECT COUNT(*) AS c FROM images').get() as { c: number }).c;
        expect(nodeCount).toBe(0);
        expect(imageCount).toBe(0);
    });

    test('空 file_path 占位节点不应触发 join(outputDir, "") 误删 outputDir', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'purge-empty-'));
        // 创建空 file_path 占位节点（模拟非 doc/docx 节点，schema NOT NULL 用空串占位）
        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'sheet', '')");

        purgeOrphanNodes(db, ['n1'], tmpDir, null);

        // outputDir 应完整保留，不能因为 join(outputDir, '') == outputDir 被误删
        expect(existsSync(tmpDir)).toBe(true);
        const remaining = db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
        expect(remaining.c).toBe(0);

        rmSync(tmpDir, { recursive: true, force: true });
    });

    test('混合正常与空 file_path 节点：只删正常的文件路径', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'purge-mixed-'));
        const mdPath = join(tmpDir, 'real.md');
        writeFileSync(mdPath, '# content');

        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'real.md')");
        db.run("INSERT INTO nodes VALUES ('n2', 's1', 'T2', 'ot2', 'sheet', '')");

        const result = purgeOrphanNodes(db, ['n1', 'n2'], tmpDir, null);

        expect(result.filePaths).toEqual(['real.md']);
        expect(existsSync(mdPath)).toBe(false);

        rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe('getAllIndexedFiles 过滤空 file_path', () => {
    test('空 file_path 占位节点不应出现在索引文件集合中', () => {
        const db = setupPurgeTestDb();
        db.run("INSERT INTO nodes VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'real.md')");
        db.run("INSERT INTO nodes VALUES ('n2', 's1', 'T2', 'ot2', 'sheet', '')");

        const files = getAllIndexedFiles(db);

        expect(files.has('real.md')).toBe(true);
        expect(files.has('')).toBe(false);
        expect(files.size).toBe(1);
    });
});

// ============ incrementNodePriority ============

function setupPriorityTestDb(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE nodes (
    node_token TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    title TEXT NOT NULL,
    obj_token TEXT NOT NULL,
    obj_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0
  )`);
    return db;
}

describe('incrementNodePriority', () => {
    test('单次 +1 — priority 从 0 升到 1', () => {
        const db = setupPriorityTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        incrementNodePriority(db, 'n1');
        const row = db.query('SELECT priority FROM nodes WHERE node_token=?').get('n1') as { priority: number };
        expect(row.priority).toBe(1);
    });

    test('多次累加 — 连续 3 次调用从 0 升到 3', () => {
        const db = setupPriorityTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        incrementNodePriority(db, 'n1');
        incrementNodePriority(db, 'n1');
        incrementNodePriority(db, 'n1');
        const row = db.query('SELECT priority FROM nodes WHERE node_token=?').get('n1') as { priority: number };
        expect(row.priority).toBe(3);
    });

    test('不存在的 node_token — UPDATE 影响 0 行，不抛错', () => {
        const db = setupPriorityTestDb();
        // 不插入任何 node
        expect(() => {
            incrementNodePriority(db, 'ghost');
        }).not.toThrow();
        const count = (db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
        expect(count).toBe(0);
    });

    test('已存在的 priority>0 — 从 5 升到 6', () => {
        const db = setupPriorityTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, priority) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md', 5)");
        incrementNodePriority(db, 'n1');
        const row = db.query('SELECT priority FROM nodes WHERE node_token=?').get('n1') as { priority: number };
        expect(row.priority).toBe(6);
    });
});

// ============ getDownloadQueue ============

function setupQueueTestDb(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE nodes (
    node_token TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    title TEXT NOT NULL,
    obj_token TEXT NOT NULL,
    obj_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    parent_node_token TEXT,
    updated_at TEXT,
    downloaded_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0
  )`);
    return db;
}

describe('getDownloadQueue', () => {
    test('同 parent_node_token 组内按 priority DESC, node_token ASC 排序', () => {
        const db = setupQueueTestDb();
        // n1 priority=0, n2 priority=5, n3 priority=5, n4 priority=2
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, priority) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md', 0)");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, priority) VALUES ('n2', 's1', 'T2', 'ot2', 'doc', 'b.md', 5)");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, priority) VALUES ('n3', 's1', 'T3', 'ot3', 'doc', 'c.md', 5)");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, priority) VALUES ('n4', 's1', 'T4', 'ot4', 'doc', 'd.md', 2)");

        const queue = getDownloadQueue(db, ['s1'], true);
        expect(queue.map((n) => n.node_token)).toEqual(['n2', 'n3', 'n4', 'n1']);
    });

    test('force=true 时不过滤 — 返回所有 doc/docx 节点', () => {
        const db = setupQueueTestDb();
        // downloaded_at >= updated_at 状态（已最新）
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at, downloaded_at) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md', '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z')");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at, downloaded_at) VALUES ('n2', 's1', 'T2', 'ot2', 'doc', 'b.md', '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z')");

        const queue = getDownloadQueue(db, ['s1'], true);
        expect(queue.length).toBe(2);
    });

    test('force=false 时仅返回 needsDownload=true 的节点', () => {
        const db = setupQueueTestDb();
        // n1: 已最新（downloaded_at >= updated_at）→ 跳过
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at, downloaded_at) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md', '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z')");
        // n2: 远端有更新（downloaded_at < updated_at）→ 需重下
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at, downloaded_at) VALUES ('n2', 's1', 'T2', 'ot2', 'doc', 'b.md', '2026-06-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')");
        // n3: downloaded_at 为空 → 需重下
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at, downloaded_at) VALUES ('n3', 's1', 'T3', 'ot3', 'doc', 'c.md', NULL, NULL)");

        const queue = getDownloadQueue(db, ['s1'], false);
        expect(queue.map((n) => n.node_token).sort()).toEqual(['n2', 'n3']);
    });
});

// ============ updateNodeIgnore ============

function setupIgnoreTestDb(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE nodes (
    node_token TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    title TEXT NOT NULL,
    obj_token TEXT NOT NULL,
    obj_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    human_path TEXT,
    downloaded_at TEXT,
    is_ignore INTEGER NOT NULL DEFAULT 0
  )`);
    return db;
}

describe('updateNodeIgnore', () => {
    test('写入 1 — is_ignore 从 0 升到 1', () => {
        const db = setupIgnoreTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        updateNodeIgnore(db, 'n1', 1);
        const row = db.query('SELECT is_ignore FROM nodes WHERE node_token=?').get('n1') as { is_ignore: number };
        expect(row.is_ignore).toBe(1);
    });

    test('写入 0 — 显式置为非忽略', () => {
        const db = setupIgnoreTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, is_ignore) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md', 1)");
        updateNodeIgnore(db, 'n1', 0);
        const row = db.query('SELECT is_ignore FROM nodes WHERE node_token=?').get('n1') as { is_ignore: number };
        expect(row.is_ignore).toBe(0);
    });

    test('覆盖写语义 — 先写 1 再写 0 应读到 0', () => {
        const db = setupIgnoreTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        updateNodeIgnore(db, 'n1', 1);
        updateNodeIgnore(db, 'n1', 0);
        const row = db.query('SELECT is_ignore FROM nodes WHERE node_token=?').get('n1') as { is_ignore: number };
        expect(row.is_ignore).toBe(0);
    });

    test('不存在的 node_token — UPDATE 影响 0 行，不抛错', () => {
        const db = setupIgnoreTestDb();
        expect(() => {
            updateNodeIgnore(db, 'ghost', 1);
        }).not.toThrow();
        const count = (db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
        expect(count).toBe(0);
    });

    test('getNode 能读到 is_ignore 字段', () => {
        const db = setupIgnoreTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        updateNodeIgnore(db, 'n1', 1);
        const node = getNode(db, 'n1');
        expect(node!.is_ignore).toBe(1);
    });
});

// ============ updateNodeGroup ============

function setupGroupTestDb(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE nodes (
    node_token TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    title TEXT NOT NULL,
    obj_token TEXT NOT NULL,
    obj_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT 'default'
  )`);
    return db;
}

describe('updateNodeGroup', () => {
    test('写入自定义 group — 默认值被覆盖', () => {
        const db = setupGroupTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        updateNodeGroup(db, 'n1', 'blog');
        const row = db.query('SELECT "group" FROM nodes WHERE node_token=?').get('n1') as { group: string };
        expect(row.group).toBe('blog');
    });

    test('覆盖写语义 — 写 blog 再写 docs 应读到 docs', () => {
        const db = setupGroupTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        updateNodeGroup(db, 'n1', 'blog');
        updateNodeGroup(db, 'n1', 'docs');
        const row = db.query('SELECT "group" FROM nodes WHERE node_token=?').get('n1') as { group: string };
        expect(row.group).toBe('docs');
    });

    test('覆盖回 default — 作者删除 group 字段时回到 default', () => {
        const db = setupGroupTestDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, \"group\") VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md', 'blog')");
        updateNodeGroup(db, 'n1', 'default');
        const row = db.query('SELECT "group" FROM nodes WHERE node_token=?').get('n1') as { group: string };
        expect(row.group).toBe('default');
    });

    test('不存在的 node_token — UPDATE 影响 0 行,不抛错', () => {
        const db = setupGroupTestDb();
        expect(() => {
            updateNodeGroup(db, 'ghost', 'blog');
        }).not.toThrow();
        const count = (db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
        expect(count).toBe(0);
    });
});
