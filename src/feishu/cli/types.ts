// CLI 参数类型：每个子命令一个 interface，由 ParsedCommand 联合保证类型安全

export interface CommonArgs {
    output: string;
}

export interface SyncArgs extends CommonArgs {
    spaces: string[];
}

export interface DownloadArgs extends CommonArgs {
    spaces: string[];
    force: boolean;
    concurrency: number;
    nodeToken: string;
}

export interface SyncUpdatedAtArgs extends CommonArgs {
    spaces: string[];
    nodeToken: string;
    /** 增量同步阈值（分钟），只更新上次同步超过该时长的节点;不传或 0 时全量更新 */
    maxAge?: number;
}

/** copy-docs 命令专属参数:可选 group 名,空串表示 fan-out 所有 group */
export interface CopyDocsArgs extends CommonArgs {
    group: string;
}

export type CommandName = 'sync' | 'download' | 'copy-docs' | 'init-db' | 'sync-updated-at' | 'help';

/**
 * 解析后的命令结果。`command` 决定 `args` 的具体类型，
 * 消费者用 `switch (parsed.command)` 即可获得精确的 args 类型。
 */
export type ParsedCommand
    = | { command: 'sync'; args: SyncArgs }
        | { command: 'download'; args: DownloadArgs }
        | { command: 'copy-docs'; args: CopyDocsArgs }
        | { command: 'init-db'; args: CommonArgs }
        | { command: 'sync-updated-at'; args: SyncUpdatedAtArgs }
        | { command: 'help'; args: CommonArgs }
        | { command: null; args: CommonArgs };
