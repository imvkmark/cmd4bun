// CLI 入口：loadConfig → parseArgs → dispatch via registry.spec.run
// 用 switch (parsed.command) 触发 discriminated union 收缩，spec.run 拿到的 args 类型精确。

import { closeDB } from '../db';
import { loadConfig, resolveFeishuDir } from '../../config';
import { C } from '../../shared/colors';
import { commandSpecs } from './registry';
import { parseArgs } from './parse-args';
import { printHelp } from './help';
import type { ParsedCommand } from './types';

async function dispatch(parsed: ParsedCommand): Promise<void> {
    if (parsed.command === null || parsed.command === 'help') {
        printHelp();
        return;
    }
    // 显式 switch 让 TS 在每个分支里把 parsed.args 收缩到精确类型
    switch (parsed.command) {
        case 'sync': {
            await commandSpecs.sync.run(parsed.args);
            break;
        }
        case 'download': {
            await commandSpecs.download.run(parsed.args);
            break;
        }
        case 'copy-docs': {
            await commandSpecs['copy-docs'].run(parsed.args);
            break;
        }
        case 'init-db': {
            void commandSpecs['init-db'].run(parsed.args);
            break;
        }
        case 'sync-updated-at': {
            await commandSpecs['sync-updated-at'].run(parsed.args);
            break;
        }
        case 'diff-with': {
            await commandSpecs['diff-with'].run(parsed.args);
            break;
        }
    }
}

export async function main() {
    const cfg = await loadConfig();
    const parsed = parseArgs(resolveFeishuDir(cfg));

    process.on('SIGINT', () => {
        console.log(`\n  ${C.dim}已中断${C.reset}\n`);
        closeDB();
        process.exit(0);
    });

    try {
        await dispatch(parsed);
    } catch (err) {
        console.error(`\n  ${C.red}✗${C.reset} Error:`, err instanceof Error ? err.message : err);
        closeDB();
        process.exit(1);
    }
}
