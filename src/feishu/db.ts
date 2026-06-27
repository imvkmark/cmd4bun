// 飞书 SQLite 数据库操作：表初始化、CRUD、连接管理

import { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupOrphanImages } from './images';
import type { OssClientConfig } from '../config';

// ============ Types ============

export interface DBNode {
    node_token: string;
    space_id: string;
    title: string;
    obj_token: string;
    obj_type: string;
    file_path: string;
    updated_at: string | null;
    updated_at_last_synced_at: string | null;
    parent_node_token: string;
    downloaded_at: string | null;
    scanned_at: string | null;
    human_path: string | null;
    description: string | null;
    priority: number;
    /** 是否被作者标记为忽略（YAML ignore: Y）。copydocs 阶段过滤掉非零行 */
    is_ignore: number;
    /** 非 doc/docx 类型（如 pdf）上传到 OSS 后的公网访问地址 */
    upload_url: string | null;
    /** 文档分组(从 YAML group 字段解析,小写 [a-z0-9-]+)。copydocs 按 group 分发到各自 aimDirectory */
    group: string;
}

export interface DBImage {
    md5: string;
    ext: string;
    oss_url: string | null;
    uploaded: number;
    created_at: string | null;
}

// ============ Connection ============

let _db: Database | null = null;

export function getDBPath(outputDir: string): string {
    return join(outputDir, 'data', 'feishu.db');
}

export function getDB(outputDir: string): Database {
    if (_db) return _db;
    const dbPath = getDBPath(outputDir);
    _db = new Database(dbPath, { create: true });
    _db.run('PRAGMA journal_mode=WAL');
    _db.run('PRAGMA foreign_keys=ON');
    return _db;
}

