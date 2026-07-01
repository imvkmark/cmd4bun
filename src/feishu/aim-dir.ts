// copydocs 目标目录解析 (cmd.feishu copy-docs / cmd.feishu diff-with 共享)
// 与跨组引用解析 (cmd.feishu download) 共享 aimUrl helper。
//
// 从配置中按 group 名解析 aimDirectory / aimUrl。
// 解析优先级:feishu.{group}.{aimDirectory|aimUrl} → fallback 到 feishu.default.{...} → null。
// 都未配置时返回 null,调用方决定跳过还是报错。

import { resolve } from 'node:path';
import type { AppConfig } from '../config';
import { resolveFeishuGroupConfig } from '../config';

export function resolveAimDirectory(cfg: AppConfig, group: string): string | null {
    const groupCfg = resolveFeishuGroupConfig(cfg, group);
    const raw = groupCfg?.aimDirectory ?? resolveFeishuGroupConfig(cfg, 'default')?.aimDirectory;
    if (!raw) return null;
    return resolve(process.cwd(), raw);
}

/**
 * 按 group 名解析 aimUrl。
 * 解析优先级:feishu.{group}.aimUrl → fallback 到 feishu.default.aimUrl → null。
 * 与 resolveAimDirectory 对称,供下载阶段的 resolveLink 闭包在跨 group 引用时使用。
 */
export function resolveAimUrl(cfg: AppConfig, group: string): string | null {
    return resolveFeishuGroupConfig(cfg, group)?.aimUrl
        ?? resolveFeishuGroupConfig(cfg, 'default')?.aimUrl
        ?? null;
}

/**
 * 收集 cfg.feishu 中所有 group（含 default fallback）的 aimDirectory 绝对路径,去重后返回。
 *
 * 遍历策略:
 * - 跳过 `dir` 字段(字符串,非 group config)
 * - 跳过非 object 值
 * - 对每个 group 调 `resolveAimDirectory(cfg, key)` 复用其 fallback 链
 * - 缺 `default.aimDirectory` 且 group 自身也缺时该 group 不进排除集
 * - 缺 `cfg.feishu` 配置时返回空数组
 * - 重复路径(多 group 共享同一 aimDirectory 或全部 fallback 到 default)自动去重
 *
 * 供 sync Phase 2 排除 aimDirectory 子树下的 .md 文件使用(避免 sync 误删 copy-docs 副本)。
 * 与 resolveAimDirectory / resolveAimUrl 形成"config group 系列 helper 集中"对称。
 */
export function collectAllAimDirectories(cfg: AppConfig): string[] {
    if (!cfg.feishu) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const [key, value] of Object.entries(cfg.feishu)) {
        if (key === 'dir' || typeof value !== 'object') continue;
        const abs = resolveAimDirectory(cfg, key);
        if (abs && !seen.has(abs)) {
            seen.add(abs);
            result.push(abs);
        }
    }
    return result;
}
