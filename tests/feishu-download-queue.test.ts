// getDownloadQueue 队列构建回归测试：验证批量下载队列包含 doc/docx/file/sheet 四种类型
// 并正确应用 space_id 过滤、force 参数与 priority 排序。

import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { getDownloadQueue } from '../src/feishu/db';

let db: Database;

const OLD = '2024-01-01T00:00:00.000Z';
const RECENT = '2024-01-02T00:00:00.000Z';

beforeAll(() => {
    // 使用内存库避免污染项目内 docs/feishu/data/feishu.db，
    // 完整复刻 nodes 表结构（与 014 号迁移后状态一致），spaces 用于外键。
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys=ON');
    db.run(`
        CREATE TABLE spaces (
            space_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            updated_at TEXT
        )
    `);
    db.run(`
        CREATE TABLE nodes (
            node_token TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            title TEXT NOT NULL,
            obj_token TEXT NOT NULL,
            obj_type TEXT NOT NULL,
            file_path TEXT NOT NULL,
            parent_node_token TEXT,
            downloaded_at TEXT,
            updated_at TEXT,
            human_path TEXT,
            description TEXT,
            scanned_at TEXT,
            updated_at_last_synced_at TEXT,
            priority INTEGER NOT NULL DEFAULT 0,
            upload_url TEXT
        )
    `);
    db.run("INSERT INTO spaces (space_id, name) VALUES ('s1', 'space one'), ('s2', 'space two')");
});

afterAll(() => {
    db.close();
});

beforeEach(() => {
    db.run('DELETE FROM nodes');
});

