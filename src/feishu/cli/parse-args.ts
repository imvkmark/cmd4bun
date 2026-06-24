// CLI 通用 parser：识别命令名 → 通用 flag → 命令专属 flag → 未知 flag 报错
// 不再写每个命令的 if-else 块，注册表里有 flags 数组就够。

import { resolve } from 'node:path';
import { C } from '../../shared/colors';
import { commandSpecs } from './registry';
import { printHelp } from './help';
import type {
    CommonArgs, CommandName, CopyDocsArgs, DownloadArgs,
    ParsedCommand, SyncArgs, SyncUpdatedAtArgs
} from './types';

const COMMAND_NAMES: ReadonlySet<string> = new Set(Object.keys(commandSpecs));

/**
 * flags.apply 的容器类型：所有命令 args 的联合。
 * 选联合而非 Record 是因为 Record<string, unknown> 与具体 args 接口不兼容（缺少索引签名）。
 */
type AnyArgs = CommonArgs | SyncArgs | DownloadArgs | SyncUpdatedAtArgs | CopyDocsArgs;

export function parseArgs(defaultOutput = './docs/feishu'): ParsedCommand {
    const argv = process.argv.slice(2);
    const common: CommonArgs = { output: defaultOutput };
    let command: CommandName | null = null;
    // 懒构造：第一次遇到命令专属 flag 时才 buildArgs，避免空命令时白构造
    let commandArgs: AnyArgs | null = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;

        // 选命令
        if (!command && COMMAND_NAMES.has(arg)) {
            command = arg as CommandName;
            continue;
        }

        // 通用 flag
        if (arg === '--help' || arg === '-h') {
            if (command) {
                console.log(commandSpecs[command].help);
                process.exit(0);
            }
            return { command: 'help', args: common };
        }

        if (arg === '--output' || arg === '-o') {
            const val = argv[++i];
            if (val) common.output = resolve(process.cwd(), val);
            continue;
        }

        // 命令专属 flag
        if (command) {
            const spec = commandSpecs[command];
            const flag = spec.flags.find((f) => f.names.includes(arg));
            if (flag) {
                const target: AnyArgs = commandArgs ?? spec.buildArgs(common);
                commandArgs = target;
                const val = flag.takesValue ? argv[++i] : undefined;
                // 泛型擦除后 apply 只能接受 any；这里 flag 与 commandArgs 来自同一 spec，安全
                (flag.apply as unknown as (a: AnyArgs, v: string | undefined) => void)(target, val);
                continue;
            }
        }

        // 未知 flag
        console.error(`  ${C.red}✗${C.reset} 未知参数: ${arg}`);
        printHelp();
        process.exit(1);
    }

    // 按 command 分支构造精确类型的 ParsedCommand，避开联合类型推断
    switch (command) {
        case 'sync': return { command: 'sync', args: (commandArgs ?? commandSpecs.sync.buildArgs(common)) as SyncArgs };
        case 'download': return { command: 'download', args: (commandArgs ?? commandSpecs.download.buildArgs(common)) as DownloadArgs };
        case 'copy-docs': return { command: 'copy-docs', args: (commandArgs ?? commandSpecs['copy-docs'].buildArgs(common)) as CopyDocsArgs };
        case 'init-db': return { command: 'init-db', args: (commandArgs ?? commandSpecs['init-db'].buildArgs(common)) };
        case 'sync-updated-at': return { command: 'sync-updated-at', args: (commandArgs ?? commandSpecs['sync-updated-at'].buildArgs(common)) as SyncUpdatedAtArgs };
        case 'help': return { command: 'help', args: common };
        case null: return { command: 'help', args: common };
    }
}
