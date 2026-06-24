#!/usr/bin/env bun
// 飞书知识库统一入口：薄壳，仅做 re-export 和启动 main()
// 实际 CLI 逻辑在 ./feishu/cli/ 子模块中。

// Re-export for tests
export { parseArgs } from './feishu/cli/parse-args';
export { sanitize, xmlToReadable, findMdFiles } from './feishu/utils';
export type {
    CommonArgs,
    SyncArgs,
    DownloadArgs,
    SyncUpdatedAtArgs,
    CommandName,
    ParsedCommand
} from './feishu/cli/types';

import { main } from './feishu/cli/main';

if (import.meta.main) {
    void main();
}
