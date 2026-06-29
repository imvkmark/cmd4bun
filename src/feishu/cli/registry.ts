// CLI 命令注册表：每个命令 = name + summary + help + buildArgs + flags + run
// 新增命令只需在这里加一条；parse-args / printHelp / main 不再需要改。

import { C } from '../../shared/colors';
import { runSync } from '../sync-flow';
import { runDownload } from '../download-flow';
import { runCopyDocs } from '../copy-docs-flow';
import { runInitDB } from '../init-db-flow';
import { runSyncUpdatedAt } from '../sync-updated-at-flow';
import { runDiffWith } from '../diff-with-flow';
import type {
    CommonArgs, CommandName, CopyDocsArgs, DiffWithArgs, DownloadArgs, SyncArgs, SyncUpdatedAtArgs
} from './types';

// ============ Flag 定义 ============

interface FlagDef<TArgs> {
    /** 接受的 flag 名（短长形式都列上） */
    names: string[];
    /** 是否需要带值（带值时自动消费下一个 argv） */
    takesValue: boolean;
    /** 解析时回调：mutate args；val 在 takesValue=false 时为 undefined */
    apply: (args: TArgs, val: string | undefined) => void;
}

// ============ Command 定义 ============

interface CommandSpec<TArgs> {
    name: CommandName;
    /** 短描述，出现在 `printHelp` 的 Commands 列表里 */
    summary: string;
    /** 完整帮助文本，由 `cmd help <name>` 或 `--help` 触发 */
    help: string;
    /** 用公共参数（output 等）构造本命令的初始 args */
    buildArgs: (common: CommonArgs) => TArgs;
    /** 命令专属 flags；通用 --output/--help 由 parser 统一处理 */
    flags: FlagDef<TArgs>[];
    /**
     * 命令的位置参数(声明式,parser 自动收集与校验必填性)。
     * 通用扩展:任何子命令可声明一个必填或可选位置参数,值会注入到 `args[spec.positional.name]`。
     * 不填时表示该命令无位置参数(只有 flags)。
     */
    positional?: PositionalDef<TArgs>;
    /** 真正执行业务逻辑的函数 */
    run: (args: TArgs) => Promise<void> | void;
}

/** 命令位置参数定义。`name` 对应 TArgs 上的字段名。 */
interface PositionalDef<TArgs> {
    /** 位置参数名,对应 TArgs 上的字段(如 'group' → args.group) */
    name: keyof TArgs & string;
    /** 是否必填;未传时 parse-args 抛 throw */
    required: boolean;
    /** help 文本中的描述 */
    description?: string;
}

// ============ Help 文本常量 ============

const SYNC_HELP = `
${C.bold}同步索引${C.reset}

${C.dim}Usage:${C.reset}
  bun run src/feishu.ts sync [options]

${C.dim}选项:${C.reset}
  --output, -o <dir>   输出目录 (默认: ./docs/feishu)
  --space, -s <id>     只同步指定知识库 (可多次指定)
  --help, -h           显示帮助

${C.dim}说明:${C.reset}
  扫描远端知识库结构，保存到本地 SQLite (feishu.db)。
  同时清理本地已不存在于远端索引的 .md 文档。
`;

const DOWNLOAD_HELP = `
${C.bold}下载文档${C.reset}

${C.dim}Usage:${C.reset}
  bun run src/feishu.ts download [options]

${C.dim}选项:${C.reset}
  --output, -o <dir>      输出目录 (默认: ./docs/feishu)
  --space, -s <id>        只下载指定知识库 (可多次指定)
  --node-token, -n <id>   下载指定节点（自动开启 --force）
  --force, -f             强制重新下载所有文档
  --concurrency, -c <n>   下载并发数 (默认: 4)
  --help, -h              显示帮助

${C.dim}说明:${C.reset}
  根据本地索引下载文档内容（自动处理图片：下载/去重/上传 OSS/URL 替换/节点级 diff）。需要先运行 sync。
  使用 --node-token 时仅下载单个节点，默认开启 force。
  OSS 未配置时图片降级保存到本地路径。
`;

