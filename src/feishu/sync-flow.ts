// 飞书索引同步流程 (cmd.feishu sync)

import { join, relative, sep } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { C } from '../shared/colors';
import { writeProgress, sanitize, findMdFiles, cleanupEmptyDirs, execJSON } from './utils';
import {
    getDB, closeDB, upsertSpace, deleteSpace, getSpaceIds,
    getNode, getAllIndexedFiles, purgeOrphanNodes, getImagesByNode
} from './db';
import { cleanupOrphanImages } from './images';
import { fetchSpaces, fetchAllNodes, FETCHABLE_TYPES, buildPath, type WikiNode } from './api';
import { loadConfig, buildOssConfig } from '../config';
import { collectAllAimDirectories } from './aim-dir';
import type { SyncArgs } from '../feishu';

/**
 * Phase 2 清理逻辑:对一组磁盘 .md 文件,按"是否在索引中"和"是否在 aimDirectory 子树内"分类。
 * - 不在索引中且不在 aimDirectory 子树内 → 标记删除
 * - 在 aimDirectory 子树内(命中绝对路径或以 aim+sep 为前缀)→ 标记排除(由 copy-docs 管辖)
 * - 在索引中 → 保留
 *
 * 抽出为纯函数供测试,避免 mock 整个 runSync。返回相对 outputDir 的路径。
 */
export function classifyLocalFiles(
    localMdFiles: string[],
    outputDir: string,
    indexedFiles: Set<string>,
    aimDirs: string[]
): { toRemove: string[]; excludedByAim: string[] } {
    const toRemove: string[] = [];
    const excludedByAim: string[] = [];
    for (const mdFile of localMdFiles) {
        // 命中任一 aimDirectory(等于该路径或在其子树内) → 排除
        if (aimDirs.some(aim => mdFile === aim || mdFile.startsWith(aim + sep))) {
            excludedByAim.push(relative(outputDir, mdFile));
            continue;
        }
        const relPath = relative(outputDir, mdFile);
        if (!indexedFiles.has(relPath)) {
            toRemove.push(relPath);
        }
    }
    return { toRemove, excludedByAim };
}

/**
 * 按 obj_type 分组统计节点计数，格式化为紧凑展示字符串。
 * doc/docx 归为"文档"展示，其他类型归为"其他类型"展示。
 */
function formatObjTypeCounts(counts: Map<string, number>, docNodeCount: number): string {
    const docParts: string[] = [];
    for (const t of FETCHABLE_TYPES) {
        const n = counts.get(t) ?? 0;
        if (n > 0) docParts.push(`${t}: ${n}`);
    }
    const otherParts: string[] = [];
    for (const [type, n] of counts) {
        if (!FETCHABLE_TYPES.has(type) && n > 0) otherParts.push(`${type}: ${n}`);
    }
    const docSegment = `${docNodeCount} 文档${docParts.length > 0 ? ` [${docParts.join(', ')}]` : ''}`;
    const otherSegment = otherParts.length > 0 ? `, ${otherParts.length} 其他类型 [${otherParts.join(', ')}]` : '';
    return `${docSegment}${otherSegment}`;
}

