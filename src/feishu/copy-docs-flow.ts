// 飞书文档复制流程 (cmd.feishu copy-docs)
//
// 将 human_path 不为空且 downloaded_at 已写入的文档
// (downloaded_at = 下载 + 图片处理完毕的统一标记)
// 按 group 分发到 config.feishu.{group}.aimDirectory,目标文件名 human_path.md。
//
// 不传 --group 时 fan-out:取 DB 中 unique group 串行复制到各自 aimDirectory,
// 缺 aimDirectory 的 group 跳过 + warn。

import { join, dirname, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { C } from '../shared/colors';
import { getDB, closeDB, getDBPath } from './db';
import { loadConfig, resolveFeishuGroupConfig } from '../config';
import type { CopyDocsArgs } from './cli/types';

/** group 名合法性校验规则,与 frontmatter 解析器一致 */
const GROUP_VALID_RE = /^[a-z0-9-]+$/;

interface CopyDoc {
    file_path: string;
    human_path: string;
    title: string;
    group: string;
}

interface CopyStats {
    copied: number;
    skipped: number;
}

/**
 * 构建复制文档的 WHERE 子句。
 * 集中维护 downloadable + not ignore + human_path 不为空 + file_path 不为空 + downloaded_at 不为空
 * 这五条共同条件,避免在单 group 与 fan-out 分支重复硬编码。
 *
 * @param extra 额外过滤条件(可包含占位符 `?` 与对应 params)
 * @returns SQL 片段 + 绑定参数
 */
function buildCopyWhereClause(extra: { sql: string; params: (string | number)[] } = { sql: '', params: [] }): { sql: string; params: (string | number)[] } {
    const base = {
        sql: 'human_path IS NOT NULL AND human_path != \'\' AND file_path IS NOT NULL AND file_path != \'\' AND downloaded_at IS NOT NULL AND (is_ignore IS NULL OR is_ignore = 0)',
        params: [] as (string | number)[]
    };
    if (extra.sql) {
        return {
            sql: `${base.sql} AND (${extra.sql})`,
            params: [...base.params, ...extra.params]
        };
    }
    return base;
}

/**
 * 复制一组文档到指定 aimDirectory。
 *
 * 不读 config、不区分 group,纯按行复制。SQL 过滤条件由调用方传入。
 * 缺 aimDirectory 时由调用方(主流程)决定跳过还是报错,本函数不抛错。
 */
async function copyDocsForGroup(
    outputDir: string,
    aimDirectory: string,
    rows: CopyDoc[]
): Promise<CopyStats> {
    const stats: CopyStats = { copied: 0, skipped: 0 };
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const srcPath = join(outputDir, row.file_path);
        const destPath = join(aimDirectory, `${row.human_path}.md`);

        if (!existsSync(srcPath)) {
            console.log(`  ${C.yellow}⚠${C.reset} [${i + 1}/${rows.length}] 源文件不存在,跳过: ${row.title}`);
            stats.skipped++;
            continue;
        }

        try {
            mkdirSync(dirname(destPath), { recursive: true });
            await Bun.write(destPath, Bun.file(srcPath));
            console.log(`  ${C.green}✓${C.reset} [${i + 1}/${rows.length}] ${row.human_path}.md  ← ${row.title}`);
            stats.copied++;
        } catch (e) {
            console.log(`  ${C.red}✗${C.reset} [${i + 1}/${rows.length}] 复制失败: ${row.title} — ${e instanceof Error ? e.message : String(e)}`);
            stats.skipped++;
        }
    }
    return stats;
}

/**
 * 解析单个 group 的 aimDirectory。
 * 优先读 feishu.{group}.aimDirectory,未配置则 fallback 到 feishu.default.aimDirectory。
 * @returns 解析到的绝对路径;都未配置时返回 null
 */
function resolveAimDirectory(cfg: Awaited<ReturnType<typeof loadConfig>>, group: string): string | null {
    const groupCfg = resolveFeishuGroupConfig(cfg, group);
    const raw = groupCfg?.aimDirectory ?? resolveFeishuGroupConfig(cfg, 'default')?.aimDirectory;
    if (!raw) return null;
    return resolve(process.cwd(), raw);
}

