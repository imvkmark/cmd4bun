// copydocs 目标目录解析 (cmd.feishu copy-docs / cmd.feishu diff-with 共享)
//
// 从配置中按 group 名解析 aimDirectory。
// 解析优先级:feishu.{group}.aimDirectory → fallback 到 feishu.default.aimDirectory → null。
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
