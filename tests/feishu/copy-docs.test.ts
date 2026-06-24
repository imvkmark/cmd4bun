// 飞书 copy-docs SQL 过滤单元测试
import { test, expect, describe } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('copydocs SQL 过滤 is_ignore', () => {
    function setupDb(): Database {
        const db = new Database(':memory:');
        db.run(`CREATE TABLE nodes (
      node_token TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      title TEXT NOT NULL,
      obj_token TEXT NOT NULL,
      obj_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      parent_node_token TEXT,
      downloaded_at TEXT,
      human_path TEXT,
      is_ignore INTEGER NOT NULL DEFAULT 0
    )`);
        return db;
    }

    // 复制 copy-docs-flow.ts 的过滤 SQL，保持测试与生产代码一致
    const COPY_DOCS_SQL = `
    SELECT file_path, human_path, title FROM nodes
    WHERE human_path IS NOT NULL AND human_path != ''
      AND file_path IS NOT NULL AND file_path != ''
      AND downloaded_at IS NOT NULL
      AND (is_ignore IS NULL OR is_ignore = 0)
  `;

    test('is_ignore=1 的节点应被过滤掉', () => {
        const db = setupDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n1', 's1', '内部草稿', 'ot1', 'doc', 'a.md', 'internal-draft', '2026-05-01T00:00:00Z', 1)");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n2', 's1', '正常文档', 'ot2', 'doc', 'b.md', 'public-doc', '2026-05-01T00:00:00Z', 0)");

        const rows = db.query(COPY_DOCS_SQL).all() as { title: string; human_path: string }[];
        expect(rows.map((r) => r.title)).toEqual(['正常文档']);
    });

    test('is_ignore=0 与默认值（无 is_ignore 列写入）均应被包含', () => {
        const db = setupDb();
        // 显式写 is_ignore=0
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n1', 's1', '正常1', 'ot1', 'doc', 'a.md', 'doc-1', '2026-05-01T00:00:00Z', 0)");
        // 不写 is_ignore 列，由 DEFAULT 0 填充（模拟迁移前插入的节点）
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at) VALUES ('n2', 's1', '正常2', 'ot2', 'doc', 'b.md', 'doc-2', '2026-05-01T00:00:00Z')");

        const rows = db.query(COPY_DOCS_SQL).all() as { title: string }[];
        expect(rows.map((r) => r.title).sort()).toEqual(['正常1', '正常2']);
    });

    test('is_ignore=1 但 human_path 为空时也应被过滤（两个过滤条件都生效）', () => {
        const db = setupDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n1', 's1', '忽略+无slug', 'ot1', 'doc', 'a.md', NULL, '2026-05-01T00:00:00Z', 1)");

        const rows = db.query(COPY_DOCS_SQL).all() as { title: string }[];
        expect(rows).toEqual([]);
    });

    test('混合数据：仅 is_ignore=0 或 NULL 的可被复制', () => {
        const db = setupDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n1', 's1', 'A-忽略', 'ot1', 'doc', 'a.md', 'a', '2026-05-01T00:00:00Z', 1)");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n2', 's1', 'B-正常', 'ot2', 'doc', 'b.md', 'b', '2026-05-01T00:00:00Z', 0)");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n3', 's1', 'C-无slug', 'ot3', 'doc', 'c.md', NULL, '2026-05-01T00:00:00Z', 0)");
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n4', 's1', 'D-未下载', 'ot4', 'doc', 'd.md', 'd', NULL, 0)");

        const rows = db.query(COPY_DOCS_SQL).all() as { title: string }[];
        expect(rows.map((r) => r.title)).toEqual(['B-正常']);
    });

    test('downloaded_at 为空的节点即使未忽略也应被过滤', () => {
        const db = setupDb();
        db.run("INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, human_path, downloaded_at, is_ignore) VALUES ('n1', 's1', '正常但未下载', 'ot1', 'doc', 'a.md', 'a', NULL, 0)");

        const rows = db.query(COPY_DOCS_SQL).all() as { title: string }[];
        expect(rows).toEqual([]);
    });
});
