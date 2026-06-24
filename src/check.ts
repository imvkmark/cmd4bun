#!/usr/bin/env bun
// 飞书运行环境 preflight 检查（独立入口）
// 编译为 bin/cmd.check，不依赖 feishu CLI 框架

import { loadConfig, buildOssConfig } from './config';
import { runCheck } from './feishu/check';
import { C } from './shared/colors';

function printHelp(): void {
    console.log(`
${C.bold}检查飞书运行环境${C.reset}

${C.dim}Usage:${C.reset}
  cmd.check [options]

${C.dim}选项:${C.reset}
  --json              输出 JSON 格式供 CI / 脚本消费
  --skip-aliyun       跳过 aliyun CLI 与 OSS 上传测试
  --skip-auth         跳过 lark-cli 授权试探（节省 ~300ms）
  --help, -h          显示帮助

${C.dim}说明:${C.reset}
  独立做飞书运行环境 preflight 检查，覆盖 5 项：
    1. lark-cli 已安装
    2. lark-cli 授权可用（wiki +space-list 试探）
    3. aliyun CLI 已安装（仅当 OSS 配置存在）
    4. aliyun OSS 上传测试：上传 1KB 测试图后清理（仅当 OSS 配置存在）
    5. git user.email / user.name 已配置
  退出码：0 = 全部通过，1 = 任一失败。
`);
}

function parseArgs(): { skipAliyun: boolean; skipAuth: boolean; json: boolean } {
    const argv = process.argv.slice(2);
    const args = { skipAliyun: false, skipAuth: false, json: false };

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
        if (arg === '--json') {
            args.json = true;
            continue;
        }
        if (arg === '--skip-aliyun') {
            args.skipAliyun = true;
            continue;
        }
        if (arg === '--skip-auth') {
            args.skipAuth = true;
            continue;
        }
        console.error(`  ${C.red}✗${C.reset} 未知参数: ${arg}`);
        printHelp();
        process.exit(1);
    }

    return args;
}

async function main(): Promise<void> {
    const args = parseArgs();

    const cfg = await loadConfig();
    const deps = {
        buildOssConfig: () => buildOssConfig(cfg)
    };

    const code = await runCheck({ ...args, deps });
    process.exit(code);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${C.red}✗${C.reset} Error:`, message);
    process.exit(1);
});
