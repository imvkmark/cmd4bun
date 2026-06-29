// 飞书 copydocs 目标目录孤儿副本检测 (cmd.feishu diff-with <group>)
//
// 扫描 feishu.{group}.aimDirectory 下的 .md 副本,三级判定后输出清单(只读)。
//
// 判定规则:
//   L1 路径+group 命中 → 静默(不出现在清单)
//   L2 标题全库匹配     → 列出文件 + 每个匹配节点的飞书 URL
//   L3 无匹配          → 警告(真正需要清理的孤儿)
//
// group 是位置参数(必填,小写 [a-z0-9-]+),不支持 fan-out。

import { relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { C } from '../shared/colors';
import { getDB, closeDB, getDBPath } from './db';
import { loadConfig } from '../config';
import { resolveAimDirectory } from './aim-dir';
import { findMdFiles, parseFrontmatterTitle } from './utils';
import type { DiffWithArgs } from './cli/types';

/** group 名合法性校验规则,与 copy-docs 一致 */
const GROUP_VALID_RE = /^[a-z0-9-]+$/;

interface PathMatchRow {
    node_token: string;
    human_path: string;
}

interface TitleMatchRow {
    node_token: string;
    title: string;
}

/**
 * 把 aimDirectory 下的绝对文件路径转换为 human_path(= L1 反查 key):
 * 1) 取相对路径
 * 2) 去掉 .md 后缀
 * 3) 统一用 / 分隔(Windows 兼容,macOS 是不变的 no-op)
 *
 * 导出供单测验证。
 */
export function absPathToHumanPath(aimDirectory: string, abs: string): string {
    const rel = relative(aimDirectory, abs);
    const noExt = rel.endsWith('.md') ? rel.slice(0, -3) : rel;
    return noExt.split(sep).join('/');
}

/**
 * 读取 .md 文件 frontmatter 中的 `title` 字段。
 * 失败或缺失/空字符串时返回 null(由调用方决定如何 fallback)。
 * 导出供单测验证。
 */
export async function readTitleFromFrontmatter(absPath: string): Promise<string | null> {
    try {
        const file = Bun.file(absPath);
        if (!(await file.exists())) return null;
        const content = await file.text();
        return parseFrontmatterTitle(content);
    } catch {
        return null;
    }
}

/** 构造飞书 URL。Feishu 跨租户跳转机制保证 https://feishu.cn/wiki/<node_token> 可用。 */
export function buildFeishuUrl(nodeToken: string): string {
    return `https://feishu.cn/wiki/${nodeToken}`;
}

export async function runDiffWith(args: DiffWithArgs) {
    const outputDir = args.output;
    const dbPath = getDBPath(outputDir);

    if (!existsSync(dbPath)) {
        throw new Error(
            `数据库不存在: ${dbPath}\n  请先运行 "bun run src/feishu.ts sync"`
        );
    }

    // group 必填(位置参数已校验);此处再校验格式
    if (!GROUP_VALID_RE.test(args.group)) {
        closeDB();
        throw new Error(
            `group 名 "${args.group}" 非法:仅允许小写字母、数字、连字符\n`
            + '  提示:YAML 中的 group 值会按相同规则校验,大写或含特殊字符会被降级为 default'
        );
    }

    const cfg = await loadConfig();
    const db = getDB(outputDir);

    // 目标 group 未配置 aimDirectory 时报错退出(严格模式)
    const aimDirectory = resolveAimDirectory(cfg, args.group);
    if (!aimDirectory) {
        closeDB();
        throw new Error(
            `未配置 group "${args.group}" 的 aimDirectory\n`
            + `  请在 config.json 中设置 feishu.${args.group}.aimDirectory 或 feishu.default.aimDirectory`
        );
    }

    // 扫 aimDirectory 找所有 .md 副本(findMdFiles 已排除 images/ 与 data/ 子目录)
    const mdAbsPaths = findMdFiles(aimDirectory);

    let titleMatchCount = 0;  // L2 标题匹配(>=1 都计入,统一输出)
    let warnCount = 0;         // L3 无匹配 + frontmatter 缺失

    for (const abs of mdAbsPaths) {
        const humanPath = absPathToHumanPath(aimDirectory, abs);

        // L1: 路径 + group 命中 → 静默
        // 同时匹配带/不带前导斜杠两种形式:DB 中可能存 '/foo' 或 'foo'(历史 copy-docs 写入约定)
        const l1 = db.query(
            'SELECT node_token, human_path FROM nodes WHERE (human_path = ? OR human_path = ?) AND "group" = ?'
        ).get(humanPath, `/${humanPath}`, args.group) as PathMatchRow | null;
        if (l1) continue;

        // L1 未命中 → 读 frontmatter title
        const title = await readTitleFromFrontmatter(abs);
        if (title === null) {
            // frontmatter 缺失 / 读取失败 / title 为空
            console.log(
                `  ${C.yellow}⚠${C.reset} [${args.group}] ${humanPath}.md — frontmatter 缺失,无法按标题反查`
            );
            console.log('    ```yaml');
            console.log(`    slug: /${humanPath}`);
            console.log('    ```');
            warnCount++;
            continue;
        }

        // L2: 标题全库匹配(不按 group 过滤,跨 group 同标题节点都列出)
        const l2Rows = db.query(
            'SELECT node_token, title FROM nodes WHERE title = ?'
        ).all(title) as TitleMatchRow[];

        if (l2Rows.length > 0) {
            // L2 命中(>=1):统一输出 title + URL 列表
            //  1 个匹配:可能是因为 slug 改名后留在 aimDirectory 的旧副本
            //  >=2 个匹配:同标题多文档,需要人工确认
            // 不区分 1 / >=2,让用户看到所有待匹配项并自行判断
            console.log(`  ${C.yellow}⚠${C.reset} [${args.group}] ${humanPath}.md — 标题 "${title}" 匹配 ${l2Rows.length} 个:`);
            console.log('    ```yaml');
            console.log(`    slug: /${humanPath}`);
            console.log('    ```');
            for (const row of l2Rows) {
                console.log(`    ${buildFeishuUrl(row.node_token)}`);
            }
            titleMatchCount++;
            continue;
        }

        // L3: 无匹配
        console.log(
            `  ${C.yellow}⚠${C.reset} [${args.group}] ${humanPath}.md — 标题 "${title}" 无任何匹配`
        );
        console.log('    ```yaml');
        console.log(`    slug: /${humanPath}`);
        console.log('    ```');
        warnCount++;
    }

    console.log(
        `\n  ${C.green}✓${C.reset} 扫描 ${mdAbsPaths.length} 个文件, 列出 ${titleMatchCount} 个待匹配, 警告 ${warnCount} 个\n`
    );
    closeDB();
}
