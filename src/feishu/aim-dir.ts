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
