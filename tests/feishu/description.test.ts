// 飞书 description 相关单元测试
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { updateNodeDescription } from '../../src/feishu/db';

// ============ Helper: 重建 DB 初始化逻辑（不含 description 迁移以测试正向写入） ============

function initTestTables(db: Database): void {
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
      human_path        TEXT,
      description       TEXT,
      updated_at        TEXT,
      updated_at_last_synced_at TEXT
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS images (
      md5        TEXT NOT NULL,
      node_token TEXT NOT NULL,
      ext        TEXT NOT NULL,
      oss_url    TEXT,
      uploaded   INTEGER DEFAULT 0,
      created_at TEXT,
      PRIMARY KEY (md5, node_token)
    )
  `);
}

function insertSpace(db: Database, id: string, name: string): void {
    db.run(
        'INSERT INTO spaces (space_id, name, updated_at) VALUES (?, ?, ?)',
        [id, name, new Date().toISOString()]
    );
}

function insertNode(db: Database, token: string, spaceId: string): void {
    db.run(
        `INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, parent_node_token)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [token, spaceId, '测试文档', 'obj-' + token, 'docx', 'test.md', '']
    );
}

// ============ Test Setup ============

let db: Database;
let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'feishu-desc-test-'));
    db = new Database(join(tmpDir, 'test.db'), { create: true });
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA foreign_keys=ON');
    initTestTables(db);

    insertSpace(db, 's1', '测试知识库');
    insertNode(db, 'n1', 's1');
});

afterEach(() => {
    db.close();
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {
    // ignore
    }
});

// ============ Tests ============

test('updateNodeDescription: 写入 description 后应能正确读取', () => {
    updateNodeDescription(db, 'n1', '这是一段用于 Open Graph 的描述文本');

    const row = db.query('SELECT description FROM nodes WHERE node_token=?').get('n1') as { description: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.description).toBe('这是一段用于 Open Graph 的描述文本');
});

test('updateNodeDescription: 多次更新应覆盖旧值', () => {
    updateNodeDescription(db, 'n1', '第一版描述');
    updateNodeDescription(db, 'n1', '第二版描述（覆盖）');

    const row = db.query('SELECT description FROM nodes WHERE node_token=?').get('n1') as { description: string | null } | null;
    expect(row!.description).toBe('第二版描述（覆盖）');
});

test('updateNodeDescription: 写入空字符串应存储空字符串', () => {
    updateNodeDescription(db, 'n1', '');

    const row = db.query('SELECT description FROM nodes WHERE node_token=?').get('n1') as { description: string | null } | null;
    expect(row!.description).toBe('');
});

test('updateNodeDescription: description 默认为 NULL', () => {
    const row = db.query('SELECT description FROM nodes WHERE node_token=?').get('n1') as { description: string | null } | null;
    expect(row!.description).toBeNull();
});

test('updateNodeDescription: 不存在的节点应不报错（零影响）', () => {
    expect(() => {
        updateNodeDescription(db, 'nonexistent', '无节点描述');
    }).not.toThrow();
});

test('updateNodeDescription: 不影响其他字段', () => {
    updateNodeDescription(db, 'n1', '新描述');

    const row = db.query('SELECT * FROM nodes WHERE node_token=?').get('n1') as Record<string, unknown>;
    expect(row.title).toBe('测试文档');
    expect(row.obj_type).toBe('docx');
    expect(row.file_path).toBe('test.md');
});
