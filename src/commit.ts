#!/usr/bin/env bun
import { input } from '@inquirer/prompts';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, resolveToken, getConfigPath } from './config';
import { chat } from './shared/deepseek-client';
import { C } from './shared/colors';
import { printFileTree } from './commit/tree';
import { selectFiles, selectAction } from './commit/selector';

// ============ Gitignore 建议 ============

async function suggestGitignore(
    token: string,
    modelName: string,
    changes: { path: string; status: string }[],
    reasoningEffort?: string
): Promise<{ pattern: string; reason: string }[]> {
    if (changes.length === 0) return [];

    const fileList = changes.map(c => c.path).join('\n');

    // 读取现有 .gitignore 内容
    let existingGitignore = '';
    try {
        existingGitignore = execSync('cat .gitignore', { encoding: 'utf-8' }).trim();
    } catch { /* ignore */ }

    const text = await chat({ token, model: modelName }, {
        systemPrompt: `你是一个 Git 专家。分析文件列表，判断哪些文件应该被添加到 .gitignore 中。

规则：
- 只输出 JSON 数组，不要输出其他内容
- 每个元素包含 pattern（gitignore 模式）和 reason（简短理由）
- 使用通配符匹配同类文件（如 *.log, dir/）
- 不要建议已经在 .gitignore 中的模式
- 如果所有文件都应该提交，返回空数组 []

输出格式：
[{"pattern": "node_modules/", "reason": "Dependencies"}, {"pattern": "*.log", "reason": "Log files"}]`,
        userPrompt: `当前变更的文件列表：\n${fileList}\n\n现有 .gitignore 内容：\n${existingGitignore || '(empty)'}`,
        maxTokens: 512,
        reasoningEffort
    });

    if (!text) return [];

    // 提取 JSON（模型可能输出 markdown code block）
    const jsonMatch = /\[[\s\S]*\]/.exec(text);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { pattern: string; reason: string }[];
    return parsed.filter((s) => s.pattern && s.reason);
}

function printGitignoreSuggestions(suggestions: { pattern: string; reason: string }[]) {
    if (suggestions.length === 0) return;

    console.log(`\n  ${C.cyan}Suggest:${C.reset} ${C.dim}Add to .gitignore${C.reset}\n`);

    for (const s of suggestions) {
        console.log(`  ${C.dim}│${C.reset} ${C.cyan}${s.pattern}${C.reset} ${C.dim}# ${s.reason}${C.reset}`);
    }
    console.log();
}

// ============ Diff 获取 ============

function getDiff(): string {
    // 优先取已暂存的 diff
    try {
        const staged = execSync('git diff --cached', { encoding: 'utf-8' }).trim();
        if (staged) return staged;
    } catch { /* ignore */ }

    // fallback 到未暂存的 diff
    try {
        return execSync('git diff', { encoding: 'utf-8' }).trim();
    } catch {
        console.error('❌ 无法获取 git diff，请确认当前目录是 git 仓库');
        process.exit(1);
    }
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

    try {
        execSync('git add -A');
    } catch { /* ignore */ }

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

    // 自动模式跳过 .gitignore 建议（节省一次 API 调用）
    if (!isAuto) {
        const suggestions = await suggestGitignore(token, modelName, changes, reasoningEffort);
        printGitignoreSuggestions(suggestions);
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
