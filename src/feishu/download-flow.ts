// 飞书文档下载流程 (cmd.feishu download)

import type { Database } from 'bun:sqlite';
import { join, dirname, resolve } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { C } from '../shared/colors';
import { writeProgress, createRateLimiter, parseAndStripFrontmatter, formatUpdatedAt, resolveCiteBlocks, resolveSubPageListBlocks, resolveCalloutBlocks } from './utils';
import type { ResolveLinkResult } from './utils';
import { getDB, closeDB, getDBPath, getSpaceIds, getDownloadQueue, markNodeDownloaded, updateNodeHumanPath, updateNodeDescription, updateNodeUploadUrl, updateNodeIgnore, updateNodeGroup, updateNodeUpdatedAt, getNode, getNodeByObjToken, getImagesByNode, deleteNodeByToken } from './db';
import type { DBNode } from './db';
import { fetchDocContent, fetchNodeMetaAsync, FETCHABLE_TYPES, resolveDescription } from './api';
import { processImagesInFile, cleanupOrphanImages, cleanupGlobalOrphans, uploadToOSS } from './images';
import type { ImageFailure } from './images';
import { loadConfig, buildOssConfig } from '../config';
import type { OssClientConfig } from '../config';
import type { DownloadArgs } from '../feishu';
import { resolveAimUrl } from './aim-dir';

// ============ 共享内容处理 ============

/**
 * 处理下载后的文档内容：解析 frontmatter (slug/ignore) → 清理 YAML 代码块 → 更新 DB → 生成描述 → 构建 frontmatter。
 *
 * 返回 { slug, processedContent }：
 * - slug: 解析到的 human_path（无 slug 时为 null）
 * - processedContent: 注入 frontmatter 后的完整内容（无 slug 时为原内容）
 *
 * 此函数供 downNode 和 runDownload 共用，确保两个下载入口行为一致。
 *
 * 注意：被忽略（YAML `ignore: Y`）的文档不影响 download 流程，仍正常写入 human_path、
 * description、frontmatter 与 downloaded_at；copydocs 阶段会基于 is_ignore 过滤。
 *
 * 导出供测试用:resolveLink 闭包内的跨组引用决策与 aimUrl 解析需要直接构造 DB 节点验证。
 */
