#!/usr/bin/env bun
// cmd.skills — Setup Claude Code skills symlinks from agent-skills repository

import { select, confirm } from '@inquirer/prompts';
import { loadConfig, getConfigDir } from './config';
import { C } from './shared/colors';
import { exists, mkdir, symlink, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// ============ Types ============

type SkillType = 'bun' | 'php' | 'java-ss' | 'java-ms';

interface SkillManifest {
    /** 类型专属技能 (放在 <type>/ 子目录下) */
    typed: string[];
    /** 通用开发技能 (放在 development/ 子目录下) */
    common: string[];
}

// ============ Skill Manifests ============

const SKILL_MANIFESTS: Record<SkillType, SkillManifest> = {
    bun: {
        typed: ['bun-analyzer', 'bun-rules'],
        common: ['req-discuss', 'req-task', 'req-userstory']
    },
    php: {
        typed: [
            'php-analyzer',
            'php-rules',
            'dead-routes',
            'change-discuss',
            'api-scan'
        ],
        common: ['req-discuss', 'req-task', 'req-userstory']
    },
    'java-ss': {
        typed: ['java-ss-analyzer', 'java-ss-rules'],
        common: ['req-discuss', 'req-task', 'req-userstory']
    },
    'java-ms': {
        typed: ['java-ms-analyzer', 'java-ms-rules'],
        common: ['req-discuss', 'req-task', 'req-userstory']
    }
};

const SKILL_TYPE_LABELS: Record<SkillType, string> = {
    bun: 'Bun / TypeScript',
    php: 'PHP',
    'java-ss': 'Java (Spring Standard)',
    'java-ms': 'Java (Microservice)'
};

// ============ Config ============

async function resolveAgentSkillsDir(): Promise<string> {
    const cfg = await loadConfig();
    if (cfg.skills?.directory) {
        return cfg.skills.directory;
    }
    return join(getConfigDir(), 'agent-skills');
}

// ============ Symlink Logic ============

async function ensureDir(path: string): Promise<void> {
    if (!(await exists(path))) {
        await mkdir(path, { recursive: true });
    }
}

/**
 * 移除目标路径下的旧 symlink（如果是 symlink 的话）。
 * 如果是真实目录/文件则跳过，避免误删用户数据。
 */
async function removeIfSymlink(target: string): Promise<void> {
    try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) {
            await unlink(target);
        }
    } catch {
    // 文件不存在，无需处理
    }
}

interface SymlinkResult {
    skill: string;
    ok: boolean;
    reason?: string;
}

async function setupSkill(
    agentSkillsDir: string,
    sourceSubDir: string,
    skillName: string
): Promise<SymlinkResult> {
    const source = join(agentSkillsDir, sourceSubDir, skillName);
    const target = join('.claude', 'skills', skillName);

    if (!(await exists(source))) {
        return { skill: skillName, ok: false, reason: `源目录不存在: ${source}` };
    }

    await ensureDir(join('.claude', 'skills'));
    await removeIfSymlink(target);

    try {
        await symlink(source, target);
        return { skill: skillName, ok: true };
    } catch (err) {
        return {
            skill: skillName,
            ok: false,
            reason: err instanceof Error ? err.message : String(err)
        };
    }
}

// ============ Display ============

function printHeader(): void {
    console.log(`
  ${C.bold}cmd.skills${C.reset} — Claude Code 技能安装器
  ${C.dim}从 agent-skills 仓库创建 symlink 到 .claude/skills/${C.reset}
  `);
}

function printResult(
    skillType: SkillType,
    results: SymlinkResult[]
): void {
    const ok = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);

    console.log(`\n  ${C.bold}安装结果: ${SKILL_TYPE_LABELS[skillType]}${C.reset}\n`);

    for (const r of ok) {
        console.log(`  ${C.green}✓${C.reset} ${r.skill}`);
    }
    for (const r of fail) {
        console.log(
            `  ${C.red}✗${C.reset} ${r.skill} ${C.dim}— ${r.reason}${C.reset}`
        );
    }

    console.log(
        `\n  ${ok.length} 成功, ${fail.length} 失败, 共 ${results.length} 个技能\n`
    );
}

function printCurrentLinks(results: SymlinkResult[]): void {
    if (results.length === 0) {
        console.log(`  ${C.dim}(无已安装的技能)${C.reset}\n`);
        return;
    }
    for (const r of results) {
        const icon = r.ok ? `${C.green}●${C.reset}` : `${C.red}✗${C.reset}`;
        const note = r.reason ? ` ${C.dim}(${r.reason})${C.reset}` : '';
        console.log(`  ${icon} ${r.skill}${note}`);
    }
    console.log('');
}

// ============ Scan Existing ============

