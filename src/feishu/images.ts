// 飞书图片处理：下载、MD5 去重、OSS 上传/删除、URL 替换、孤儿清理

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getImageByMd5, getImagesByNode, countImageRefs, deleteImageByMd5AndNode, upsertImage, addImageRef } from './db';
import { findMdFiles } from './utils';
import type { OssClientConfig } from '../config';
import { C } from '../shared/colors';

// ============ 图片 URL 提取 ============

export function extractImageUrls(markdown: string): { url: string; fullMatch: string; altText: string }[] {
    const results: { url: string; fullMatch: string; altText: string }[] = [];
    const imgRe = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = imgRe.exec(markdown)) !== null) {
        results.push({ fullMatch: match[0], altText: match[1]!, url: match[2]! });
    }
    return results;
}

// ============ 图片下载 ============

/** 下载结果:成功带 buffer/扩展名,失败带可显示的原因。 */
type DownloadResult = { ok: true; buffer: ArrayBuffer; ext: string } | { ok: false; reason: string };

async function downloadImage(url: string): Promise<DownloadResult> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, 30_000);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength === 0) return { ok: false, reason: 'empty body' };
        const contentType = resp.headers.get('content-type') ?? '';
        const ext = mimeToExt(contentType) ?? guessExtFromUrl(url);
        return { ok: true, buffer, ext };
    } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
            return { ok: false, reason: 'timeout (30s)' };
        }
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

// ============ MIME / 扩展名 ============

export function mimeToExt(contentType: string): string | null {
    const mimeMap: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff'
    };
    for (const [mime, ext] of Object.entries(mimeMap)) {
        if (contentType.includes(mime)) return ext;
    }
    return null;
}

export function guessExtFromUrl(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        const ext = pathname.split('.').pop()?.toLowerCase();
        if (ext && /^(png|jpe?g|gif|webp|svg|bmp|tiff?|ico)$/.test(ext)) {
            return ext === 'jpeg' ? 'jpg' : ext;
        }
    } catch {
    // ignore
    }
    return 'png'; // fallback
}

// ============ MD5 ============

export function md5Bytes(buffer: ArrayBuffer): string {
    const hasher = new Bun.CryptoHasher('md5');
    hasher.update(new Uint8Array(buffer));
    return hasher.digest('hex');
}

// ============ URL 规范化辅助 ============

export function normalizeUrlPrefix(prefix: string): string {
    return prefix.replace(/\/+$/, '');
}

export function normalizePathPrefix(prefix: string): string {
    return prefix.replace(/^\/+|\/+$/g, '');
}

export function buildPublicUrl(urlPrefix: string, pathPrefix: string, filename: string): string {
    const normalizedUrl = normalizeUrlPrefix(urlPrefix);
    const normalizedPath = normalizePathPrefix(pathPrefix);
    if (normalizedPath === '') {
        return `${normalizedUrl}/${filename}`;
    }
    return `${normalizedUrl}/${normalizedPath}/${filename}`;
}

export function isAlreadyPublic(url: string, urlPrefix: string): boolean {
    try {
        const normalized = normalizeUrlPrefix(urlPrefix);
        const targetUrl = new URL(url);
        const prefixUrl = new URL(normalized);
        return targetUrl.origin === prefixUrl.origin && targetUrl.pathname.startsWith(prefixUrl.pathname);
    } catch {
        return false;
    }
}

// ============ OSS 路径构建 ============

function buildOssPath(ossConfig: OssClientConfig, ossKey: string): string {
    const normalizedPath = normalizePathPrefix(ossConfig.pathPrefix);
    if (normalizedPath === '') {
        return `oss://${ossConfig.bucket}/${ossKey}`;
    }
    return `oss://${ossConfig.bucket}/${normalizedPath}/${ossKey}`;
}

// ============ OSS 上传 ============

