#!/usr/bin/env bun
import { input } from '@inquirer/prompts';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, resolveToken, getConfigPath } from './config';
import { chat } from './shared/deepseek-client';
import { C } from './shared/colors';
import { printFileTree } from './commit/tree';
import { selectFiles, selectAction } from './commit/selector';
import { getStagedDiff, getWorkingTreeDiff } from './commit/diff';

// ============ Diff 获取 ============

function getDiff(): string {
    const staged = getStagedDiff();
    if (staged) return staged;

    const unstaged = getWorkingTreeDiff();
    if (!unstaged) {
        console.error('❌ 无法获取 git diff，请确认当前目录是 git 仓库');
        process.exit(1);
    }
    return unstaged;
}

async function generateMessage(token: string, modelName: string, diff: string, reasoningEffort?: string): Promise<string> {
    return chat({ token, model: modelName }, {
        systemPrompt:
            '你是一个 Git 提交信息生成助手。根据 diff 内容生成简洁的中文提交说明，遵循 Conventional Commits 格式（如 feat:、fix:、refactor: 等）。只输出提交说明本身，不要额外解释。',
        userPrompt: `请根据以下 diff 生成一条提交说明：\n\n\`\`\`\n${diff.slice(0, 12000)}\n\`\`\``,
        maxTokens: 1024,
        reasoningEffort
    });
}

// ============ Auto 模式 ============

function autoCommitAndPush(message: string): void {
    if (!message.trim()) {
        console.error(`\n  ${C.red}✗${C.reset} Generated commit message is empty. Aborting.`);
        console.error(`  ${C.dim}可能原因：当前所有变更都被 .gitignore 过滤，或 diff 为空。${C.reset}`);
        process.exit(1);
    }

    console.log(`\n  ${C.bold}Commit message:${C.reset}\n`);
    console.log(`  ${C.dim}│${C.reset} ${message}\n`);
    console.log(`  ${C.dim}Auto-committing and pushing...${C.reset}\n`);

    // 清理可能残留的 lock 文件
    try {
        const lockFile = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim() + '/index.lock';
        execSync(`rm -f ${JSON.stringify(lockFile)}`);
    } catch { /* ignore */ }

    // 调用方（main 中的 --auto 路径）已保证所有变更 staged，无需重复 git add

    try {
        execFileSync('git', ['commit', '-m', message], { stdio: 'inherit' });
    } catch (e) {
        console.error(`\n  ${C.red}✗${C.reset} Commit failed:`, (e as Error).message);
        process.exit(1);
    }
    console.log(`\n  ${C.green}✓${C.reset} Committed!`);

    try {
        execFileSync('git', ['push'], { stdio: 'inherit' });
        console.log(`\n  ${C.green}✓${C.reset} Pushed!`);
    } catch (e) {
        console.error(`\n  ${C.yellow}⚠${C.reset} Push failed (commit succeeded):`, (e as Error).message);
        process.exit(1);
    }
}

// ============ Main ============