export async function processDocContent(
    content: string,
    title: string,
    updatedAt: string,
    db: Database,
    node: DBNode
): Promise<{ slug: string | null; processedContent: string; unresolvedRefCount: number }> {
    // 加载配置:resolveLink 闭包需读 refNode.group 的 aimUrl,提前到函数顶部避免闭包内 lazy load
    const cfg = await loadConfig();

    // 解析 slug、ignore、group 并移除 YAML 代码块
    const { slug, ignore, group, cleanedContent } = parseAndStripFrontmatter(content);

    // 覆盖写 is_ignore：作者去除 `ignore: Y` 时下次 download 自动回到 0
    updateNodeIgnore(db, node.node_token, ignore ? 1 : 0);

    // group 校验失败诊断:解析器对非法 group 值(大写/特殊字符/空)已降级为 'default',
    // 若原始 YAML 含 group 字段但被降级,warn 提示作者实际写入的是什么、降级到什么
    const rawGroupMatch = /```(?:ya?ml|YAML|YML)\s*\n[\s\S]*?^group[^\S\n]*:[^\S\n]*(.*)$[\s\S]*?```/m.exec(content);
    if (rawGroupMatch?.[1] !== undefined) {
        const rawGroup = rawGroupMatch[1].trim();
        if (rawGroup && group === 'default' && rawGroup !== 'default') {
            console.warn(`  ${C.yellow}⚠${C.reset} ${node.title}: YAML group "${rawGroup}" 非法(仅允许 [a-z0-9-]+),已降级为 "default"`);
        }
    }

    // 覆盖写 group：作者去掉 `group: foo` 时下次 download 自动回到 'default'
    updateNodeGroup(db, node.node_token, group);

    // 追踪未被解析的引用数量（用于延迟清理当前节点的 downloaded_at）
    let unresolvedRefCount = 0;

    // 解析 <cite> 引用块为 Markdown 链接（独立于 slug，即使无 slug 的文档也需解析引用）
    //
    // resolveLink 决策(四分支):
    // - sheet/file + upload_url → { url } (绝对 URL,跨组/同组都不变)
    // - docx + human_path + 同组(refNode.group === node.group) → { path } (相对路径,同 aimDirectory 下有效)
    // - docx + human_path + 跨组 + aimUrl 可解析 → { url } (绝对 URL,跨 aimDirectory 也能跳转)
    // - docx + human_path + 跨组 + aimUrl 不可解析 → { reason } (配置问题,保留原文 + warning)
    // - 未就绪(human_path/upload_url 缺失)→ { reason } (保留原文 + warning)
    //
    // 注:历史上被引节点"未就绪"会触发 incrementNodePriority + markNodeDownloaded(null) bump,
    // 让被引节点排到下载队列前面。但 aimUrl 缺失是配置问题,重下无法自动修复;
    // human_path 缺失同理(只能等作者补 slug 后下次 download 覆盖写)。
    // 因此跨任务(cross-group-link)统一取消所有 bump,失败路径仅靠下次 download 重试覆盖写。
    const citeResolveLink = (docId: string): ResolveLinkResult => {
        const refNode = getNode(db, docId);
        if (refNode === null) return { reason: 'doc-id 未在索引中找到，请先运行 sync' };
        if ((refNode.obj_type === 'sheet' || refNode.obj_type === 'file') && refNode.upload_url !== null) {
            return { url: refNode.upload_url };
        }
        if (refNode.obj_type === 'docx' && refNode.human_path !== null) {
            if (refNode.group === node.group) {
                return { path: refNode.human_path };
            }
            // 跨组:尝试解析被引方所在 group 的 aimUrl
            const aimUrl = resolveAimUrl(cfg, refNode.group);
            if (aimUrl) {
                return {
                    url: `${aimUrl.replace(/\/+$/, '')}/${refNode.human_path.replace(/^\/+/, '')}.html`
                };
            }
            return {
                reason: `cross-group 引用目标 group "${refNode.group}" 缺少 aimUrl 配置`
            };
        }
        return {
            reason: refNode.obj_type === 'docx'
                ? 'human_path 未设置（缺 slug）'
                : 'upload_url 未就绪'
        };
    };
    const { result: citeResult, warnings } = resolveCiteBlocks(
        cleanedContent,
        citeResolveLink
    );
    for (const w of warnings) {
        // stdout（非 stderr）：与 writeProgress 同流，避免 stdout/stderr 输出交织
        process.stdout.write(`\n  ${C.yellow}⚠${C.reset} ${w}\n`);
    }
    // 统计 cite 中因节点缺失/未就绪导致未解析的数量
    unresolvedRefCount += warnings.filter((w) => w.includes('引用解析失败')).length;

    // 解析 <sub-page-list> 块为 Markdown 无序列表（独立于 slug）
    // 与 cite 解析器共用相同的"同组 path / 跨组 url / 配置缺失 reason / 未就绪 reason"决策。
    // lookup key 不同:sub-page doc-id 是飞书文档对象的全局 ID(obj_token),而 cite doc-id 是 wiki 树节点 ID(node_token)。
    const subPageResolveLink = (objToken: string): ResolveLinkResult => {
        const refNode = getNodeByObjToken(db, objToken);
        if (refNode === null) return { reason: 'doc-id 未在索引中找到，请先运行 sync' };
        if ((refNode.obj_type === 'sheet' || refNode.obj_type === 'file') && refNode.upload_url !== null) {
            return { url: refNode.upload_url };
        }
        if (refNode.obj_type === 'docx' && refNode.human_path !== null) {
            if (refNode.group === node.group) {
                return { path: refNode.human_path };
            }
            const aimUrl = resolveAimUrl(cfg, refNode.group);
            if (aimUrl) {
                return {
                    url: `${aimUrl.replace(/\/+$/, '')}/${refNode.human_path.replace(/^\/+/, '')}.html`
                };
            }
            return {
                reason: `cross-group 引用目标 group "${refNode.group}" 缺少 aimUrl 配置`
            };
        }
        return {
            reason: refNode.obj_type === 'docx'
                ? 'human_path 未设置（缺 slug）'
                : 'upload_url 未就绪'
        };
    };
    const { result: subPageResult, warnings: subPageWarnings } = resolveSubPageListBlocks(
        citeResult,
        subPageResolveLink
    );
    for (const w of subPageWarnings) {
        // stdout（非 stderr）：与 writeProgress 同流，避免 stdout/stderr 输出交织
        process.stdout.write(`\n  ${C.yellow}⚠${C.reset} ${w}\n`);
    }
    // 统计 sub-page 中因节点缺失/未就绪导致未解析的数量
    unresolvedRefCount += subPageWarnings.filter((w) => w.includes('引用解析失败')).length;

    // 转换 <callout> 块为 VitePress ::: container 语法
    const resolvedContent = resolveCalloutBlocks(subPageResult);

    if (!slug) {
        return { slug: null, processedContent: resolvedContent, unresolvedRefCount };
    }

    // 更新 human_path
    updateNodeHumanPath(db, node.node_token, slug);

    // 生成/缓存描述（基于已解析引用链接的 resolvedContent）
    let description = node.description;
    if (description === null) {
        description = await resolveDescription(resolvedContent);
        if (description) {
            updateNodeDescription(db, node.node_token, description);
        }
    }

    // 构建 frontmatter 并注入：aimUrl 按节点 group 取(该 group 未配置时 fallback 到 default)
    const aimUrl = resolveAimUrl(cfg, group) ?? undefined;
    const frontmatter = buildFrontmatter(title, slug, description, updatedAt, aimUrl);

    return { slug, processedContent: frontmatter + resolvedContent, unresolvedRefCount };
}