/** 上传结果:成功带公网 URL,失败带 aliyun CLI stderr(单行截断)。 */
export type UploadResult = { ok: true; url: string } | { ok: false; reason: string };

export function uploadToOSS(
    localPath: string,
    ossKey: string,
    ossConfig: OssClientConfig
): UploadResult {
    const ossPath = buildOssPath(ossConfig, ossKey);
    try {
        const proc = Bun.spawnSync(
            ['aliyun', 'ossutil', 'cp', localPath, ossPath, '--profile', ossConfig.profile, '-e', `oss-${ossConfig.region}.aliyuncs.com`, '--region', ossConfig.region, '-f'],
            { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 }
        );
        if (proc.exitCode !== 0) {
            const err = new TextDecoder().decode(proc.stderr).trim().split('\n')[0] ?? '';
            return { ok: false, reason: err || `exit ${proc.exitCode}` };
        }
        return { ok: true, url: buildPublicUrl(ossConfig.urlPrefix, ossConfig.pathPrefix, ossKey) };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

// ============ OSS 删除 ============

export function deleteFromOSS(
    md5: string,
    ext: string,
    ossConfig: OssClientConfig | null
): void {
    if (!ossConfig) return;
    const ossKey = `${md5}.${ext}`;
    const ossPath = buildOssPath(ossConfig, ossKey);
    try {
        const proc = Bun.spawnSync(
            ['aliyun', 'ossutil', 'rm', ossPath, '--profile', ossConfig.profile, '-e', `oss-${ossConfig.region}.aliyuncs.com`, '--region', ossConfig.region, '-f'],
            { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 }
        );
        if (proc.exitCode !== 0) {
            const err = new TextDecoder().decode(proc.stderr).trim();
            if (err) console.error(`\n    ${C.yellow}OSS delete warning (${ossKey}):${C.reset} ${err}`);
        }
    } catch (e) {
        console.error(`\n    ${C.yellow}OSS delete failed (${ossKey}):${C.reset} ${e instanceof Error ? e.message : String(e)}`);
    }
}

// ============ 孤儿图片清理 ============

export function cleanupOrphanImages(
    db: Database,
    md5List: string[],
    nodeToken: string,
    outputDir: string,
    ossConfig: OssClientConfig | null
): void {
    for (const md5 of md5List) {
        const refCount = countImageRefs(db, md5, nodeToken);
        if (refCount === 0) {
            const imageRow = getImageByMd5(db, md5);
            if (imageRow) {
                const localPath = join(outputDir, 'data', 'temp', `${md5}.${imageRow.ext}`);
                if (existsSync(localPath)) {
                    rmSync(localPath);
                }
                deleteFromOSS(md5, imageRow.ext, ossConfig);
                // 引用归零时连同 images 主行一起删除
                db.run('DELETE FROM images WHERE md5=?', [md5]);
            }
        }
        deleteImageByMd5AndNode(db, md5, nodeToken);
    }
}

// ============ 全局孤儿图片扫描 ============

/**
 * 扫描所有已下载的 Markdown 文件，返回 images 表中不被任何文档引用的孤儿图片。
 *
 * 流程：
 * 1. 遍历所有 .md 文件，提取图片 URL
 * 2. 从 URL 中解析 {md5}.{ext} 文件名
 * 3. 构建引用 MD5 集合
 * 4. 查询 images 表 → 不在引用集合中的为孤儿
 */
export function findOrphanImages(db: Database, outputDir: string): { md5: string; ext: string }[] {
    const mdFiles = findMdFiles(outputDir);
    const referencedMd5s = new Set<string>();

    // 匹配图片引用：HTTP URL 或本地路径，提取 {md5}.{ext} 文件名
    const imgUrlRe = /!\[[^\]]*\]\(([^)\s]+)\)/g;
    const md5ExtRe = /\/([a-f0-9]{32})\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico)\b/i;

    for (const filePath of mdFiles) {
        try {
            const content = readFileSync(filePath, 'utf-8');
            let m: RegExpExecArray | null;
            while ((m = imgUrlRe.exec(content)) !== null) {
                const url = m[1]!;
                const md5Match = md5ExtRe.exec(url);
                if (md5Match?.[1]) {
                    referencedMd5s.add(md5Match[1].toLowerCase());
                }
            }
        } catch {
            // 读取失败跳过
        }
    }

    // 查询 images 表中所有图片（referencedMd5s 为空时全部为孤儿）
    const allImages = db.query('SELECT DISTINCT md5, ext FROM images').all() as { md5: string; ext: string }[];

    return allImages.filter((img) => !referencedMd5s.has(img.md5.toLowerCase()));
}