async function scanExisting(): Promise<SymlinkResult[]> {
    const skillsDir = join('.claude', 'skills');
    if (!(await exists(skillsDir))) return [];

    const entries: SymlinkResult[] = [];
    try {
        const { readdir } = await import('node:fs/promises');
        const names = await readdir(skillsDir);

        for (const name of names) {
            if (name.startsWith('.')) continue;
            try {
                const stat = await lstat(join(skillsDir, name));
                entries.push({
                    skill: name,
                    ok: stat.isSymbolicLink(),
                    reason: stat.isSymbolicLink() ? undefined : '不是 symlink'
                });
            } catch {
                entries.push({ skill: name, ok: false, reason: '无法读取' });
            }
        }
    } catch {
    // 目录不存在或无法读取
    }
    return entries;
}

// ============ Parse CLI Args ============

interface CliArgs {
    skillType: SkillType | null;
    showHelp: boolean;
}

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);
    const validTypes = new Set<string>(['bun', 'php', 'java-ss', 'java-ms']);

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            return { skillType: null, showHelp: true };
        }
        if (validTypes.has(arg)) {
            return { skillType: arg as SkillType, showHelp: false };
        }
    }
    return { skillType: null, showHelp: false };
}

function printHelp(): void {
    console.log(`
${C.bold}cmd.skills${C.reset} — 从 agent-skills 仓库安装 Claude Code 技能

${C.dim}Usage:${C.reset}
  bun run src/skills.ts          交互模式，选择技能类型
  bun run src/skills.ts <type>   直接安装指定类型的技能

${C.dim}支持的技能类型:${C.reset}
  bun        Bun / TypeScript 项目
  php        PHP 项目
  java-ss    Java Spring Standard 项目
  java-ms    Java Microservice 项目

${C.dim}配置 agent-skills 路径 (${getConfigDir()}/config.json):${C.reset}
  {
    "skills": {
      "directory": "/path/to/agent-skills"
    }
  }
  默认路径: ${getConfigDir()}/agent-skills

${C.dim}示例:${C.reset}
  bun run src/skills.ts
  bun run src/skills.ts bun
  bun run src/skills.ts php
`);
}

// ============ Main ============

async function main(): Promise<void> {
    const cli = parseArgs();

    if (cli.showHelp) {
        printHelp();
        return;
    }

    const skillType = cli.skillType;

    // 非交互模式：直接安装
    if (skillType) {
        const agentSkillsDir = await resolveAgentSkillsDir();
        const manifest = SKILL_MANIFESTS[skillType];

        console.log(
            `\n  ${C.bold}安装 ${SKILL_TYPE_LABELS[skillType]} 技能${C.reset}`
        );
        console.log(`  ${C.dim}源目录: ${agentSkillsDir}${C.reset}`);

        const results: SymlinkResult[] = [];

        for (const name of manifest.typed) {
            results.push(await setupSkill(agentSkillsDir, skillType, name));
        }
        for (const name of manifest.common) {
            results.push(await setupSkill(agentSkillsDir, 'development', name));
        }

        printResult(skillType, results);
        return;
    }

    // 交互模式
    printHeader();

    // 显示当前已安装的技能
    const existing = await scanExisting();
    console.log(`  ${C.bold}当前已安装:${C.reset}`);
    printCurrentLinks(existing);

    // 选择技能类型
    const chosen = await select({
        message: '选择要安装的技能类型',
        choices: (Object.entries(SKILL_TYPE_LABELS) as [SkillType, string][]).map(
            ([value, label]) => ({
                name: label,
                value
            })
        )
    });

    const agentSkillsDir = await resolveAgentSkillsDir();
    const manifest = SKILL_MANIFESTS[chosen];

    console.log(
        `\n  ${C.dim}源目录: ${agentSkillsDir}${C.reset}`
    );
    console.log(
        `  ${C.dim}类型技能: ${manifest.typed.join(', ')}${C.reset}`
    );
    console.log(
        `  ${C.dim}通用技能: ${manifest.common.join(', ')}${C.reset}`
    );

    const ok = await confirm({
        message: '确认安装以上技能？',
        default: true
    });

    if (!ok) {
        console.log(`\n  ${C.dim}已取消${C.reset}\n`);
        return;
    }

    const results: SymlinkResult[] = [];

    for (const name of manifest.typed) {
        results.push(await setupSkill(agentSkillsDir, chosen, name));
    }
    for (const name of manifest.common) {
        results.push(await setupSkill(agentSkillsDir, 'development', name));
    }

    printResult(chosen, results);
}

if (import.meta.main) {
    main().catch((err: unknown) => {
        console.error(
            `\n  ${C.red}✗${C.reset} Error:`,
            err instanceof Error ? err.message : err
        );
        process.exit(1);
    });
}