// ============ 文件型节点处理 ============

/**
 * 通过 lark-cli drive +download 下载文件二进制到本地临时路径。
 * 返回 ok 状态与单行 stderr 失败原因。
 *
 * 注意：lark-cli 安全策略要求 --output 必须是当前目录的相对路径，
 * 因此用 cwd 切换到目标目录并仅传文件名，避免路径穿越校验失败。
 */
function downloadFileBinary(objToken: string, localPath: string): { ok: true } | { ok: false; reason: string } {
    const sep = localPath.lastIndexOf('/');
    if (sep === -1) {
        return { ok: false, reason: `invalid output path: ${localPath}` };
    }
    const dir = localPath.slice(0, sep);
    const filename = localPath.slice(sep + 1);

    const proc = Bun.spawnSync(
        ['lark-cli', 'drive', '+download', '--file-token', objToken, '--output', filename, '--as', 'user'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 120_000, cwd: dir }
    );
    if (proc.exitCode !== 0) {
        const err = new TextDecoder().decode(proc.stderr).trim().split('\n')[0] ?? '';
        return { ok: false, reason: err || `exit ${proc.exitCode}` };
    }
    if (!existsSync(localPath)) {
        return { ok: false, reason: 'download produced no output file' };
    }
    return { ok: true };
}

/**
 * 下载节点对应的文件并上传到 OSS，公网地址写入 nodes.upload_url，完成后标记 downloaded_at。
 * OSS 通道复用图片上传的 uploadToOSS，路径命名采用 `{node_token}.pdf`（飞书 Wiki 中文件型节点
 * obj_type='file'，常承载 PDF 等二进制文件，本地扩展名统一记为 pdf）。
 * 失败返回 false，调用方负责日志输出与重试调度。
 */
async function downFileNode(outputDir: string, db: Database, node: DBNode): Promise<boolean> {
    let ossConfig: OssClientConfig | null;
    try {
        const cfg = await loadConfig();
        ossConfig = buildOssConfig(cfg);
    } catch {
        return false;
    }
    if (!ossConfig) return false;

    const tempDir = join(outputDir, 'data', 'temp');
    mkdirSync(tempDir, { recursive: true });
    const localPath = join(tempDir, `${node.node_token}.pdf`);

    const downloaded = downloadFileBinary(node.obj_token, localPath);
    if (!downloaded.ok) {
        console.error(`  ${C.red}✗${C.reset} 文件下载失败 (${node.title}): ${downloaded.reason}`);
        return false;
    }

    const ossKey = `${node.node_token}.pdf`;
    const uploaded = uploadToOSS(localPath, ossKey, ossConfig);

    try {
        if (existsSync(localPath)) rmSync(localPath);
    } catch {
        // ignore
    }

    if (!uploaded.ok) {
        console.error(`  ${C.red}✗${C.reset} 文件 OSS 上传失败 (${node.title}): ${uploaded.reason}`);
        return false;
    }

    updateNodeUploadUrl(db, node.node_token, uploaded.url);
    // 显式传入 node.updated_at：让 downloaded_at 反映"我们已下载到的远端版本时间戳"，
    // 下次 needsDownload 比较 downloaded_at < updated_at 时相等 ⇒ 不重下，
    // 避免 sheet/file 节点因 updated_at 未在 sync 阶段刷新而每次都被重新下载。
    markNodeDownloaded(db, node.node_token, node.updated_at);
    return true;
}

/**
 * 通过 lark-cli sheets +workbook-export 把电子表格导出为 xlsx 到本地临时路径。
 * 内部走异步任务 + 轮询，最多 ~30s；返回 ok 状态与单行 stderr 失败原因。
 *
 * 注意：lark-cli 安全策略要求 --output-path 必须是当前目录的相对路径，
 * 因此用 cwd 切换到目标目录并仅传文件名，避免路径穿越校验失败。
 */