/**
 * 清理全局孤儿图片：本地文件 + OSS 文件 + DB 记录。
 *
 * 在 upload 全部完成后调用，作为事件驱动清理的补充。
 * 返回清理数量。
 */
export function cleanupGlobalOrphans(
    db: Database,
    outputDir: string,
    ossConfig: OssClientConfig | null
): number {
    const orphans = findOrphanImages(db, outputDir);
    if (orphans.length === 0) return 0;

    let cleaned = 0;
    for (const { md5, ext } of orphans) {
        try {
            // 删除本地 temp 文件
            const localPath = join(outputDir, 'data', 'temp', `${md5}.${ext}`);
            if (existsSync(localPath)) {
                rmSync(localPath);
            }

            // 删除 OSS 文件
            deleteFromOSS(md5, ext, ossConfig);

            // 先清 junction 行，再清 images 主行
            db.run('DELETE FROM image_vs_node WHERE md5=?', [md5]);
            db.run('DELETE FROM images WHERE md5=?', [md5]);
            cleaned++;
        } catch {
            // 单个失败不阻塞
        }
    }

    return cleaned;
}

// ============ 图片处理主流程 ============

/** 单张图片失败记录:URL + 简短原因(供 batch 模式汇总展示)。 */
export interface ImageFailure {
    url: string;
    reason: string;
}