async function main() {
    // 解析 --auto 参数：跳过交互，直接 commit + push
    const isAuto = process.argv.slice(2).includes('--auto');

    // Ctrl+C 退出
    process.on('SIGINT', () => {
        console.log(`\n  ${C.dim}Cancelled${C.reset}`);
        process.exit(0);
    });

    // 加载配置
    const cfg = await loadConfig();
    const token = resolveToken(cfg, process.env);
    if (!token) {
        console.error(`\n  ${C.red}✗${C.reset} Missing DeepSeek API token. Set via:`);
        console.error(`  ${C.dim}• Environment variable: ${C.bold}CMD_BUN_DEEPSEEK_TOKEN${C.reset}`);
        console.error(`  ${C.dim}• Config file field: ${C.bold}deepseek.token${C.reset}`);
        console.error(`  ${C.dim}• Config file path: ${C.bold}${getConfigPath()}${C.reset}\n`);
        process.exit(1);
    }

    // 模型名：优先从配置读取，默认 deepseek-chat
    const modelName = cfg.deepseek?.model ?? 'deepseek-chat';
    const reasoningEffort = cfg.deepseek?.reasoningEffort;

    const { hasChanges, fileCount, changes } = printFileTree();
    if (!hasChanges) {
        process.exit(0);
    }

    // --auto 模式：先把所有变更 staged，避免纯 untracked 场景下 diff 为空
    if (isAuto) {
        try {
            execSync('git add -A');
        } catch (e) {
            console.error(`\n  ${C.red}✗${C.reset} git add failed:`, (e as Error).message);
            process.exit(1);
        }
    }

    const diff = getDiff();
    if (!diff && fileCount > 0) {
        console.log(`  ${C.dim}Generating commit message...${C.reset}\n`);
    } else if (!diff) {
        console.log(`  ${C.dim}No changes to commit${C.reset}`);
        process.exit(0);
    } else {
        console.log(`  ${C.dim}Generating commit message...${C.reset}\n`);
    }

    let message = await generateMessage(token, modelName, diff, reasoningEffort);

    if (isAuto) {
        autoCommitAndPush(message);
        return;
    }

    const actionOptions = [
        { key: 'a', label: 'Accept', color: C.green },
        { key: 'm', label: 'Modify', color: C.yellow },
        { key: 'r', label: 'Regenerate', color: C.cyan },
        { key: 'x', label: 'Exit', color: C.red }
    ];

    while (true) {
        console.log(`\n  ${C.bold}Commit message:${C.reset}\n`);
        console.log(`  ${C.dim}│${C.reset} ${message}\n`);

        const action = await selectAction(actionOptions);

        if (action === 'x') {
            process.exit(0);
        }
        if (action === 'a') {
            // 恢复 stdin
            process.stdin.setRawMode(false);
            process.stdin.pause();

            const selectedPaths = await selectFiles(changes);
            if (selectedPaths.length === 0) {
                console.log(`  ${C.dim}No files selected, going back${C.reset}\n`);
                continue;
            }

            console.log();
            console.log(`  ${C.dim}Commit: "${message}"${C.reset}`);
            console.log();

            // 清理可能残留的 lock 文件
            try {
                const lockFile = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim() + '/index.lock';
                execSync(`rm -f ${JSON.stringify(lockFile)}`);
            } catch { /* ignore */ }

            // 恢复 stdin 为正常模式，避免 git 继承 raw mode 的 stdin
            process.stdin.setRawMode(false);
            process.stdin.pause();

            // 只 add 选中的文件
            try {
                // git add 处理包含特殊字符的路径
                execSync(`git add -- ${selectedPaths.map((p) => JSON.stringify(p)).join(' ')}`);
            } catch (e) {
                console.error(`\n  ${C.red}✗${C.reset} git add failed:`, (e as Error).message);
                process.exit(1);
            }

            execFileSync('git', ['commit', '-m', message], { stdio: 'inherit' });
            console.log(`\n  ${C.green}✓${C.reset} Committed!`);
            break;
        }
        if (action === 'm') {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            message = await input({ message: '  Enter commit message:', default: message });

            console.log();
            console.log(`  ${C.dim}Commit: "${message}"${C.reset}`);
            console.log();

            // 清理可能残留的 lock 文件
            try {
                const lockFile = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim() + '/index.lock';
                execSync(`rm -f ${JSON.stringify(lockFile)}`);
            } catch { /* ignore */ }

            // 恢复 stdin 为正常模式，避免 git 继承 raw mode 的 stdin
            process.stdin.setRawMode(false);
            process.stdin.pause();

            try {
                execSync('git add -A');
            } catch { /* ignore */ }

            execFileSync('git', ['commit', '-m', message], { stdio: 'inherit' });
            console.log(`\n  ${C.green}✓${C.reset} Committed!`);
            break;
        }
        // r - regenerate
        console.log(`  ${C.dim}Regenerating...${C.reset}\n`);
        message = await generateMessage(token, modelName, diff, reasoningEffort);
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${C.red}✗${C.reset} Error:`, message);
    process.exit(1);
});
