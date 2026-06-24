// refreshNodeUpdatedAt 单元测试
//
// 通过 mock.module 拦截 ./api.fetchNodeMetaAsync,验证 refreshNodeUpdatedAt 三条分支:
// - 远端 updated_at 不同 → 写 DB + 返回新 node
// - 远端 updated_at 相同 → no-op
// - 远端失败 → 不写 DB + 返回原 node + 不抛错
//
// mock.module 必须在所有 import 之前调用,否则 download-flow.ts 已经捕获了原始 fetchNodeMetaAsync。
import { test, expect, describe, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

// 只替换 fetchNodeMetaAsync,其余函数保留真实实现,避免误伤。
// mockResolvedValueOnce 控制返回值,这里参数不用,显式 suppress lint。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fetchMetaMock = mock((..._args: unknown[]): Promise<{ updated_at: string } | null> => Promise.resolve({ updated_at: 'NEW-AT' }));
const realApi = await import('../../src/feishu/api');
void mock.module('../../src/feishu/api', () => ({
    ...realApi,
    fetchNodeMetaAsync: fetchMetaMock
}));

const { refreshNodeUpdatedAt } = await import('../../src/feishu/download-flow');

// ============ 工具 ============

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
    db.run(
        `INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at)
         VALUES ('n1', 's1', '文档标题', 'ot', 'doc', 't.md', 'OLD-AT')`
    );
    return db;
}

function makeNode(overrides: Partial<{ updated_at: string | null }> = {}): import('../../src/feishu/db').DBNode {
    return {
        node_token: 'n1',
        space_id: 's1',
        title: '文档标题',
        obj_token: 'ot',
        obj_type: 'doc',
        file_path: 't.md',
        updated_at: 'OLD-AT',
        updated_at_last_synced_at: null,
        parent_node_token: '',
        downloaded_at: null,
        human_path: null,
        scanned_at: null,
        description: null,
        priority: 0,
        is_ignore: 0,
        upload_url: null,
        group: 'default',
        ...overrides
    };
}

function getStoredUpdatedAt(db: Database, token: string): string | null {
    const row = db.query('SELECT updated_at FROM nodes WHERE node_token=?').get(token) as { updated_at: string | null } | null;
    return row?.updated_at ?? null;
}

// ============ 测试 ============

describe('refreshNodeUpdatedAt', () => {
    test('远端 updated_at 与本地不同:写 DB + 返回带新值的 node', async () => {
        const db = createDB();
        fetchMetaMock.mockResolvedValueOnce({ updated_at: 'NEW-AT' });

        const result = await refreshNodeUpdatedAt(db, makeNode());

        expect(result.updated_at).toBe('NEW-AT');
        expect(result.node_token).toBe('n1');
        // DB 行被覆盖写
        expect(getStoredUpdatedAt(db, 'n1')).toBe('NEW-AT');
    });

    test('远端 updated_at 与本地相同:不写 DB + 返回原 node(同一引用)', async () => {
        const db = createDB();
        fetchMetaMock.mockResolvedValueOnce({ updated_at: 'OLD-AT' });

        const original = makeNode();
        const result = await refreshNodeUpdatedAt(db, original);

        // 返回原 node 引用(无新值就不展开新对象)
        expect(result).toBe(original);
        expect(getStoredUpdatedAt(db, 'n1')).toBe('OLD-AT');
    });

    test('远端返回 null:不写 DB + 返回原 node', async () => {
        const db = createDB();
        fetchMetaMock.mockResolvedValueOnce(null);

        const original = makeNode();
        const result = await refreshNodeUpdatedAt(db, original);

        expect(result).toBe(original);
        expect(getStoredUpdatedAt(db, 'n1')).toBe('OLD-AT');
    });

    test('远端 updated_at 为空字符串:视为 no-op,不写 DB', async () => {
        const db = createDB();
        fetchMetaMock.mockResolvedValueOnce({ updated_at: '' });

        const original = makeNode();
        const result = await refreshNodeUpdatedAt(db, original);

        expect(result).toBe(original);
        expect(getStoredUpdatedAt(db, 'n1')).toBe('OLD-AT');
    });

    test('远端抛异常:不写 DB + 返回原 node + 不向上抛错', async () => {
        const db = createDB();
        fetchMetaMock.mockRejectedValueOnce(new Error('lark-cli 限流'));

        const original = makeNode();
        // 必须不抛:下载的核心是拉内容,metadata 失败不应阻塞主流程
        const result = await refreshNodeUpdatedAt(db, original);

        expect(result).toBe(original);
        expect(getStoredUpdatedAt(db, 'n1')).toBe('OLD-AT');
    });

    test('调用 fetchNodeMetaAsync 时应透传 obj_token 和 obj_type', async () => {
        const db = createDB();
        fetchMetaMock.mockClear();
        fetchMetaMock.mockResolvedValueOnce({ updated_at: 'NEW-AT' });

        await refreshNodeUpdatedAt(db, makeNode({ updated_at: 'OLD-AT' }));

        expect(fetchMetaMock).toHaveBeenCalledTimes(1);
        expect(fetchMetaMock).toHaveBeenCalledWith('ot', 'doc');
    });

    test('node.updated_at 为 null 时远端返回新值:应写 DB(从 null 升级到有值)', async () => {
        const db = createDB();
        fetchMetaMock.mockResolvedValueOnce({ updated_at: 'FRESH-AT' });

        const result = await refreshNodeUpdatedAt(db, makeNode({ updated_at: null }));

        expect(result.updated_at).toBe('FRESH-AT');
        expect(getStoredUpdatedAt(db, 'n1')).toBe('FRESH-AT');
    });
});