export async function processImagesInFile(
    filePath: string,
    outputDir: string,
    db: Database,
    ossConfig: OssClientConfig | null,
    waitForSlot: () => Promise<void>,
    nodeToken: string,
    onProgress?: (current: number, total: number) => void
): Promise<{ processed: number; failed: number; failures: ImageFailure[] }> {
    const content = await Bun.file(filePath).text();
    const imageUrls = extractImageUrls(content);
    if (imageUrls.length === 0) return { processed: 0, failed: 0, failures: [] };

    const imagesDir = join(outputDir, 'data', 'temp');
    mkdirSync(imagesDir, { recursive: true });

    let result = content;
    let processed = 0;
    let failed = 0;
    const failures: ImageFailure[] = [];
    const processedMd5s: string[] = [];
    const tempFiles: string[] = [];

    for (const img of imageUrls) {
        if (ossConfig && isAlreadyPublic(img.url, ossConfig.urlPrefix)) {
            continue;
        }

        await waitForSlot();

        const downloaded = await downloadImage(img.url);
        if (!downloaded.ok) {
            failed++;
            failures.push({ url: img.url, reason: downloaded.reason });
            continue;
        }

        const contentMd5 = md5Bytes(downloaded.buffer);
        const imageRow = getImageByMd5(db, contentMd5);
        let replacementUrl: string | null = null;

        try {
            if (imageRow?.oss_url) {
                replacementUrl = imageRow.oss_url;
            } else {
                const localPath = join(imagesDir, `${contentMd5}.${downloaded.ext}`);
                await Bun.write(localPath, downloaded.buffer);
                tempFiles.push(localPath);
                upsertImage(db, contentMd5, downloaded.ext, null, 0);

                if (ossConfig) {
                    const uploaded = uploadToOSS(localPath, `${contentMd5}.${downloaded.ext}`, ossConfig);
                    if (uploaded.ok) {
                        upsertImage(db, contentMd5, downloaded.ext, uploaded.url, 1);
                        replacementUrl = uploaded.url;
                    } else {
                        failures.push({ url: img.url, reason: `OSS upload: ${uploaded.reason}` });
                    }
                }

                replacementUrl ??= `./images/${contentMd5}.${downloaded.ext}`;
            }
            addImageRef(db, contentMd5, nodeToken);

            if (replacementUrl) {
                const newImgTag = `![${img.altText}](${replacementUrl})`;
                result = result.replaceAll(img.fullMatch, newImgTag);
                processedMd5s.push(contentMd5);
                processed++;
            }
        } catch (e) {
            failed++;
            failures.push({
                url: img.url,
                reason: e instanceof Error ? e.message : String(e)
            });
        }

        onProgress?.(processed + failed, imageUrls.length);
    }

    if (processed > 0) {
        await Bun.write(filePath, result);
        // 回写 og:image 到 frontmatter（仅对有 frontmatter 的文件生效）
        updateFrontmatterOgImage(filePath);
    }

    // 清理本次产生的 temp 文件
    for (const tf of tempFiles) {
        try {
            if (existsSync(tf)) rmSync(tf);
        } catch {
            // ignore
        }
    }

    // Diff cleanup: old images for this node minus new images
    const newMd5Set = new Set(processedMd5s);
    const oldImages = getImagesByNode(db, nodeToken);
    const diffMd5s: string[] = [];
    for (const oldImg of oldImages) {
        if (!newMd5Set.has(oldImg.md5)) {
            diffMd5s.push(oldImg.md5);
        }
    }
    if (diffMd5s.length > 0) {
        cleanupOrphanImages(db, diffMd5s, nodeToken, outputDir, ossConfig);
    }

    return { processed, failed, failures };
}

// ============ Frontmatter og:image 回写 ============

/**
 * 从已替换图片 URL 的 Markdown 正文中提取第一张图片 URL，
 * 回写到文件 frontmatter 的 head.meta[] 中作为 og:image 条目。
 *
 * 仅在文件已有 frontmatter（以 "---" 开头）时才执行回写；
 * 无 frontmatter 时跳过。已存在 og:image 时更新而非重复添加。
 */
export function updateFrontmatterOgImage(filePath: string): void {
    const text = readFileSync(filePath, 'utf-8');

    // 仅处理已有 frontmatter 的文件
    if (!text.startsWith('---')) return;

    // 提取正文中第一张图片 URL
    const bodyMatch = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(text);
    if (!bodyMatch?.[1]) return;
    const ogImageUrl = bodyMatch[1];

    // 解析 frontmatter 结束位置
    const fmEnd = text.indexOf('---', 3);
    if (fmEnd === -1) return;
    const frontmatter = text.slice(0, fmEnd + 3);
    const body = text.slice(fmEnd + 3);

    // 检查是否已有 og:image
    const ogImageRegex = /(\n\s*-\s*meta:\s*\n\s*name:\s*'og:image'\s*\n\s*content:\s*)'[^']*'/;
    if (ogImageRegex.test(frontmatter)) {
    // 更新已有 og:image
        const newFm = frontmatter.replace(ogImageRegex, `$1'${ogImageUrl}'`);
        writeFileSync(filePath, newFm + body);
    } else {
    // 在 frontmatter 结束前插入 og:image（在 lastUpdated 行之前）
        const lines = frontmatter.split('\n');
        const closeIdx = lines.lastIndexOf('---');
        if (closeIdx <= 0) return;
        const insertLines = [
            '  - - meta',
            "    - name: 'og:image'",
            `      content: '${ogImageUrl}'`
        ];
        lines.splice(closeIdx, 0, ...insertLines);
        writeFileSync(filePath, lines.join('\n') + body);
    }
}