/** 插入一条节点用于测试。file_path 为空字符串表示非 doc/docx 占位节点。 */
function insertNode(
    nodeToken: string,
    spaceId: string,
    objType: string,
    filePath: string,
    downloadedAt: string | null,
    updatedAt: string | null,
    priority = 0,
    parentNodeToken: string | null = null
): void {
    db.run(
        `INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, downloaded_at, updated_at, priority, parent_node_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nodeToken, spaceId, `${objType}-${nodeToken}`, nodeToken, objType, filePath, downloadedAt, updatedAt, priority, parentNodeToken]
    );
}

test('force=true 返回 doc/docx/file/sheet 四种类型，过滤 bitable/mindnote/slides', () => {
    insertNode('n1', 's1', 'doc', 'p1.md', RECENT, RECENT);
    insertNode('n2', 's1', 'docx', 'p2.md', RECENT, RECENT);
    insertNode('n3', 's1', 'file', '', RECENT, RECENT);
    insertNode('n4', 's1', 'sheet', '', RECENT, RECENT);
    insertNode('n5', 's1', 'bitable', '', RECENT, RECENT);
    insertNode('n6', 's1', 'mindnote', '', RECENT, RECENT);
    insertNode('n7', 's1', 'slides', '', RECENT, RECENT);

    const queue = getDownloadQueue(db, ['s1'], true);
    const types = queue.map((n) => n.obj_type).sort();
    expect(types).toEqual(['doc', 'docx', 'file', 'sheet']);
});

test('force=false 仅返回需要下载的节点 (downloaded_at < updated_at 或 downloaded_at 为空)', () => {
    // 已下载但已过期
    insertNode('n1', 's1', 'doc', 'p1.md', OLD, RECENT);
    // 从未下载
    insertNode('n2', 's1', 'docx', 'p2.md', null, RECENT);
    // file 节点需要重下
    insertNode('n3', 's1', 'file', '', OLD, RECENT);
    // sheet 节点从未同步过 (downloaded_at 与 updated_at 都为 NULL)
    insertNode('n4', 's1', 'sheet', '', null, null);
    // 已是最新，不入队
    insertNode('n5', 's1', 'doc', 'p5.md', RECENT, RECENT);

    const queue = getDownloadQueue(db, ['s1'], false);
    const tokens = queue.map((n) => n.node_token).sort();
    expect(tokens).toEqual(['n1', 'n2', 'n3', 'n4']);
});

test('force=false 时 downloaded_at === updated_at 不入队', () => {
    insertNode('n1', 's1', 'doc', 'p1.md', RECENT, RECENT);
    insertNode('n2', 's1', 'file', '', RECENT, RECENT);

    const queue = getDownloadQueue(db, ['s1'], false);
    expect(queue).toHaveLength(0);
});

test('空 file_path 占位节点 (file/sheet) 正常入队', () => {
    insertNode('n1', 's1', 'file', '', null, RECENT);
    insertNode('n2', 's1', 'sheet', '', null, RECENT);

    const queue = getDownloadQueue(db, ['s1'], false);
    expect(queue).toHaveLength(2);
    expect(queue.every((n) => n.file_path === '')).toBe(true);
});

test('space_id 过滤生效：单 space', () => {
    insertNode('n1', 's1', 'doc', 'p1.md', null, RECENT);
    insertNode('n2', 's2', 'doc', 'p2.md', null, RECENT);
    insertNode('n3', 's2', 'file', '', null, RECENT);

    const queue = getDownloadQueue(db, ['s1'], true);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.node_token).toBe('n1');
    expect(queue[0]!.space_id).toBe('s1');
});

test('space_id 过滤生效：多 space 全部返回', () => {
    insertNode('n1', 's1', 'doc', 'p1.md', null, RECENT);
    insertNode('n2', 's2', 'file', '', null, RECENT);
    insertNode('n3', 's2', 'sheet', '', null, RECENT);

    const queue = getDownloadQueue(db, ['s1', 's2'], true);
    expect(queue).toHaveLength(3);
});

test('按 priority DESC 排序，node_token ASC 作为 tie-breaker', () => {
    insertNode('n1', 's1', 'doc', 'p1.md', null, RECENT, 0);
    insertNode('n2', 's1', 'doc', 'p2.md', null, RECENT, 5);
    insertNode('n3', 's1', 'doc', 'p3.md', null, RECENT, 2);
    // 同 priority 时按 node_token ASC
    insertNode('n4', 's1', 'file', '', null, RECENT, 2);

    const queue = getDownloadQueue(db, ['s1'], true);
    expect(queue.map((n) => n.node_token)).toEqual(['n2', 'n3', 'n4', 'n1']);
});

test('空 nodes 表返回空队列', () => {
    const queue = getDownloadQueue(db, ['s1'], true);
    expect(queue).toEqual([]);
});

test('按 parent_node_token 聚合：同父节点的兄弟节点聚在一起,根节点优先', () => {
    // 根节点 (parent_node_token = NULL/'') 排最前
    insertNode('root-a', 's1', 'doc', 'ra.md', null, RECENT, 0, '');
    insertNode('root-b', 's1', 'doc', 'rb.md', null, RECENT, 0, '');
    // 父节点 root-a 下的两个子节点
    insertNode('child-a1', 's1', 'doc', 'ca1.md', null, RECENT, 0, 'root-a');
    insertNode('child-a2', 's1', 'doc', 'ca2.md', null, RECENT, 0, 'root-a');
    // 父节点 root-b 下的子节点
    insertNode('child-b1', 's1', 'doc', 'cb1.md', null, RECENT, 0, 'root-b');

    const queue = getDownloadQueue(db, ['s1'], true);
    const tokens = queue.map((n) => n.node_token);
    // 根节点先 (root-a, root-b);然后 root-a 的子节点 (child-a1, child-a2);最后 root-b 的子节点 (child-b1)
    expect(tokens).toEqual(['root-a', 'root-b', 'child-a1', 'child-a2', 'child-b1']);
});

test('同 parent_node_token 内:无内容 (downloaded_at IS NULL) 先于有内容', () => {
    // 同一父节点下混合"已下载"与"未下载"节点
    insertNode('child-1', 's1', 'doc', 'c1.md', null, RECENT, 0, 'parent-x');
    insertNode('child-2', 's1', 'doc', 'c2.md', OLD, RECENT, 0, 'parent-x');
    insertNode('child-3', 's1', 'doc', 'c3.md', null, RECENT, 0, 'parent-x');
    insertNode('child-4', 's1', 'doc', 'c4.md', OLD, RECENT, 0, 'parent-x');

    const queue = getDownloadQueue(db, ['s1'], true);
    const tokens = queue.map((n) => n.node_token);
    // 无内容 (child-1, child-3) 在前,然后有内容 (child-2, child-4);同组内仍按 node_token ASC 兜底
    expect(tokens).toEqual(['child-1', 'child-3', 'child-2', 'child-4']);
});

test('同 parent_node_token + 同内容状态:仍按 priority DESC + node_token ASC 排序', () => {
    // 同一父节点 + 全部无内容
    insertNode('n1', 's1', 'doc', 'p1.md', null, RECENT, 0, 'parent-y');
    insertNode('n2', 's1', 'doc', 'p2.md', null, RECENT, 5, 'parent-y');
    insertNode('n3', 's1', 'doc', 'p3.md', null, RECENT, 2, 'parent-y');
    insertNode('n4', 's1', 'file', '', null, RECENT, 2, 'parent-y');

    const queue = getDownloadQueue(db, ['s1'], true);
    expect(queue.map((n) => n.node_token)).toEqual(['n2', 'n3', 'n4', 'n1']);
});

test('force=false 时 parent_node_token 排序仍然生效', () => {
    // n1 已下载且最新 (不入队);n2, n3, n4 未下载 (入队)
    insertNode('n1', 's1', 'doc', 'p1.md', RECENT, RECENT, 0, 'parent-a');
    insertNode('n2', 's1', 'doc', 'p2.md', null, RECENT, 0, 'parent-a');
    insertNode('n3', 's1', 'doc', 'p3.md', null, RECENT, 0, 'parent-a');
    // 另一个父节点下的未下载节点
    insertNode('n4', 's1', 'doc', 'p4.md', null, RECENT, 0, 'parent-b');

    const queue = getDownloadQueue(db, ['s1'], false);
    const tokens = queue.map((n) => n.node_token);
    // 入队的三个按 parent_node_token 聚合:parent-a (n2, n3) 先,parent-b (n4) 后
    expect(tokens).toEqual(['n2', 'n3', 'n4']);
});
