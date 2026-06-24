// 飞书节点 updated_at 批量更新流程 (cmd.feishu sync-updated-at)
// 从 DB 查询节点队列，并发调用 wiki +node-get 获取编辑时间并写入数据库

import type { SyncUpdatedAtArgs } from '../feishu';
import { C } from '../shared/colors';
import { fetchNodeMetaAsync } from './api';
import { closeDB, deleteNodeByToken, ensureDB, getDB, updateNodeUpdatedAt } from './db';
import { createRateLimiter, FeishuAPIError, writeProgress } from './utils';

/**
 * 批量更新节点的 updated_at 字段。
 *
 * 支持三种范围：
 * - 全量（默认）：所有节点（不按 obj_type 过滤）
 * - 按空间（--space）：指定知识库空间的节点
 * - 按节点（--node-token）：单个节点
 *
 * --max-age <分钟数> 可过滤只更新上次同步距今超过指定时长的节点。
 * 不传时全量更新（向后兼容）。单节点模式不受 maxAge 限制。
 */
export async function runSyncUpdatedAt(args: SyncUpdatedAtArgs) {
    const outputDir = args.output;
    const maxAge = args.maxAge;

    console.log(`\n  ${C.bold}同步节点编辑时间${C.reset}`);
    console.log(`  ${C.dim}输出目录: ${outputDir}${C.reset}\n`);

    const db = getDB(outputDir);
    ensureDB(db);

    // maxAge 过滤条件（单节点模式不限制）
    const maxAgeFilter = maxAge && maxAge > 0 && !args.nodeToken
        ? 'AND (updated_at_last_synced_at IS NULL OR updated_at_last_synced_at < ?)'
        : '';
    const maxAgeParam = maxAge && maxAge > 0 && !args.nodeToken
        ? new Date(Date.now() - maxAge * 60 * 1000).toISOString()
        : null;

    // 构建查询队列
    let nodes: { node_token: string; obj_token: string; title: string; obj_type: string }[];

    if (args.nodeToken) {
    // 按单节点
        const row = db
            .query('SELECT node_token, obj_token, title, obj_type FROM nodes WHERE node_token=? ORDER BY priority DESC, node_token ASC')
            .get(args.nodeToken) as { node_token: string; obj_token: string; title: string; obj_type: string } | null;
        if (!row) {
            closeDB();
            throw new Error(`未找到节点: ${args.nodeToken}`);
        }
        nodes = [row];
    } else if (args.spaces.length > 0) {
    // 按空间
        const placeholders = args.spaces.map(() => '?').join(',');
        const params: (string | number)[] = [...args.spaces];
        if (maxAgeParam) params.push(maxAgeParam);
        nodes = db
            .query(
                `SELECT node_token, obj_token, title, obj_type FROM nodes WHERE space_id IN (${placeholders}) ${maxAgeFilter} ORDER BY priority DESC, node_token ASC`
            )
            .all(...params) as {
            node_token: string;
            obj_token: string;
            title: string;
            obj_type: string;
        }[];
    } else {
    // 全量
        const whereClause = maxAgeFilter
            ? 'WHERE (updated_at_last_synced_at IS NULL OR updated_at_last_synced_at < ?)'
            : '';
        const params: (string | number)[] = [];
        if (maxAgeParam) params.push(maxAgeParam);
        nodes = db
            .query(`SELECT node_token, obj_token, title, obj_type FROM nodes ${whereClause} ORDER BY priority DESC, node_token ASC`)
            .all(...params) as {
            node_token: string;
            obj_token: string;
            title: string;
            obj_type: string;
        }[];
    }

    if (nodes.length === 0) {
        console.log(`  ${C.yellow}⚠${C.reset} 没有待更新的节点\n`);
        closeDB();
        return;
    }

    console.log(`  ${C.dim}待更新节点: ${nodes.length} 个${C.reset}\n`);

    // 并发获取 updated_at，这个接口限流 100 次/分钟, 所以限流 1.6 次/秒
    const metaLimiter = createRateLimiter(1.6);
    let completed = 0;
    let failed = 0;
    let written = 0;
    let deleted = 0;

    await Promise.all(
        nodes.map(async (node) => {
            try {
                await metaLimiter();
                const meta = await fetchNodeMetaAsync(node.obj_token, node.obj_type);
                completed++;
                writeProgress(
                    `    ${C.cyan}⠋${C.reset} 获取编辑时间... ${completed}/${nodes.length}`
                );
                if (meta?.updated_at) {
                    updateNodeUpdatedAt(db, node.node_token, meta.updated_at);
                    written++;
                    return;
                }
                failed++;
            } catch (err) {
                if (err instanceof FeishuAPIError) {
                    // rate_limit
                    if (err.code === 99991400) {
                        failed++;
                    }
                    // not found
                    if (err.code === 131005) {
                        deleteNodeByToken(db, node.node_token);
                        deleted++;
                    }
                } else {
                    failed++;
                }
                completed++;
                writeProgress(
                    `    ${C.cyan}⠋${C.reset} 获取编辑时间... ${completed}「DEL: ${deleted}, Fail: ${failed}」/${nodes.length}`
                );
            }
        })
    );

    writeProgress('');

    console.log(`\n  ${C.bold}更新完成${C.reset}\n`);
    console.log(
        `  ${C.green}✓${C.reset} 写入: ${written}  `
        + `${C.red}✗${C.reset} 失败: ${failed}  `
        + `${C.red}⚠${C.reset} 已删除: ${deleted}`
    );
    console.log();

    closeDB();
}