export async function runCopyDocs(args: CopyDocsArgs) {
    const outputDir = args.output;
    const dbPath = getDBPath(outputDir);

    if (!existsSync(dbPath)) {
        throw new Error(
            `数据库不存在: ${dbPath}\n  请先运行 "bun run src/feishu.ts sync"`
        );
    }

    const cfg = await loadConfig();

    const db = getDB(outputDir);

    // --group 指定分支:仅处理该 group
    if (args.group) {
        // group 名合法性校验:与 frontmatter 解析器的 [a-z0-9-]+ 规则一致
        // 避免大小写或非法字符的 --group 静默返回 0 行
        if (!GROUP_VALID_RE.test(args.group)) {
            closeDB();
            throw new Error(
                `group 名 "${args.group}" 非法:仅允许小写字母、数字、连字符\n`
                + '  提示:YAML 中的 group 值会按相同规则校验,大写或含特殊字符会被降级为 default'
            );
        }
        const aimDirectory = resolveAimDirectory(cfg, args.group);
        if (!aimDirectory) {
            closeDB();
            throw new Error(
                `未配置 group "${args.group}" 的 aimDirectory\n`
                + `  请在 config.json 中设置 feishu.${args.group}.aimDirectory 或 feishu.default.aimDirectory`
            );
        }

        const where = buildCopyWhereClause({ sql: '"group" = ?', params: [args.group] });
        const rows = db.query(
            `SELECT file_path, human_path, title, "group" FROM nodes WHERE ${where.sql}`
        ).all(...where.params) as CopyDoc[];

        if (rows.length === 0) {
            console.log(`\n  ${C.yellow}⚠${C.reset} group "${args.group}" 没有符合复制条件的文档\n`);
            closeDB();
            return;
        }

        console.log(`\n  ${C.bold}复制文档${C.reset}`);
        console.log(`  ${C.dim}源目录: ${outputDir}${C.reset}`);
        console.log(`  ${C.dim}目标目录: ${aimDirectory}${C.reset}`);
        console.log(`  ${C.dim}group: ${args.group}${C.reset}\n`);

        const stats = await copyDocsForGroup(outputDir, aimDirectory, rows);
        console.log(`\n  ${C.bold}复制完成${C.reset}\n`);
        console.log(`  ${C.green}✓${C.reset} 复制: ${stats.copied}  ${C.yellow}⚠${C.reset} 跳过: ${stats.skipped}`);
        console.log();
        closeDB();
        return;
    }

    // fan-out 分支:取 DB 中 unique group 串行复制
    const fanOutWhere = buildCopyWhereClause();
    const groupRows = db.query(
        `SELECT DISTINCT "group" FROM nodes WHERE ${fanOutWhere.sql} ORDER BY "group"`
    ).all(...fanOutWhere.params) as { group: string }[];

    if (groupRows.length === 0) {
        console.log(`\n  ${C.yellow}⚠${C.reset} 没有符合复制条件的文档 (human_path 为空、downloaded_at 为空或被标记为忽略)\n`);
        closeDB();
        return;
    }

    // 顺序提示:fan-out 仅产出 default group 且配置中声明了其他 group,
    // 提示用户可能是 sync → copy-docs 跳过了 download,group 字段未被 YAML 解析
    if (groupRows.length === 1 && groupRows[0]!.group === 'default' && cfg.feishu) {
        const otherGroups = Object.keys(cfg.feishu).filter(
            (k) => k !== 'dir' && k !== 'default' && typeof cfg.feishu![k] === 'object'
        );
        if (otherGroups.length > 0) {
            console.log(
                `  ${C.yellow}⚠${C.reset} 检测到所有可复制文档均为 default 分组,但配置中声明了其他 group `
                + `(${otherGroups.join(', ')})\n`
                + `  ${C.dim}提示:group 字段由 download 阶段从 YAML 解析,如未运行 download 请先执行 `
                + `'bun run src/feishu.ts download'${C.reset}`
            );
        }
    }

    console.log(`\n  ${C.bold}复制文档 (fan-out)${C.reset}`);
    console.log(`  ${C.dim}源目录: ${outputDir}${C.reset}`);
    console.log(`  ${C.dim}共 ${groupRows.length} 个 group${C.reset}\n`);

    let totalCopied = 0;
    let totalSkipped = 0;
    let processedGroups = 0;

    for (const { group } of groupRows) {
        const aimDirectory = resolveAimDirectory(cfg, group);
        if (!aimDirectory) {
            console.log(`  ${C.yellow}⚠${C.reset} 跳过 group "${group}" (未配置 feishu.${group}.aimDirectory 或 feishu.default.aimDirectory)`);
            continue;
        }

        const groupWhere = buildCopyWhereClause({ sql: '"group" = ?', params: [group] });
        const rows = db.query(
            `SELECT file_path, human_path, title, "group" FROM nodes WHERE ${groupWhere.sql}`
        ).all(...groupWhere.params) as CopyDoc[];

        console.log(`  ${C.bold}[${group}]${C.reset} ${C.dim}目标: ${aimDirectory}${C.reset}  ${C.dim}(${rows.length} 个文档)${C.reset}`);

        if (rows.length === 0) {
            console.log(`  ${C.yellow}⚠${C.reset} group "${group}" 没有符合复制条件的文档\n`);
            continue;
        }

        const stats = await copyDocsForGroup(outputDir, aimDirectory, rows);
        totalCopied += stats.copied;
        totalSkipped += stats.skipped;
        processedGroups++;
        console.log();
    }

    console.log(`  ${C.bold}复制完成${C.reset}\n`);
    console.log(`  ${C.green}✓${C.reset} 处理 group: ${processedGroups}/${groupRows.length}  ${C.green}✓${C.reset} 复制: ${totalCopied}  ${C.yellow}⚠${C.reset} 跳过: ${totalSkipped}`);
    console.log();
    closeDB();
}