const COPY_DOCS_HELP = `
${C.bold}复制文档${C.reset}

${C.dim}Usage:${C.reset}
  bun run src/feishu.ts copy-docs [options]

${C.dim}选项:${C.reset}
  --output, -o <dir>   输出目录 (默认: ./docs/feishu)
  --group, -g <name>   只复制指定 group 的文档；不传时 fan-out 所有 unique group
  --help, -h           显示帮助

${C.dim}说明:${C.reset}
  将 human_path 不为空且 downloaded_at 已写入的文档(下载 + 图片处理完毕)复制到
  config.feishu.{group}.aimDirectory。目标文件名为 human_path.md。
  不传 --group 时按 DB 中 unique group 串行复制到各自 aimDirectory,缺 aimDirectory 的 group 跳过。
`;

const DIFF_WITH_HELP = `
${C.bold}检测孤儿副本${C.reset}

${C.dim}Usage:${C.reset}
  bun run src/feishu.ts diff-with <group> [options]

${C.dim}参数:${C.reset}
  <group>                要检测的 group 名(必填,小写 [a-z0-9-]+)

${C.dim}选项:${C.reset}
  --output, -o <dir>   输出目录 (默认: ./docs/feishu)
  --help, -h           显示帮助

${C.dim}说明:${C.reset}
  只读扫描 feishu.{group}.aimDirectory 下的 .md 副本,三级判定后输出清单(只列不删,供用户手动 rm):

    L1 路径+group 命中 DB → 静默(不出现在清单)
    L2 标题全库匹配       → 列出文件 + 每个匹配节点的飞书 URL
    L3 无匹配            → 警告(真正需要清理的孤儿)

  飞书 URL 格式:https://feishu.cn/wiki/<node_token>
`;

const INIT_DB_HELP = `
${C.bold}初始化数据库${C.reset}

${C.dim}Usage:${C.reset}
  bun run src/feishu.ts init-db [options]

${C.dim}选项:${C.reset}
  --output, -o <dir>   输出目录 (默认: ./docs/feishu)
  --help, -h           显示帮助

${C.dim}说明:${C.reset}
  创建 feishu.db 并执行所有未应用的数据库迁移。
  首次使用飞书工具前必须执行此命令。
  迁移通过 _migrations 表跟踪，已应用的迁移不会重复执行。
`;

const SYNC_UPDATED_AT_HELP = `
${C.bold}同步节点编辑时间${C.reset}

${C.dim}Usage:${C.reset}
  bun run src/feishu.ts sync-updated-at [options]

${C.dim}选项:${C.reset}
  --output, -o <dir>     输出目录 (默认: ./docs/feishu)
  --space, -s <id>       只更新指定知识库
  --node-token, -n <id>  只更新指定节点
  --max-age <分钟>       增量同步阈值，只更新上次同步距今超过该时长的节点
  --help, -h             显示帮助

${C.dim}说明:${C.reset}
  批量调用 wiki +node-get API 获取节点的远端编辑时间 (updated_at)，
  并写入本地 SQLite 数据库。需要在 sync 之后执行。
  支持全量、按空间、按单节点三种更新范围。
  使用 --max-age 可跳过近期已同步的节点，减少 API 调用次数。
`;

// ============ 命令注册表 ============

/** 命令名 → 对应 args 类型的映射，用于给每个 spec 精确的 TArgs，避免函数参数协变不兼容。 */
interface ArgsByCommand {
    sync: SyncArgs;
    download: DownloadArgs;
    'copy-docs': CopyDocsArgs;
    'init-db': CommonArgs;
    'sync-updated-at': SyncUpdatedAtArgs;
    'diff-with': DiffWithArgs;
    help: CommonArgs;
}