export function closeDB(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

/**
 * 检查核心表 (spaces, nodes, images) 是否存在。
 * 任一表缺失时抛出错误，提示先运行 init-db 命令。
 */
export function ensureDB(db: Database): void {
    const required = ['spaces', 'nodes', 'images', 'image_vs_node'];
    const existing = (
        db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    const missing = required.filter((t) => !existing.includes(t));
    if (missing.length > 0) {
        throw new Error(
            `数据库表缺失: ${missing.join(', ')}。请先运行 init-db 命令初始化数据库:\n  bun run src/feishu.ts init-db`
        );
    }
}

// ============ Space CRUD ============

export function upsertSpace(db: Database, space: { space_id: string; name: string }): void {
    db.run(
        'INSERT INTO spaces (space_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at',
        [space.space_id, space.name, new Date().toISOString()]
    );
}

export function deleteSpace(db: Database, spaceId: string): void {
    db.run('DELETE FROM spaces WHERE space_id=?', [spaceId]);
}

export function getSpaceIds(db: Database): Set<string> {
    const rows = db.query('SELECT space_id FROM spaces').all() as { space_id: string }[];
    return new Set(rows.map((r) => r.space_id));
}

// ============ Node CRUD ============

export function getNode(db: Database, nodeToken: string): DBNode | null {
    return db.query('SELECT * FROM nodes WHERE node_token=?').get(nodeToken) as DBNode | null;
}

/**
 * 按 obj_token 查询节点。
 *
 * 与 getNode 的区别：getNode 按 node_token(wiki 树节点 ID)查，getNodeByObjToken 按 obj_token(实际文档对象 ID)查。
 * 飞书的 sub-page 引用场景使用 obj_token(同一文档可被多个 wiki 节点引用，obj_token 才是文档对象的唯一标识)；
 * cite 引用场景使用 node_token(同 wiki 树内引用)。
 *
 * obj_token 在 nodes 表上没有唯一约束(同一文档被多处引用时会插入多行)，返回首条匹配。
 */
export function getNodeByObjToken(db: Database, objToken: string): DBNode | null {
    return db.query('SELECT * FROM nodes WHERE obj_token=? LIMIT 1').get(objToken) as DBNode | null;
}

/**
 * 判断节点是否需要重新下载。
 * 比较本地下载时间 (downloaded_at, ISO 8601) 与远端编辑时间 (updated_at, ISO 8601)。
 * 当 downloaded_at 为空、updated_at 为 NULL 时，返回 true。
 */
export function needsDownload(node: { downloaded_at: string | null; updated_at: string | null }): boolean {
    if (!node.downloaded_at) return true;
    if (!node.updated_at) return true;
    const downloadedMs = new Date(node.downloaded_at).getTime();
    const updatedMs = new Date(node.updated_at).getTime();
    if (isNaN(downloadedMs) || isNaN(updatedMs)) return true;
    return downloadedMs < updatedMs;
}

/**
 * 获取需要下载的节点队列。
 *
 * 队列覆盖 `doc` / `docx` / `file` / `sheet` 四种类型，由 `downNode` 按 obj_type 分发到不同处理管线：
 * - doc/docx → processDocContent 写本地 Markdown + 图片处理
 * - file → lark-cli drive +download 下载二进制后上传 OSS
 * - sheet → lark-cli sheets +workbook-export 导出 xlsx 后上传 OSS
 *
 * `force=true` 时直接返回这四种类型的全部节点；`force=false` 时按 `needsDownload` 过滤
 * (downloaded_at 为空或早于 updated_at)。
 *
 * 排序键（外→内）：
 * 1. `parent_node_token ASC` —— 把同一父节点下的兄弟 / 子节点聚在一起,根节点 (空串 / NULL) 优先
 * 2. `downloaded_at IS NULL` 优先 —— "无内容" (从未下载) 先于 "有内容" (曾下载) 处理
 * 3. `priority DESC` —— `<cite>` / `<sub-page>` 解析器对"被引方存在但 human_path 为空"累加的引用计数
 * 4. `node_token ASC` —— 同 priority 的稳定兜底
 */
export function getDownloadQueue(db: Database, spaceIds: string[], force: boolean): DBNode[] {
    const placeholders = spaceIds.map(() => '?').join(',');
    const allNodes = db.query(
        `SELECT * FROM nodes WHERE space_id IN (${placeholders}) AND obj_type IN ('doc', 'docx', 'file', 'sheet')
         ORDER BY parent_node_token ASC,
                  CASE WHEN downloaded_at IS NULL THEN 0 ELSE 1 END ASC,
                  priority DESC,
                  node_token ASC`
    ).all(...spaceIds) as DBNode[];

    if (force) return allNodes;

    return allNodes.filter((node) => needsDownload(node));
}

/**
 * 标记节点下载完成，写入 downloaded_at。
 *
 * @param downloadedAt 可选时间戳；不传时默认写入当前墙钟时间。
 *
 * 调用方在已知"本次下载对应的远端版本时间戳"时应显式传入，使 `needsDownload`
 * 的 `downloaded_at < updated_at` 检查天然幂等 —— 下次比较时
 * `downloaded_at == updated_at` ⇒ false ⇒ 不重下。
 *
 * sheet/file 下载路径必须显式传 `node.updated_at`：否则 downloaded_at 是 NOW()，
 * 而 sync 阶段不主动刷新 updated_at（仅保留旧值，见 sync-flow.ts），sheet/file
 * 节点首次 download 后只要 updated_at 仍为 NULL，`needsDownload` 永远返回 true，
 * 导致每次 download 都被重下。
 *
 * 未传时 fallback 到 NOW()：doc/docx 走此路径，配合 sync-updated-at 在 download
 * 之前刷新 updated_at（远端编辑时间 < NOW()）同样幂等。
 */
export function markNodeDownloaded(db: Database, nodeToken: string, downloadedAt?: string | null): void {
    const ts = downloadedAt ?? new Date().toISOString();
    db.run('UPDATE nodes SET downloaded_at=? WHERE node_token=?', [ts, nodeToken]);
}

export function updateNodeUpdatedAt(db: Database, nodeToken: string, updatedAt: string): void {
    const now = new Date().toISOString();
    db.run('UPDATE nodes SET updated_at=?, updated_at_last_synced_at=? WHERE node_token=?', [updatedAt, now, nodeToken]);
}

export function updateNodeHumanPath(db: Database, nodeToken: string, humanPath: string): void {
    db.run('UPDATE nodes SET human_path=? WHERE node_token=?', [humanPath, nodeToken]);
}

export function updateNodeDescription(db: Database, nodeToken: string, description: string): void {
    db.run('UPDATE nodes SET description=? WHERE node_token=?', [description, nodeToken]);
}

/** 更新节点 upload_url（用于 pdf 等非 doc/docx 类型上传 OSS 后的公网地址）。 */
export function updateNodeUploadUrl(db: Database, nodeToken: string, uploadUrl: string | null): void {
    db.run('UPDATE nodes SET upload_url=? WHERE node_token=?', [uploadUrl, nodeToken]);
}

/**
 * 覆盖写节点的 is_ignore 标记。
 * 下载管线在解析 YAML ignore: Y 后调用：作者去除 `ignore: Y` 时下次 download 自动回到 0。
 */
export function updateNodeIgnore(db: Database, nodeToken: string, ignore: 0 | 1): void {
    db.run('UPDATE nodes SET is_ignore=? WHERE node_token=?', [ignore, nodeToken]);
}

/**
 * 覆盖写节点的 group 标记。
 * 下载管线在解析 YAML group 字段后调用：作者去掉 `group: foo` 时下次 download 自动回到 'default'。
 * group 在 sync 阶段不参与 ON CONFLICT 更新,保留作者已设置的值(沿用 is_ignore 模式)。
 */
export function updateNodeGroup(db: Database, nodeToken: string, group: string): void {
    db.run('UPDATE nodes SET "group"=? WHERE node_token=?', [group, nodeToken]);
}

/** 节点优先级 +1。下载阶段 callback 在被引方存在但 human_path 为空时调用。 */
export function incrementNodePriority(db: Database, nodeToken: string): void {
    db.run('UPDATE nodes SET priority = priority + 1 WHERE node_token=?', [nodeToken]);
}

export function deleteNodeByToken(db: Database, nodeToken: string): void {
    db.run('DELETE FROM nodes WHERE node_token=?', [nodeToken]);
}

export function getAllIndexedFiles(db: Database): Set<string> {
    const rows = db.query('SELECT file_path FROM nodes').all() as { file_path: string }[];
    // 过滤空字符串：sync 阶段为非 doc/docx 节点占位写入空 file_path（schema NOT NULL），
    // 避免 Phase 2 把它们当成"索引中的文件"。
    return new Set(rows.map((r) => r.file_path).filter((p) => p !== ''));
}

/**
 * 清理一组孤儿节点：删除 nodes 行 + 本地 .md 文件 + 通过 cleanupOrphanImages
 * 清理 images 行 / 本地 temp 图片 / OSS（cleanupOrphanImages 内部副作用负责
 * deleteImageByMd5AndNode，所以 images 行必须在它调用之后才被删除）。
 *
 * 顺序：SELECT file_paths + image_pairs → DELETE nodes → rmSync 本地文件 →
 * for each (md5, node_token): cleanupOrphanImages。
 *
 * @returns 被清理的本地 .md 相对路径列表（供日志用）
 */
export function purgeOrphanNodes(
    db: Database,
    nodeTokens: string[],
    outputDir: string,
    ossConfig: OssClientConfig | null
): { filePaths: string[] } {
    if (nodeTokens.length === 0) return { filePaths: [] };

    const placeholders = nodeTokens.map(() => '?').join(',');
    // 过滤空 file_path：非 doc/docx 节点占位写入空字符串，join(outputDir, '') 会变成 outputDir 自己，
    // 误删整个目录必须排除。
    const filePaths = (
        db.query(`SELECT file_path FROM nodes WHERE node_token IN (${placeholders})`)
            .all(...nodeTokens) as { file_path: string }[]
    ).map((r) => r.file_path).filter((p) => p !== '');
    const imagePairs = db
        .query(`SELECT md5, node_token FROM image_vs_node WHERE node_token IN (${placeholders})`)
        .all(...nodeTokens) as { md5: string; node_token: string }[];

    db.prepare(`DELETE FROM nodes WHERE node_token IN (${placeholders})`).run(...nodeTokens);

    for (const fp of filePaths) {
        const abs = join(outputDir, fp);
        if (existsSync(abs)) rmSync(abs);
    }

    for (const { md5, node_token } of imagePairs) {
        cleanupOrphanImages(db, [md5], node_token, outputDir, ossConfig);
    }

    return { filePaths };
}

// ============ Image CRUD ============

export function upsertImage(db: Database, md5: string, ext: string, ossUrl: string | null, uploaded: number): void {
    db.run(
        `INSERT INTO images (md5, ext, oss_url, uploaded, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(md5) DO UPDATE SET ext=excluded.ext, oss_url=excluded.oss_url, uploaded=excluded.uploaded`,
        [md5, ext, ossUrl, uploaded, new Date().toISOString()]
    );
}

/** 把 md5 登记为 nodeToken 引用的图片（幂等，重复插入同一对忽略）。 */
export function addImageRef(db: Database, md5: string, nodeToken: string): void {
    db.run(
        'INSERT OR IGNORE INTO image_vs_node (md5, node_token) VALUES (?, ?)',
        [md5, nodeToken]
    );
}

export function getImageByMd5(db: Database, md5: string): DBImage | null {
    return db.query('SELECT md5, ext, oss_url, uploaded, created_at FROM images WHERE md5=?').get(md5) as DBImage | null;
}

export function getImagesByNode(db: Database, nodeToken: string): DBImage[] {
    return db.query(
        `SELECT i.md5, i.ext, i.oss_url, i.uploaded, i.created_at
       FROM images i
       INNER JOIN image_vs_node r ON r.md5 = i.md5
       WHERE r.node_token = ?`
    ).all(nodeToken) as DBImage[];
}

export function deleteImageByMd5AndNode(db: Database, md5: string, nodeToken: string): void {
    db.run('DELETE FROM image_vs_node WHERE md5=? AND node_token=?', [md5, nodeToken]);
}

export function countImageRefs(db: Database, md5: string, excludeNodeToken: string): number {
    const row = db.query(
        'SELECT COUNT(*) AS cnt FROM image_vs_node WHERE md5=? AND node_token!=?'
    ).get(md5, excludeNodeToken) as { cnt: number } | null;
    return row?.cnt ?? 0;
}