export async function runSync(args: SyncArgs) {
    const outputDir = args.output;

    // 检查 lark-cli
    const larkCheck = Bun.spawnSync(['lark-cli', '--help'], { stdout: 'pipe', stderr: 'pipe' });
    if (larkCheck.exitCode !== 0) {
        throw new Error('lark-cli 未安装: https://github.com/larksuite/cli');
    }

    // 检查认证
    let authOk: boolean;
    try {
        authOk = !!execJSON(['wiki', '+space-list', '--page-size', '1', '--json', '--as', 'user']);
    } catch {
        authOk = false;
    }
    if (!authOk) {
        throw new Error('请先登录授权:\n  lark-cli auth login --domain wiki,docs');
    }

    // Load OSS config for image cleanup
    const cfg = await loadConfig();
    const ossConfig = buildOssConfig(cfg);

    console.log(`\n  ${C.bold}飞书知识库索引同步${C.reset}`);
    console.log(`  ${C.dim}输出目录: ${outputDir}${C.reset}\n`);

    mkdirSync(outputDir, { recursive: true });

    const db = getDB(outputDir);

    console.log(`  ${C.bold}[Phase 1]${C.reset} 扫描知识库元数据\n`);

    const spaces = fetchSpaces();
    if (spaces.length === 0) {
        console.log(`  ${C.yellow}⚠${C.reset} 未找到可访问的知识库`);
        return;
    }

    const targetSpaces = args.spaces.length > 0
        ? spaces.filter((s) => args.spaces.includes(s.space_id))
        : spaces;

    if (targetSpaces.length === 0) {
        console.log(`  ${C.yellow}⚠${C.reset} 指定的知识库 ID 未找到匹配`);
        console.log(`  ${C.dim}可用知识库:${C.reset}`);
        for (const s of spaces) console.log(`    ${s.space_id}  ${s.name}`);
        throw new Error('指定的知识库 ID 未找到匹配');
    }

    console.log(`  ${C.green}✓${C.reset} ${targetSpaces.length} 个知识库`);

    let totalNodes = 0;
    let totalDocNodes = 0;
    const totalObjTypeCounts = new Map<string, number>();
    const scannedAt = new Date().toISOString();

    const upsertNodeStmt = db.prepare(
        `INSERT INTO nodes (node_token, space_id, title, obj_token, obj_type, file_path, updated_at, updated_at_last_synced_at, scanned_at, parent_node_token, downloaded_at, human_path, is_ignore, "group")
     VALUES ($nodeToken, $spaceId, $title, $objToken, $objType, $filePath, $updatedAt, $updatedAtLastSyncedAt, $scannedAt, $parentNodeToken, $downloadedAt, $humanPath, $isIgnore, $group)
     ON CONFLICT(node_token) DO UPDATE SET
       title=excluded.title, obj_token=excluded.obj_token, obj_type=excluded.obj_type,
       file_path=excluded.file_path, updated_at=excluded.updated_at,
       updated_at_last_synced_at=excluded.updated_at_last_synced_at,
       scanned_at=excluded.scanned_at,
       parent_node_token=excluded.parent_node_token,
       downloaded_at=excluded.downloaded_at,
       human_path=excluded.human_path`
    );

    for (const space of targetSpaces) {
        writeProgress(`    ${C.cyan}⠋${C.reset} ${space.name} 扫描节点...`);

        const nodeMap = new Map<string, WikiNode>();
        let nodeCount = 0;
        let docNodeCount = 0;
        const objTypeCounts = new Map<string, number>();

        upsertSpace(db, space);

        const spaceDirName = sanitize(space.name);
        const usedPaths = new Set<string>();

        for await (const node of fetchAllNodes(space.space_id, space.name)) {
            nodeMap.set(node.node_token, node);
            nodeCount++;
            objTypeCounts.set(node.obj_type, (objTypeCounts.get(node.obj_type) ?? 0) + 1);

            const isDownloadable = FETCHABLE_TYPES.has(node.obj_type);
            if (isDownloadable) docNodeCount++;

            // 非 doc/docx 节点的 file_path 用空字符串占位（schema NOT NULL 不允许 NULL），
            // purgeOrphanNodes / getAllIndexedFiles 已做防御性过滤。
            let relPath = '';
            let downloadedAt: string | null = null;
            let updatedAtLastSyncedAt: string | null = null;
            let humanPath: string | null = null;

            const oldNode = getNode(db, node.node_token);
            const nodeUpdatedAt = oldNode?.updated_at ?? null;
            // 新节点的 is_ignore 默认 0；已存在节点的 is_ignore 由 ON CONFLICT 保留（不参与 SET 子句）
            const isIgnore = 0;

            if (isDownloadable) {
                const docPath = buildPath(node, nodeMap);
                relPath = `${spaceDirName}/${docPath}.md`;
                let counter = 1;
                while (usedPaths.has(relPath)) {
                    relPath = `${spaceDirName}/${docPath}_${counter}.md`;
                    counter++;
                }
                usedPaths.add(relPath);

                if (oldNode?.downloaded_at) {
                    const filePath = join(outputDir, relPath);
                    if (existsSync(filePath)) {
                        downloadedAt = oldNode.downloaded_at;
                        updatedAtLastSyncedAt = oldNode.updated_at_last_synced_at ?? null;
                        humanPath = oldNode.human_path ?? null;
                    }
                }
                // When downloaded_at is cleared (file missing locally), all derived fields also reset (defaults above)
                // updatedAtLastSyncedAt also resets to NULL when downloaded_at is cleared
            }

            upsertNodeStmt.run({
                $nodeToken: node.node_token,
                $spaceId: space.space_id,
                $title: node.title,
                $objToken: node.obj_token,
                $objType: node.obj_type,
                $filePath: relPath,
                $updatedAt: nodeUpdatedAt,
                $updatedAtLastSyncedAt: updatedAtLastSyncedAt,
                $scannedAt: scannedAt,
                $parentNodeToken: node.parent_node_token,
                $downloadedAt: downloadedAt,
                $humanPath: humanPath,
                $isIgnore: isIgnore,
                $group: 'default'
            });
        }

        totalNodes += nodeCount;
        totalDocNodes += docNodeCount;
        for (const [type, count] of objTypeCounts) {
            totalObjTypeCounts.set(type, (totalObjTypeCounts.get(type) ?? 0) + count);
        }

        writeProgress(`    ${C.green}✓${C.reset} ${space.name}: ${nodeCount} 节点 (${formatObjTypeCounts(objTypeCounts, docNodeCount)})\n`);

        // 节点级 diff: DB 有但本次扫描未返回 → 视为孤儿 → 清理
        const dbTokens = (db.query('SELECT node_token FROM nodes WHERE space_id=?').all(space.space_id) as { node_token: string }[]).map((r) => r.node_token);
        const orphanTokens = dbTokens.filter((t) => !nodeMap.has(t));
        if (orphanTokens.length > 0) {
            purgeOrphanNodes(db, orphanTokens, outputDir, ossConfig);
            console.log(`    ${C.yellow}−${C.reset} ${space.name} 清理 ${orphanTokens.length} 个孤儿节点`);
        }
    }

    upsertNodeStmt.finalize();

    console.log(`\n  ${C.dim}共 ${totalNodes} 个节点 (${formatObjTypeCounts(totalObjTypeCounts, totalDocNodes)})${C.reset}`);

    if (args.spaces.length === 0) {
        const activeSpaceIds = new Set(targetSpaces.map((s) => s.space_id));
        const dbSpaceIds = getSpaceIds(db);
        for (const spaceId of dbSpaceIds) {
            if (!activeSpaceIds.has(spaceId)) {
                const name = (db.query('SELECT name FROM spaces WHERE space_id=?').get(spaceId) as { name: string } | null)?.name ?? spaceId;
                const tokens = (db.query('SELECT node_token FROM nodes WHERE space_id=?').all(spaceId) as { node_token: string }[]).map((r) => r.node_token);
                purgeOrphanNodes(db, tokens, outputDir, ossConfig);
                deleteSpace(db, spaceId);
                if (tokens.length > 0) {
                    console.log(`  ${C.yellow}−${C.reset} 知识库 "${name}" 已删除，清理 ${tokens.length} 个文件`);
                }
            }
        }
    }

    console.log(`  ${C.green}✓${C.reset} 元数据扫描完成，索引已保存\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 2: 清理过期文档
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    console.log(`  ${C.bold}[Phase 2]${C.reset} 清理过期文档\n`);

    // Build file_path -> node_token map for Phase 2 image cleanup
    const filePathToNodeToken = new Map<string, string>();
    const allNodePaths = db.query('SELECT node_token, file_path FROM nodes').all() as { node_token: string; file_path: string }[];
    for (const np of allNodePaths) {
        filePathToNodeToken.set(np.file_path, np.node_token);
    }

    const indexedFiles = getAllIndexedFiles(db);

    // 收集所有 group 的 aimDirectory 绝对路径;sync 不会删除这些子树下的 .md 文件
    // (归 copy-docs 阶段管辖,与 sync 的 source 端清理职责隔离)
    const aimDirs = collectAllAimDirectories(cfg);

    // Phase 2 决策(纯函数):不进入 IO,便于测试
    const { toRemove, excludedByAim: excludedByAimFiles } = classifyLocalFiles(
        findMdFiles(outputDir), outputDir, indexedFiles, aimDirs
    );

    // 执行删除
    for (const relPath of toRemove) {
        rmSync(join(outputDir, relPath));
    }
    cleanupEmptyDirs(outputDir);

    const removedCount = toRemove.length;
    const removedFiles = toRemove;
    const excludedByAimCount = excludedByAimFiles.length;

    console.log(`  ${C.bold}索引完成${C.reset}\n`);
    console.log(`  ${C.green}✓${C.reset} 索引已更新  ${C.yellow}−${C.reset} 删除: ${removedCount}`);
    if (excludedByAimCount > 0) {
        console.log(`  ${C.green}✓${C.reset} aimDirectory 排除: ${excludedByAimCount}`);
    }

    if (removedFiles.length > 0) {
        console.log(`\n  ${C.dim}已删除:${C.reset}`);
        for (const f of removedFiles) {
            console.log(`    ${C.red}−${C.reset} ${f}`);
        }

        // Image cleanup for removed files (best-effort, non-blocking)
        try {
            const cleanedTokens = new Set<string>();
            for (const rf of removedFiles) {
                const nodeToken = filePathToNodeToken.get(rf);
                if (nodeToken && !cleanedTokens.has(nodeToken)) {
                    cleanedTokens.add(nodeToken);
                    const images = getImagesByNode(db, nodeToken);
                    const md5s = images.map((i) => i.md5);
                    if (md5s.length > 0) {
                        cleanupOrphanImages(db, md5s, nodeToken, outputDir, ossConfig);
                    }
                }
            }
        } catch (e) {
            console.log(`  ${C.yellow}⚠${C.reset} 图片清理异常: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (excludedByAimFiles.length > 0) {
        console.log(`\n  ${C.dim}已排除 aimDirectory (归 copy-docs 管辖, sync 不干预):${C.reset}`);
        for (const f of excludedByAimFiles) {
            console.log(`    ${C.dim}○${C.reset} ${f}`);
        }
    }

    console.log();
    closeDB();
}
