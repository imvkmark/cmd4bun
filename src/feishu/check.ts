// 飞书运行环境 preflight 检查 (cmd.feishu check / cmd.check)
// 检查 5 项：lark-cli 安装 / lark-cli 授权 / aliyun CLI 安装 / aliyun OSS 上传测试 / git user 配置

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { C } from '../shared/colors';
import type { OssClientConfig } from '../config';

// ============ 类型 ============

/** 单项检查结果 */
export interface CheckResult {
    /** 检查项标识（如 'lark-cli-install'），用于 JSON / 日志 */
    name: string;
    /** 是否通过 */
    ok: boolean;
    /** 人类可读的详细说明（如版本号、错误原因） */
    detail?: string;
    /** 失败时的修复提示 */
    fix?: string;
}

/** spawn 调用抽象 —— 测试可注入 mock */
export interface SpawnLike {
    run(args: string[], opts?: { timeout?: number }): {
        exitCode: number;
        stdout: Uint8Array;
        stderr: Uint8Array;
    };
}

/** 默认 spawn：包装 Bun.spawnSync */
const defaultSpawn: SpawnLike = {
    run: (args, opts) => Bun.spawnSync(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {})
    })
};

// ============ lark-cli 安装 ============

export function checkLarkInstalled(spawn: SpawnLike = defaultSpawn): CheckResult {
    const proc = spawn.run(['lark-cli', '--version']);
    if (proc.exitCode !== 0) {
        return {
            name: 'lark-cli-install',
            ok: false,
            detail: 'lark-cli 未安装或不可执行',
            fix: '安装: https://github.com/larksuite/cli'
        };
    }
    const version = new TextDecoder().decode(proc.stdout).trim();
    return { name: 'lark-cli-install', ok: true, detail: version || '已安装' };
}

// ============ lark-cli 授权 ============

export function checkLarkAuth(spawn: SpawnLike = defaultSpawn): CheckResult {
    const proc = spawn.run(
        ['lark-cli', 'wiki', '+space-list', '--page-size', '1', '--json', '--as', 'user'],
        { timeout: 10_000 }
    );
    if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr).trim();
        const firstLine = stderr.split('\n')[0] ?? '';
        return {
            name: 'lark-cli-auth',
            ok: false,
            detail: firstLine !== '' ? firstLine : `exit ${proc.exitCode}`,
            fix: '请先登录: lark-cli auth login --domain wiki,docs'
        };
    }
    return { name: 'lark-cli-auth', ok: true, detail: 'wiki +space-list OK' };
}

// ============ aliyun CLI 安装 ============

export function checkAliyunInstalled(spawn: SpawnLike = defaultSpawn): CheckResult {
    const proc = spawn.run(['aliyun', '--version']);
    if (proc.exitCode !== 0) {
        return {
            name: 'aliyun-install',
            ok: false,
            detail: 'aliyun CLI 未安装或不可执行',
            fix: '安装: https://help.aliyun.com/cli'
        };
    }
    const version = new TextDecoder().decode(proc.stdout).trim();
    return { name: 'aliyun-install', ok: true, detail: version || '已安装' };
}

// ============ aliyun OSS 上传测试 ============

/**
 * 上传 1KB 测试图到 OSS，校验后清理；任一步失败 throw 风格的 CheckResult。
 * try-finally 保证清理临时文件 + 远端对象。
 */
export async function checkAliyunUpload(
    ossConfig: OssClientConfig,
    spawn: SpawnLike = defaultSpawn
): Promise<CheckResult> {
    const remoteKey = `${ossConfig.pathPrefix.replace(/^\/+|\/+$/g, '')}/.preflight/${Date.now()}.bin`;
    const remotePath = `oss://${ossConfig.bucket}/${remoteKey}`;
    const localPath = join(tmpdir(), `cmd4bun-preflight-${Date.now()}.bin`);

    // 生成 1KB 随机字节
    const bytes = new Uint8Array(1024);
    crypto.getRandomValues(bytes);
    await Bun.write(localPath, bytes);

    try {
        const cpProc = spawn.run(
            [
                'aliyun', 'ossutil', 'cp', localPath, remotePath,
                '--profile', ossConfig.profile,
                '-e', `oss-${ossConfig.region}.aliyuncs.com`,
                '--region', ossConfig.region,
                '-f'
            ],
            { timeout: 30_000 }
        );
        if (cpProc.exitCode !== 0) {
            const stderr = new TextDecoder().decode(cpProc.stderr).trim();
            const firstLine = stderr.split('\n')[0] ?? '';
            return {
                name: 'aliyun-upload',
                ok: false,
                detail: firstLine !== '' ? firstLine : `exit ${cpProc.exitCode}`,
                fix: '检查 oss.profile / bucket / pathPrefix / 网络连通性'
            };
        }
        return { name: 'aliyun-upload', ok: true, detail: `上传/校验/清理 OK (${remoteKey})` };
    } finally {
        // 清理本地临时文件
        try {
            unlinkSync(localPath);
        } catch {
            /* ignore */
        }
        // 清理远端测试对象
        spawn.run(
            [
                'aliyun', 'ossutil', 'rm', remotePath,
                '--profile', ossConfig.profile,
                '-e', `oss-${ossConfig.region}.aliyuncs.com`,
                '--region', ossConfig.region,
                '-f'
            ],
            { timeout: 30_000 }
        );
    }
}