export const commandSpecs: { [K in CommandName]: CommandSpec<ArgsByCommand[K]> } = {
    sync: {
        name: 'sync',
        summary: '同步知识库索引，清理过期文档',
        help: SYNC_HELP,
        buildArgs: (common: CommonArgs) => ({ ...common, spaces: [] }),
        flags: [
            {
                names: ['--space', '-s'],
                takesValue: true,
                apply: (args: SyncArgs, val) => { if (val) args.spaces.push(val); }
            }
        ],
        run: (args: SyncArgs) => runSync(args)
    },
    download: {
        name: 'download',
        summary: '根据索引下载文档内容（自动处理图片）',
        help: DOWNLOAD_HELP,
        buildArgs: (common: CommonArgs) => ({
            ...common,
            spaces: [],
            force: false,
            concurrency: 4,
            nodeToken: ''
        }),
        flags: [
            {
                names: ['--space', '-s'],
                takesValue: true,
                apply: (args: DownloadArgs, val) => { if (val) args.spaces.push(val); }
            },
            {
                names: ['--node-token', '-n'],
                takesValue: true,
                apply: (args: DownloadArgs, val) => {
                    if (val) args.nodeToken = val;
                    args.force = true;
                }
            },
            {
                names: ['--force', '-f'],
                takesValue: false,
                apply: (args: DownloadArgs) => { args.force = true; }
            },
            {
                names: ['--concurrency', '-c'],
                takesValue: true,
                apply: (args: DownloadArgs, val) => {
                    const n = Number(val);
                    args.concurrency = Math.max(1, isNaN(n) ? args.concurrency : n);
                }
            }
        ],
        run: (args: DownloadArgs) => runDownload(args)
    },
    'copy-docs': {
        name: 'copy-docs',
        summary: '复制已上传图片的文档到归档目录',
        help: COPY_DOCS_HELP,
        buildArgs: (common: CommonArgs) => ({ ...common, group: '' }),
        flags: [
            {
                names: ['--group', '-g'],
                takesValue: true,
                apply: (args: CopyDocsArgs, val) => { if (val) args.group = val; }
            }
        ],
        run: (args: CopyDocsArgs) => runCopyDocs(args)
    },
    'diff-with': {
        name: 'diff-with',
        summary: '列出 copydocs 目标目录中的孤儿副本',
        help: DIFF_WITH_HELP,
        // buildArgs 返回骨架;位置参数由 parse-args 在 return 前注入
        // (group: '' 是占位,parse-args 必填校验失败时根本走不到这一步)
        buildArgs: (common: CommonArgs) => ({ ...common, group: '' }),
        flags: [],
        positional: {
            name: 'group',
            required: true,
            description: '要检测的 group 名(小写 [a-z0-9-]+,必填)'
        },
        run: (args: DiffWithArgs) => runDiffWith(args)
    },
    'init-db': {
        name: 'init-db',
        summary: '初始化数据库表结构（首次使用需先执行）',
        help: INIT_DB_HELP,
        buildArgs: (common: CommonArgs) => ({ ...common }),
        flags: [],
        run: (args: CommonArgs) => { runInitDB(args.output); }
    },
    'sync-updated-at': {
        name: 'sync-updated-at',
        summary: '批量更新节点编辑时间（updated_at）',
        help: SYNC_UPDATED_AT_HELP,
        buildArgs: (common: CommonArgs) => ({
            ...common,
            spaces: [],
            nodeToken: ''
        }),
        flags: [
            {
                names: ['--space', '-s'],
                takesValue: true,
                apply: (args: SyncUpdatedAtArgs, val) => { if (val) args.spaces.push(val); }
            },
            {
                names: ['--node-token', '-n'],
                takesValue: true,
                apply: (args: SyncUpdatedAtArgs, val) => { if (val) args.nodeToken = val; }
            },
            {
                names: ['--max-age'],
                takesValue: true,
                apply: (args: SyncUpdatedAtArgs, val) => {
                    const n = Number(val);
                    if (!isNaN(n) && n > 0) args.maxAge = n;
                }
            }
        ],
        run: (args: SyncUpdatedAtArgs) => runSyncUpdatedAt(args)
    },
    help: {
        name: 'help',
        summary: '显示帮助',
        help: '',
        buildArgs: (common: CommonArgs) => ({ ...common }),
        flags: [],
        run: () => { /* main() handles this case */ }
    }
};
