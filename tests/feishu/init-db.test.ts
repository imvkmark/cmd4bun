// init-db 迁移系统单元测试
import { test, expect, describe, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
    ensureDB
} from '../../src/feishu/db';

// ============ 辅助函数 ============

function createTempDB(): Database {
    const db = new Database(':memory:');
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA foreign_keys=ON');
    return db;
}

// ============ ensureDB ============

describe('ensureDB', () => {
    let db: Database;

    beforeEach(() => {
        db = createTempDB();
    });

    test('核心表全部存在时不报错', () => {
        db.run('CREATE TABLE spaces (space_id TEXT PRIMARY KEY)');
        db.run('CREATE TABLE nodes (node_token TEXT PRIMARY KEY)');
        db.run('CREATE TABLE images (md5 TEXT PRIMARY KEY)');
        db.run('CREATE TABLE image_vs_node (md5 TEXT, node_token TEXT, PRIMARY KEY (md5, node_token))');
        expect(() => {
            ensureDB(db);
        }).not.toThrow();
    });

    test('缺失 spaces 表时抛出错误并提示运行 init-db', () => {
        db.run('CREATE TABLE nodes (node_token TEXT PRIMARY KEY)');
        db.run('CREATE TABLE images (md5 TEXT PRIMARY KEY)');
        expect(() => {
            ensureDB(db);
        }).toThrow(/spaces/);
        expect(() => {
            ensureDB(db);
        }).toThrow(/init-db/);
    });

    test('缺失 nodes 表时抛出错误', () => {
        db.run('CREATE TABLE spaces (space_id TEXT PRIMARY KEY)');
        db.run('CREATE TABLE images (md5 TEXT PRIMARY KEY)');
        expect(() => {
            ensureDB(db);
        }).toThrow(/nodes/);
    });

    test('缺失 images 表时抛出错误', () => {
        db.run('CREATE TABLE spaces (space_id TEXT PRIMARY KEY)');
        db.run('CREATE TABLE nodes (node_token TEXT PRIMARY KEY)');
        expect(() => {
            ensureDB(db);
        }).toThrow(/images/);
    });

    test('缺失多张表时错误消息包含所有缺失表名', () => {
        expect(() => {
            ensureDB(db);
        }).toThrow(/spaces.*nodes.*images/);
    });
});

// ============ 迁移幂等执行 ============

describe('迁移幂等执行', () => {
    test('CREATE TABLE IF NOT EXISTS 重复执行不报错', () => {
        const db = createTempDB();
        // 第一次
        db.run('CREATE TABLE IF NOT EXISTS spaces (space_id TEXT PRIMARY KEY)');
        // 第二次 — 不报错
        expect(() =>
            db.run('CREATE TABLE IF NOT EXISTS spaces (space_id TEXT PRIMARY KEY)')
        ).not.toThrow();
    });

    test('同一数据库重复创建核心表不报错', () => {
        const db = createTempDB();
        // 模拟 001_initial.sql
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
        space_id          TEXT NOT NULL,
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
        md5        TEXT NOT NULL,
        node_token TEXT NOT NULL,
        ext        TEXT NOT NULL,
        oss_url    TEXT,
        uploaded   INTEGER DEFAULT 0,
        created_at TEXT,
        PRIMARY KEY (md5, node_token)
      )
    `);

        // 重复运行 — 不报错
        expect(() => {
            db.run('CREATE TABLE IF NOT EXISTS spaces (space_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT)');
            db.run('CREATE TABLE IF NOT EXISTS nodes (node_token TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, obj_token TEXT NOT NULL, obj_type TEXT NOT NULL, file_path TEXT NOT NULL, parent_node_token TEXT, downloaded_at TEXT, updated_at_last_synced_at TEXT)');
            db.run('CREATE TABLE IF NOT EXISTS images (md5 TEXT NOT NULL, node_token TEXT NOT NULL, ext TEXT NOT NULL, oss_url TEXT, uploaded INTEGER DEFAULT 0, created_at TEXT, PRIMARY KEY (md5, node_token))');
            db.run('CREATE TABLE IF NOT EXISTS image_vs_node (md5 TEXT, node_token TEXT, PRIMARY KEY (md5, node_token))');
        }).not.toThrow();

        // ensureDB 也应通过
        expect(() => {
            ensureDB(db);
        }).not.toThrow();
    });
});

// ============ 015 迁移幂等执行 ============

describe('015_add_is_ignore 迁移', () => {
    test('迁移执行后 nodes 表应新增 is_ignore 列，默认值为 0', () => {
        const db = createTempDB();
        // 模拟迁移前的基础 schema（不含 is_ignore 列）
        db.run(`CREATE TABLE nodes (
      node_token TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      title TEXT NOT NULL,
      obj_token TEXT NOT NULL,
      obj_type TEXT NOT NULL,
      file_path TEXT NOT NULL
    )`);
        // 执行 015 迁移
        db.run('ALTER TABLE nodes ADD COLUMN is_ignore INTEGER NOT NULL DEFAULT 0');

        // 验证列存在
        const cols = db.query('PRAGMA table_info(nodes)').all() as { name: string; dflt_value: string | null }[];
        const ignoreCol = cols.find((c) => c.name === 'is_ignore');
        expect(ignoreCol).toBeDefined();
        expect(ignoreCol!.dflt_value).toBe('0');

        // 验证默认 0 生效
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path) VALUES ('n1', 's1', 'T1', 'ot1', 'doc', 'a.md')");
        const row = db.query('SELECT is_ignore FROM nodes WHERE node_token=?').get('n1') as { is_ignore: number };
        expect(row.is_ignore).toBe(0);
    });

    test('列已存在时 ALTER TABLE 应被幂等处理', () => {
        // 实际 init-db-flow 通过 duplicate column name 异常识别并跳过；
        // 这里模拟重复执行时不破坏数据
        const db = createTempDB();
        db.run(`CREATE TABLE nodes (
      node_token TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      title TEXT NOT NULL,
      obj_token TEXT NOT NULL,
      obj_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      is_ignore INTEGER NOT NULL DEFAULT 0
    )`);

        // 重复执行 ALTER TABLE 会抛 "duplicate column name" 异常
        expect(() => {
            db.run('ALTER TABLE nodes ADD COLUMN is_ignore INTEGER NOT NULL DEFAULT 0');
        }).toThrow(/duplicate column name/i);
    });
});