// ============ git user 配置 ============

/**
 * 检查 git user.email 和 user.name 是否设置。
 * 任一缺失则整体 fail，detail 列出缺失项，fix 给出修复命令。
 */
export function checkGitConfig(spawn: SpawnLike = defaultSpawn): CheckResult {
    const checks: { key: 'user.email' | 'user.name'; value: string }[] = [];
    const missing: string[] = [];

    for (const key of ['user.email', 'user.name'] as const) {
        const proc = spawn.run(['git', 'config', '--get', key]);
        if (proc.exitCode !== 0) {
            missing.push(key);
            continue;
        }
        const value = new TextDecoder().decode(proc.stdout).trim();
        if (!value) {
            missing.push(key);
            continue;
        }
        checks.push({ key, value });
    }

    if (missing.length > 0) {
        return {
            name: 'git-config',
            ok: false,
            detail: `未设置: ${missing.join(', ')}`,
            fix: 'git config --global user.email "you@example.com"\ngit config --global user.name "Your Name"'
        };
    }
    const summary = checks.map((c) => `${c.key}=${c.value}`).join(', ');
    return { name: 'git-config', ok: true, detail: summary };
}

// ============ runCheck 主流程 ============

/** check 命令依赖：仅看输出，不需要 DB / 命令注册表 */
export interface RunCheckDeps {
    /** 解析 OSS 配置：返回 null 表示 OSS 未配置或配置不全 */
    buildOssConfig: () => OssClientConfig | null;
    /** spawn 抽象 —— 不传时用 defaultSpawn */
    spawn?: SpawnLike;
}

/** 默认 deps：从 ../config 加载 */
async function defaultDeps(): Promise<RunCheckDeps> {
    const { loadConfig, buildOssConfig } = await import('../config');
    const cfg = await loadConfig();
    return {
        buildOssConfig: () => buildOssConfig(cfg)
    };
}

export async function runCheck(args: {
    skipAliyun: boolean;
    skipAuth: boolean;
    json: boolean;
    /** 注入依赖用于测试；不传时使用 defaultDeps */
    deps?: RunCheckDeps;
}): Promise<number> {
    const deps = args.deps ?? await defaultDeps();
    const spawn = deps.spawn ?? defaultSpawn;
    const ossConfig = deps.buildOssConfig();
    const results: CheckResult[] = [];

    // 1. lark-cli 安装（总是跑）
    results.push(checkLarkInstalled(spawn));

    // 2. lark-cli 授权（skip-auth 时跳过）
    if (!args.skipAuth) {
        results.push(checkLarkAuth(spawn));
    }

    // 3-4. aliyun 安装 + 上传测试（ossConfig 非空 且 非 --skip-aliyun）
    if (!args.skipAliyun && ossConfig) {
        results.push(checkAliyunInstalled(spawn));
        results.push(await checkAliyunUpload(ossConfig, spawn));
    }

    // 5. git user 配置（总是跑）
    results.push(checkGitConfig(spawn));

    if (args.json) {
        printJson(results);
    } else {
        printText(results);
    }

    const failed = results.filter((r) => !r.ok).length;
    return failed === 0 ? 0 : 1;
}

// ============ 输出 ============

function printText(results: CheckResult[]): void {
    console.log(`\n  ${C.bold}飞书环境检查${C.reset}\n`);
    for (const r of results) {
        if (r.ok) {
            console.log(`  ${C.green}✓${C.reset} ${r.name} ${C.dim}${r.detail ?? ''}${C.reset}`);
        } else {
            console.log(`  ${C.red}✗${C.reset} ${r.name} ${C.dim}${r.detail ?? ''}${C.reset}`);
            if (r.fix) console.log(`    ${C.yellow}${r.fix}${C.reset}`);
        }
    }
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log();
    if (failed === 0) {
        console.log(`  ${C.green}✓${C.reset} ${passed}/${results.length} 项检查通过\n`);
    } else {
        console.log(`  ${C.red}✗${C.reset} ${failed}/${results.length} 项检查未通过\n`);
    }
}

function printJson(results: CheckResult[]): void {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    const payload = {
        ok: failed === 0,
        total: results.length,
        passed,
        failed,
        checks: results
    };
    console.log(JSON.stringify(payload, null, 2));
}
