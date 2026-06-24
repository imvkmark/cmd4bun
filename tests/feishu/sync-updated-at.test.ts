// sync-updated-at 单元测试
// 测试三种范围查询、updated_at 写入、失败隔离
import { test, expect, describe, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
    getNode,
    updateNodeUpdatedAt,
    ensureDB
} from '../../src/feishu/db';

// ============ 辅助 ============

function createDB(): Database {
    const db = new Database(':memory:');
    db.run('PRAGMA foreign_keys=ON');

    // 创建核心表结构
    db.run('CREATE TABLE spaces (space_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT)');
    db.run(`CREATE TABLE nodes (
    node_token TEXT PRIMARY KEY, space_id TEXT, title TEXT,
    obj_token TEXT, obj_type TEXT, file_path TEXT,
    parent_node_token TEXT,
    downloaded_at TEXT,
    human_path TEXT,
    description TEXT,
    updated_at TEXT, updated_at_last_synced_at TEXT
  )`);
    db.run('CREATE TABLE images (md5 TEXT NOT NULL, node_token TEXT NOT NULL, ext TEXT NOT NULL, oss_url TEXT, uploaded INTEGER DEFAULT 0, created_at TEXT, PRIMARY KEY (md5, node_token))');

    // 插入测试数据
    db.run("INSERT INTO spaces (space_id, name) VALUES ('s1', '知识库 A')");
    db.run("INSERT INTO spaces (space_id, name) VALUES ('s2', '知识库 B')");

    db.run(`INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES
    ('n1', 's1', '文档1', 'ot1', 'doc', 'kb-a/doc1.md'),
    ('n2', 's1', '文档2', 'ot2', 'doc', 'kb-a/doc2.md'),
    ('n3', 's2', '表格1', 'ot3', 'sheet', 'kb-b/sheet1.md'),
    ('n4', 's2', '文档3', 'ot4', 'docx', 'kb-b/doc3.md')`);

    return db;
}

// ============ 范围查询 ============

describe('sync-updated-at 范围查询', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB();
    });

    test('全量查询所有节点（不按 obj_type 过滤）', () => {
        const nodes = db.query(
            'SELECT node_token, title, obj_type FROM nodes'
        ).all() as { node_token: string }[];
        expect(nodes.length).toBe(4); // n1, n2, n3, n4 — 包含 sheet 类型
        const tokens = nodes.map((n) => n.node_token).sort();
        expect(tokens).toEqual(['n1', 'n2', 'n3', 'n4']);
    });

    test('按空间查询指定知识库的所有节点', () => {
        const nodes = db.query(
            "SELECT node_token, title, obj_type FROM nodes WHERE space_id IN ('s1')"
        ).all('s1') as { node_token: string }[];
        expect(nodes.length).toBe(2); // n1, n2
    });

    test('按空间查询包含非 doc/docx 节点', () => {
        const nodes = db.query(
            "SELECT node_token, title, obj_type FROM nodes WHERE space_id IN ('s2')"
        ).all('s2') as { node_token: string; obj_type: string }[];
        expect(nodes.length).toBe(2); // n3 (sheet), n4 (docx)
        const types = nodes.map((n) => n.obj_type).sort();
        expect(types).toEqual(['docx', 'sheet']);
    });

    test('按单节点查询', () => {
        const node = db.query(
            'SELECT node_token, title, obj_type FROM nodes WHERE node_token=?'
        ).get('n4') as { node_token: string; title: string; obj_type: string } | null;
        expect(node).not.toBeNull();
        expect(node!.node_token).toBe('n4');
        expect(node!.title).toBe('文档3');
    });

    test('按单节点查询 — 节点不存在返回 null', () => {
        const node = db.query(
            'SELECT node_token, title, obj_type FROM nodes WHERE node_token=?'
        ).get('nonexistent') as { node_token: string } | null;
        expect(node).toBeNull();
    });

    test('按单节点查询 — 非 doc/docx 节点也能查到', () => {
        const node = db.query(
            'SELECT node_token, title, obj_type FROM nodes WHERE node_token=?'
        ).get('n3') as { node_token: string; obj_type: string } | null;
        expect(node).not.toBeNull();
        expect(node!.obj_type).toBe('sheet');
    });
});

// ============ updated_at 写入 ============

describe('updateNodeUpdatedAt 写入', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB();
    });

    test('写入 updated_at 后节点可正确读取', () => {
        const testTime = '2026-06-12T10:30:00Z';
        updateNodeUpdatedAt(db, 'n1', testTime);
        const node = getNode(db, 'n1');
        expect(node).not.toBeNull();
        expect(node!.updated_at).toBe(testTime);
    });

    test('覆盖写入 updated_at', () => {
        updateNodeUpdatedAt(db, 'n1', '2026-01-01T00:00:00Z');
        updateNodeUpdatedAt(db, 'n1', '2026-06-01T00:00:00Z');
        const node = getNode(db, 'n1');
        expect(node!.updated_at).toBe('2026-06-01T00:00:00Z');
    });

    test('批量写入不同节点互不影响', () => {
        updateNodeUpdatedAt(db, 'n1', '2026-01-01T00:00:00Z');
        updateNodeUpdatedAt(db, 'n2', '2026-02-01T00:00:00Z');
        updateNodeUpdatedAt(db, 'n4', '2026-03-01T00:00:00Z');

        expect(getNode(db, 'n1')!.updated_at).toBe('2026-01-01T00:00:00Z');
        expect(getNode(db, 'n2')!.updated_at).toBe('2026-02-01T00:00:00Z');
        expect(getNode(db, 'n4')!.updated_at).toBe('2026-03-01T00:00:00Z');
    });
});

// ============ 失败隔离 ============

describe('sync-updated-at 失败隔离', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB();
    });

    test('部分节点写入失败不影响已成功节点', () => {
    // 模拟：n1 成功写入，n2 "失败"（不写入）
        updateNodeUpdatedAt(db, 'n1', '2026-06-01T00:00:00Z');
        // n2 的更新被跳过（模拟 API 调用失败）

        // n1 应已更新
        expect(getNode(db, 'n1')!.updated_at).toBe('2026-06-01T00:00:00Z');
        // n2 应保持原值（null）
        expect(getNode(db, 'n2')!.updated_at).toBeNull();
    });

    test('事务内批量写入 — 全成功', () => {
        db.transaction(() => {
            updateNodeUpdatedAt(db, 'n1', '2026-01-01T00:00:00Z');
            updateNodeUpdatedAt(db, 'n2', '2026-02-01T00:00:00Z');
        })();

        expect(getNode(db, 'n1')!.updated_at).toBe('2026-01-01T00:00:00Z');
        expect(getNode(db, 'n2')!.updated_at).toBe('2026-02-01T00:00:00Z');
    });

    test('ensureDB 在校验失败时拒绝操作', () => {
        const emptyDB = new Database(':memory:');
        expect(() => {
            ensureDB(emptyDB);
        }).toThrow(/init-db/);
    });
});