function exportSheetToXlsx(spreadsheetToken: string, localPath: string): { ok: true } | { ok: false; reason: string } {
    const sep = localPath.lastIndexOf('/');
    if (sep === -1) {
        return { ok: false, reason: `invalid output path: ${localPath}` };
    }
    const dir = localPath.slice(0, sep);
    const filename = localPath.slice(sep + 1);

    const proc = Bun.spawnSync(
        ['lark-cli', 'sheets', '+workbook-export', '--spreadsheet-token', spreadsheetToken, '--output-path', filename, '--as', 'user'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 60_000, cwd: dir }
    );
    if (proc.exitCode !== 0) {
        const err = new TextDecoder().decode(proc.stderr).trim().split('\n')[0] ?? '';
        return { ok: false, reason: err || `exit ${proc.exitCode}` };
    }
    if (!existsSync(localPath)) {
        return { ok: false, reason: 'export produced no output file' };
    }
    return { ok: true };
}

/**
 * 下载节点对应的电子表格并导出为 xlsx 上传 OSS，公网地址写入 nodes.upload_url，
 * 完成后标记 downloaded_at。
 *
 * OSS 通道复用图片上传的 uploadToOSS，路径命名采用 `{node_token}.xlsx`。
 * 失败返回 false，调用方负责日志输出与重试调度。
 */
async function downSheetNode(outputDir: string, db: Database, node: DBNode): Promise<boolean> {
    let ossConfig: OssClientConfig | null;
    try {
        const cfg = await loadConfig();
        ossConfig = buildOssConfig(cfg);
    } catch {
        return false;
    }
    if (!ossConfig) return false;

    const tempDir = join(outputDir, 'data', 'temp');
    mkdirSync(tempDir, { recursive: true });
    const localPath = join(tempDir, `${node.node_token}.xlsx`);

    const exported = exportSheetToXlsx(node.obj_token, localPath);
    if (!exported.ok) {
        console.error(`  ${C.red}✗${C.reset} 表格导出失败 (${node.title}): ${exported.reason}`);
        return false;
    }

    const ossKey = `${node.node_token}.xlsx`;
    const uploaded = uploadToOSS(localPath, ossKey, ossConfig);

    try {
        if (existsSync(localPath)) rmSync(localPath);
    } catch {
        // ignore
    }

    if (!uploaded.ok) {
        console.error(`  ${C.red}✗${C.reset} 表格 OSS 上传失败 (${node.title}): ${uploaded.reason}`);
        return false;
    }

    updateNodeUploadUrl(db, node.node_token, uploaded.url);
    // 同 downFileNode：显式传入 node.updated_at 让 downloaded_at 等于远端版本时间戳，
    // 确保 needsDownload 幂等（见 db.ts:markNodeDownloaded 注释）。
    markNodeDownloaded(db, node.node_token, node.updated_at);
    return true;
}

/**
 * 单节点模式刷新 updated_at:用 wiki +node-get 拉远端最新编辑时间。
 * - 成功且新值不同:写 DB + 返回带新 updated_at 的新 node 对象(供 downNode 写 frontmatter)。
 * - 成功但值相同:no-op,返回原 node。
 * - 失败(null 或异常):warn + 返回原 node,download 继续用本地 DB 值,不阻塞。
 * 仅 --node-token 模式调用;批量模式继续用 sync 阶段刷的旧值,避免每个节点 +1 次 metadata API。
 */
export async function refreshNodeUpdatedAt(db: Database, node: DBNode): Promise<DBNode> {
    try {
        const meta = await fetchNodeMetaAsync(node.obj_token, node.obj_type);
        if (!meta?.updated_at || meta.updated_at === node.updated_at) return node;
        updateNodeUpdatedAt(db, node.node_token, meta.updated_at);
        return { ...node, updated_at: meta.updated_at };
    } catch (e) {
        console.warn(`  ${C.yellow}⚠${C.reset} 刷新 updated_at 失败 (${node.title}): ${e instanceof Error ? e.message : String(e)}`);
        return node;
    }
}

// Down download a single document (reused by --node-token and download flows)
export async function downNode(
    outputDir: string,
    db: Database,
    node: DBNode,
    waitForSlot: () => Promise<void>
): Promise<{ ok: boolean; unresolvedRefCount: number }> {
    // 文件型节点：通过 lark-cli drive +download 下载二进制，按 node_token 命名上传 OSS，
    // 公网地址写入 nodes.upload_url，复用图片上传的 OSS 通道。
    if (node.obj_type === 'file') {
        const ok = await downFileNode(outputDir, db, node);
        return { ok, unresolvedRefCount: 0 };
    }

    // 表格型节点：通过 lark-cli sheets +workbook-export 导出 xlsx 后上传 OSS。
    if (node.obj_type === 'sheet') {
        const ok = await downSheetNode(outputDir, db, node);
        return { ok, unresolvedRefCount: 0 };
    }

    if (!FETCHABLE_TYPES.has(node.obj_type)) {
        throw new Error(`暂不支持下载 obj_type=${node.obj_type} 的节点`);
    }
    try {
        const content = await fetchDocContent(node.obj_token, waitForSlot);
        if (content) {
            const filePath = join(outputDir, node.file_path);
            mkdirSync(dirname(filePath), { recursive: true });

            const updatedAt = node.updated_at ? formatUpdatedAt(node.updated_at) : '';

            const { processedContent, unresolvedRefCount } = await processDocContent(content, node.title, updatedAt, db, node);

            await Bun.write(filePath, processedContent);
            // downloaded_at 由 uploadImagesForNode 在图片处理完成后写入

            return { ok: true, unresolvedRefCount };
        }
        return { ok: false, unresolvedRefCount: 0 };
    } catch (e) {
        if (e instanceof Error) {
            if (e.message.includes('3380003')) {
                // 清理该节点关联的 OSS 图片和本地临时文件
                const images = getImagesByNode(db, node.node_token);
                const md5s = images.map((i) => i.md5);
                let ossConfig: OssClientConfig | null;
                // aimDirectory 列表:遍历所有配置 group(包括当前 group 和 default),
                // 清理 human_path.md 在任一 aimDirectory 下的副本,避免 group 切换后旧副本遗留
                const aimDirectories: string[] = [];
                try {
                    const cfg = await loadConfig();
                    ossConfig = buildOssConfig(cfg);
                    if (cfg.feishu) {
                        for (const [key, value] of Object.entries(cfg.feishu)) {
                            if (key === 'dir' || typeof value !== 'object') continue;
                            if (value.aimDirectory) {
                                aimDirectories.push(resolve(process.cwd(), value.aimDirectory));
                            }
                        }
                    }
                } catch {
                    ossConfig = null;
                    // config load failure — proceed without OSS cleanup
                }
                if (md5s.length > 0) {
                    cleanupOrphanImages(db, md5s, node.node_token, outputDir, ossConfig);
                }

                // 删除本地 Markdown 文件
                const filePath = join(outputDir, node.file_path);
                if (existsSync(filePath)) {
                    rmSync(filePath);
                }

                // 删除所有 aimDirectory 下的副本文件(节点可能因 group 切换而留有旧副本)
                if (node.human_path) {
                    for (const aimDir of aimDirectories) {
                        const aimPath = join(aimDir, `${node.human_path}.md`);
                        if (existsSync(aimPath)) {
                            rmSync(aimPath);
                        }
                    }
                }

                // 删除 nodes 数据库记录
                deleteNodeByToken(db, node.node_token);
                console.error(`  ${C.red}✗${C.reset} 下载失败: 文档 ${node.title} 被删除, 本地数据已清理`);
            }
        }
        return { ok: false, unresolvedRefCount: 0 };
    }
}

// ============ 共享图片处理 ============

/**
 * 上传单个节点文件中的图片到 OSS。
 * 对文件存在的节点调用 processImagesInFile，完成后写入 downloaded_at。
 * 文件不存在时短路返回（不写 downloaded_at → 节点会进入下次重试）。
 *
 * 此函数由单节点模式和批量 worker 在每个节点下载成功后立即调用，
 * 实现"下载一篇 → 上传一篇"的流水线模式，避免全部下载完后再串行上传的尾延迟。
 *
 * 防御性短路：file/sheet 等非 doc/docx 节点 file_path 为空占位字符串，
 * 跳过图片处理以避免 join(outputDir, '') 解析为 outputDir 目录本身、
 * processImagesInFile 读取时抛 "Directories cannot be read like files"。
 */
export async function uploadImagesForNode(
    outputDir: string,
    db: import('bun:sqlite').Database,
    node: { file_path: string; node_token: string },
    ossConfig: OssClientConfig | null,
    waitForSlot: () => Promise<void>,
    onProgress?: (current: number, total: number) => void
): Promise<{ processed: number; failed: number; failures: ImageFailure[] }> {
    if (node.file_path === '') return { processed: 0, failed: 0, failures: [] };

    const filePath = join(outputDir, node.file_path);
    if (!existsSync(filePath)) return { processed: 0, failed: 0, failures: [] };

    const result = await processImagesInFile(filePath, outputDir, db, ossConfig, waitForSlot, node.node_token, onProgress);
    markNodeDownloaded(db, node.node_token);
    return result;
}

/** 截断失败原因到单行 200 字符(去掉 aliyun CLI 多行 stderr 的换行)。 */
function formatReason(reason: string): string {
    const oneLine = reason.split('\n')[0] ?? reason;
    return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

/** 打印单节点的图片失败详情(single 模式直接调用,无截断)。 */
function printFailuresForNode(label: string, failures: ImageFailure[]): void {
    if (failures.length === 0) return;
    console.log(`  ${C.red}✗${C.reset} ${label} (${failures.length} 张):`);
    for (const f of failures) {
        console.log(`    - ${f.url}: ${formatReason(f.reason)}`);
    }
}

/** 打印 batch 模式汇总的图片失败详情(按节点截断,避免输出过载)。 */
function printBatchFailureSummary(
    perNode: { label: string; failures: ImageFailure[] }[],
    maxNodes: number,
    maxPerNode: number
): void {
    const nodesWithFailures = perNode.filter((n) => n.failures.length > 0);
    if (nodesWithFailures.length === 0) return;
    const totalImages = nodesWithFailures.reduce((sum, n) => sum + n.failures.length, 0);
    console.log(`\n  ${C.bold}图片失败详情${C.reset} (${nodesWithFailures.length} 个节点, ${totalImages} 张):`);
    const shown = nodesWithFailures.slice(0, maxNodes);
    for (const { label, failures } of shown) {
        const slice = failures.slice(0, maxPerNode);
        console.log(`  ${C.red}✗${C.reset} ${label} (${failures.length} 张):`);
        for (const f of slice) {
            console.log(`    - ${f.url}: ${formatReason(f.reason)}`);
        }
        if (failures.length > maxPerNode) {
            console.log(`    ${C.dim}... 还有 ${failures.length - maxPerNode} 张未列出${C.reset}`);
        }
    }
    if (nodesWithFailures.length > maxNodes) {
        console.log(`  ${C.dim}... 还有 ${nodesWithFailures.length - maxNodes} 个节点未列出${C.reset}`);
    }
}

// ============ Frontmatter ============

/**
 * YAML 单引号字符串内的单引号转义:每个 `'` → `''`。
 * 用于 description / title 等可能含撇号(英文所有格、缩写)的内容,避免终止 YAML 字符串。
 */
function escapeYamlSingleQuoted(s: string): string {
    return s.replace(/'/g, "''");
}

/**
 * 移除字符串中的 `<` 和 `>` 字符。
 *
 * 飞书文档常含命令签名 / 模板占位符,如 "PUBSUB <subcommand> [argument [argument …]]"、
 * "EVAL <script> <numkeys>"。这些尖括号在最终落地的 frontmatter / Markdown 链接文本中
 * 会被 HTML 渲染吃掉(把 <subcommand> 当成未知 HTML 标签),前端显示成 "PUBSUB subcommand ..."。
 *
 * 选择直接 strip 而非 HTML 实体转义(&lt; / &gt;)的原因：
 * - 占位符语义用方括号 [argument] 已表达,尖括号本身没有保留价值
 * - 避免在 frontmatter 里散布 HTML 实体,保持源可读
 * - 移除外层尖括号后,内部 subcommand 等字面文本保留
 *
 * 仅作用于尖括号,不动方括号 / 反引号 / 其他 Markdown 特殊字符。
 */
function stripAngleBrackets(s: string): string {
    return s.replace(/[<>]/g, '');
}

/**
 * 为已下载的文档构建 Vitepress 兼容的 YAML frontmatter。
 * 包含 og:title / og:type / og:description / og:url 元标签及 lastUpdated 时间戳。
 * 当 aimUrl 为空或不传时，跳过 og:url 行。
 *
 * 字段值处理链：
 * 1. escapeYamlSingleQuoted — 撇号转义,避免 YAML 字符串被提前终止("What's New" → "What''s New")
 * 2. stripAngleBrackets — 移除尖括号,避免 HTML 渲染时把 <subcommand> 当成未知标签("PUBSUB <subcommand> ..." → "PUBSUB subcommand ...")
 */
export function buildFrontmatter(
    nodeTitle: string,
    slug: string,
    description: string,
    updatedAt: string,
    aimUrl?: string
): string {
    const title = stripAngleBrackets(escapeYamlSingleQuoted(nodeTitle));
    const desc = stripAngleBrackets(escapeYamlSingleQuoted(description));
    const updated = stripAngleBrackets(escapeYamlSingleQuoted(updatedAt));
    const url = aimUrl
        ? stripAngleBrackets(escapeYamlSingleQuoted(`${aimUrl.replace(/\/+$/, '')}/${slug.replace(/^\/+/, '')}.html`))
        : '';

    const lines: string[] = ['---'];
    lines.push(`description: '${desc}'`);
    lines.push(`lastUpdated: '${updated}'`);
    lines.push('head:');
    lines.push('  - - meta');
    lines.push("    - name: 'og:title'");
    lines.push(`      content: '${title}'`);
    lines.push('  - - meta');
    lines.push("    - name: 'og:type'");
    lines.push("      content: 'article'");
    lines.push('  - - meta');
    lines.push("    - name: 'og:description'");
    lines.push(`      content: '${desc}'`);
    if (aimUrl) {
        lines.push('  - - meta');
        lines.push("    - name: 'og:url'");
        lines.push(`      content: '${url}'`);
    }
    lines.push('---\n');
    return lines.join('\n');
}

export async function runDownload(args: DownloadArgs) {
    const outputDir = args.output;
    const dbPath = getDBPath(outputDir);

    if (!existsSync(dbPath)) {
        throw new Error(
            `数据库不存在: ${dbPath}\n  请先运行 "bun run src/feishu.ts sync"`
        );
    }

    console.log(`\n  ${C.bold}下载文档${C.reset}`);
    console.log(`  ${C.dim}输出目录: ${outputDir}${C.reset}\n`);

    const db = getDB(outputDir);

    const downloadLimiter = createRateLimiter(1.6);
    const uploadLimiter = createRateLimiter(2);

    let ossConfig: OssClientConfig | null;
    try {
        const cfg = await loadConfig();
        ossConfig = buildOssConfig(cfg);
    } catch {
        ossConfig = null;
        // config load failure — proceed without OSS
    }

    if (ossConfig) {
        const aliCheck = Bun.spawnSync(['aliyun', '--help'], { stdout: 'pipe', stderr: 'pipe' });
        if (aliCheck.exitCode !== 0) {
            console.error(`  ${C.yellow}⚠${C.reset} aliyun CLI 未安装，将仅保存图片到本地`);
            ossConfig = null;
        }
    } else {
        console.log(`  ${C.dim}OSS 配置不完整，将仅保存图片到本地${C.reset}`);
    }

    // ============ 单节点模式 ============
    if (args.nodeToken) {
        let node = getNode(db, args.nodeToken);
        if (!node) {
            closeDB();
            throw new Error(
                `未找到节点: ${args.nodeToken}\n  请先运行 sync 以确保索引是最新的`
            );
        }

        // 单节点模式:先刷新 updated_at 再下载,frontmatter 的 lastUpdated 与下次 needsDownload
        // 才反映真实远端编辑时间。批量模式不调用,避免每个节点 +1 次 metadata API。
        node = await refreshNodeUpdatedAt(db, node);

        console.log(`  ${C.dim}节点: ${node.title} (${node.obj_type})${C.reset}\n`);

        const { ok, unresolvedRefCount } = await downNode(outputDir, db, node, downloadLimiter);
        if (!ok) {
            closeDB();
            throw new Error(`下载失败: ${node.title}`);
        }

        console.log(`  ${C.green}✓${C.reset} ${node.title} 下载完成`);

        if (node.obj_type !== 'file' && node.obj_type !== 'sheet') {
            const shortTitle = node.title.length > 40 ? node.title.slice(0, 37) + '...' : node.title;
            const result = await uploadImagesForNode(
                outputDir, db, node, ossConfig, uploadLimiter,
                (current, total) => {
                    writeProgress(`    ${C.cyan}↓${C.reset} ${shortTitle} ${C.dim}(图片 ${current}/${total})${C.reset}`);
                }
            );
            console.log(
                `  ${C.green}✓${C.reset} 图片处理: ${result.processed}  `
                + `${C.red}✗${C.reset} 失败: ${result.failed}`
            );
            if (result.failures.length > 0) {
                printFailuresForNode(node.title, result.failures);
            }
        }

        // 引用解析未完成时，置空当前节点的 downloaded_at 确保下次 download 重新处理引用
        if (unresolvedRefCount > 0) {
            markNodeDownloaded(db, node.node_token, null);
            console.log(`  ${C.yellow}⚠${C.reset} ${unresolvedRefCount} 处引用未解析，已标记为待重新下载`);
        }

        console.log();
        closeDB();
        return;
    }

    // ============ 批量模式 ============
    const spaces = getSpaceIds(db);
    const targetSpaces = args.spaces.length > 0
        ? Array.from(spaces).filter(s => args.spaces.includes(s))
        : Array.from(spaces);

    if (targetSpaces.length === 0) {
        console.log(`  ${C.yellow}⚠${C.reset} 没有匹配的知识库`);
        closeDB();
        return;
    }

    // 预缓存 space_id → name 映射，避免 worker 内重复查库
    const spaceNames = new Map<string, string>();
    for (const spaceId of targetSpaces) {
        const row = db.query('SELECT name FROM spaces WHERE space_id=?').get(spaceId) as { name: string } | null;
        if (row) spaceNames.set(spaceId, row.name);
    }

    const downloadQueue = getDownloadQueue(db, targetSpaces, args.force);

    const allDocNodes = getDownloadQueue(db, targetSpaces, true);
    const totalAlreadyActual = allDocNodes.length - downloadQueue.length;

    if (downloadQueue.length === 0) {
        console.log(`  ${C.green}✓${C.reset} 所有文档已是最新 (${totalAlreadyActual} 个)，无需下载\n`);
        closeDB();
        return;
    }

    console.log(
        `  ${C.dim}${downloadQueue.length} 个文档需要下载, ${totalAlreadyActual} 个已是最新${C.reset}\n`
    );

    let synced = 0;
    let failed = 0;
    let imagesProcessed = 0;
    let imagesFailed = 0;
    let totalUnresolved = 0;
    const errors: { title: string; error: string }[] = [];
    const imageFailures: { label: string; failures: ImageFailure[] }[] = [];

    // 串行逐节点处理：下载 → 图片 → 下一个节点（图片处理期间不下载其他节点）
    for (let idx = 0; idx < downloadQueue.length; idx++) {
        const node = downloadQueue[idx]!;
        const shortTitle = node.title.length > 40 ? node.title.slice(0, 37) + '...' : node.title;
        writeProgress(`    ${C.dim}[${idx + 1}/${downloadQueue.length}]${C.reset} ${C.cyan}↓${C.reset} ${shortTitle}`);

        // 1. 下载节点内容
        try {
            const { ok, unresolvedRefCount } = await downNode(outputDir, db, node, downloadLimiter);
            if (!ok) {
                failed++;
                const spaceName = spaceNames.get(node.space_id) ?? node.space_id;
                errors.push({
                    title: `${spaceName} / ${node.title}`,
                    error: '下载失败'
                });
                continue;
            }
            synced++;

            if (unresolvedRefCount > 0) {
                markNodeDownloaded(db, node.node_token, null);
                totalUnresolved++;
            }
        } catch (e) {
            failed++;
            const spaceName = spaceNames.get(node.space_id) ?? node.space_id;
            errors.push({
                title: `${spaceName} / ${node.title}`,
                error: e instanceof Error ? e.message : String(e)
            });
            continue;
        }

        // 2. 处理图片（仅 doc/docx；file/sheet 在 downNode 内部已完成 OSS 上传）
        if (node.obj_type !== 'file' && node.obj_type !== 'sheet') {
            const result = await uploadImagesForNode(
                outputDir, db, node, ossConfig, uploadLimiter,
                (current, total) => {
                    writeProgress(
                        `    ${C.dim}[${idx + 1}/${downloadQueue.length}]${C.reset} ${C.cyan}📷${C.reset} ${shortTitle} ${C.dim}(图片 ${current}/${total})${C.reset}`
                    );
                }
            );
            imagesProcessed += result.processed;
            imagesFailed += result.failed;
            if (result.failures.length > 0) {
                const spaceName = spaceNames.get(node.space_id) ?? node.space_id;
                imageFailures.push({
                    label: `${spaceName} / ${node.title}`,
                    failures: result.failures
                });
            }
        }
    }

    writeProgress('');

    console.log(`  ${C.bold}下载完成${C.reset}\n`);
    console.log(
        `  ${C.green}✓${C.reset} 下载: ${synced}  `
        + `${C.dim}○${C.reset} 跳过: ${totalAlreadyActual}  `
        + `${C.red}✗${C.reset} 失败: ${failed}`
    );

    console.log(
        `  ${C.green}✓${C.reset} 图片处理: ${imagesProcessed}  `
        + `${C.red}✗${C.reset} 失败: ${imagesFailed}`
    );

    if (totalUnresolved > 0) {
        console.log(
            `  ${C.yellow}⚠${C.reset} 引用未解析: ${totalUnresolved} 个节点（已标记为待重新下载）`
        );
    }

    printBatchFailureSummary(imageFailures, 20, 5);

    if (errors.length > 0) {
        console.log(`\n  ${C.red}失败列表:${C.reset}`);
        for (const e of errors) {
            console.log(`    ${C.red}✗${C.reset} ${e.title}: ${C.dim}${e.error}${C.reset}`);
        }
    }

    // 全局孤儿图片兜底
    try {
        const orphanCleaned = cleanupGlobalOrphans(db, outputDir, ossConfig);
        if (orphanCleaned > 0) {
            console.log(`  ${C.yellow}−${C.reset} 孤儿图片清理: ${orphanCleaned}`);
        }
    } catch (e) {
        console.log(`  ${C.yellow}⚠${C.reset} 孤儿图片清理异常: ${e instanceof Error ? e.message : String(e)}`);
    }

    console.log();
    closeDB();
}
