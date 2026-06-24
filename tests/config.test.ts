import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
    getConfigDir,
    getConfigPath,
    loadConfig,
    resolveToken,
    resolveFeishuDir,
    resolveFeishuGroupConfig
} from '../src/config';
import type { AppConfig } from '../src/config';

// ============ Helpers ============

function createTempConfigDir(): { parentDir: string; configDir: string; cleanup: () => void } {
    const parentDir = mkdtempSync(join(tmpdir(), 'cmd4bun-test-'));
    const configDir = join(parentDir, 'cmd4bun');
    return {
        parentDir,
        configDir,
        cleanup: () => {
            try {
                rmSync(parentDir, { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    };
}

function withXdg(dir: string, fn: () => void | Promise<void>): void | Promise<void> {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
        const r = fn();
        if (r instanceof Promise) {
            return r.finally(() => {
                if (prev) process.env.XDG_CONFIG_HOME = prev;
                else delete process.env.XDG_CONFIG_HOME;
            });
        }
    } finally {
        if (prev) process.env.XDG_CONFIG_HOME = prev;
        else delete process.env.XDG_CONFIG_HOME;
    }
}

// ============ 5.1 无配置文件场景 ============

test('5.1 loadConfig returns empty object when no config file exists', async () => {
    const { parentDir, cleanup } = createTempConfigDir();
    try {
        await withXdg(parentDir, async () => {
            const cfg = await loadConfig();
            expect(cfg).toBeDefined();
            expect(cfg.deepseek?.token).toBeUndefined();
            expect(cfg.feishu?.dir).toBeUndefined();
        });
    } finally {
        cleanup();
    }
});

// ============ 5.2 有合法配置文件场景 ============

test('5.2 loadConfig correctly parses deepseek.token and feishu.dir', async () => {
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            deepseek: { token: 'sk-test-token-123' },
            feishu: { dir: '/custom/feishu/path' }
        }));

        await withXdg(parentDir, async () => {
            const cfg = await loadConfig();
            expect(cfg.deepseek?.token).toBe('sk-test-token-123');
            expect(cfg.feishu?.dir).toBe('/custom/feishu/path');
        });
    } finally {
        cleanup();
    }
});

// ============ 5.3 JSON 格式错误场景 ============

test('5.3 loadConfig does not crash on invalid JSON, returns empty object', async () => {
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), 'not valid json {{{');

        await withXdg(parentDir, async () => {
            // Should not throw
            const cfg = await loadConfig();
            expect(cfg).toBeDefined();
            expect(cfg.deepseek?.token).toBeUndefined();
        });
    } finally {
        cleanup();
    }
});

// ============ 5.4 配置文件部分字段缺失 ============

test('5.4 loadConfig fills missing fields with undefined', async () => {
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            deepseek: { token: 'sk-partial' }
        }));

        await withXdg(parentDir, async () => {
            const cfg = await loadConfig();
            expect(cfg.deepseek?.token).toBe('sk-partial');
            expect(cfg.feishu?.dir).toBeUndefined();
        });
    } finally {
        cleanup();
    }
});

// ============ 5.5 resolveToken 环境变量优先 ============

test('5.5 resolveToken prefers CMD_BUN_DEEPSEEK_TOKEN env var over config', () => {
    const cfg: AppConfig = { deepseek: { token: 'config-token' } };
    const env = { CMD_BUN_DEEPSEEK_TOKEN: 'env-token' } as typeof process.env;

    const result = resolveToken(cfg, env);
    expect(result).toBe('env-token');
});

// ============ 5.6 resolveToken 仅配置文件 ============

test('5.6 resolveToken uses config token when env var is not set', () => {
    const cfg: AppConfig = { deepseek: { token: 'config-token' } };
    const env = {} as typeof process.env;

    const result = resolveToken(cfg, env);
    expect(result).toBe('config-token');
});

test('5.6b resolveToken returns undefined when neither source has token', () => {
    const cfg: AppConfig = {};
    const env = {} as typeof process.env;

    const result = resolveToken(cfg, env);
    expect(result).toBeUndefined();
});

// ============ 5.7 resolveFeishuDir CLI 参数优先 ============

test('5.7 resolveFeishuDir prefers CLI value over config and default', () => {
    const cfg: AppConfig = { feishu: { dir: '/config/dir' } };

    const result = resolveFeishuDir(cfg, '/cli/dir');
    // absolute CLI path stays as-is
    expect(result).toBe(resolve(process.cwd(), '/cli/dir'));
});

test('5.7b resolveFeishuDir uses config when no CLI value', () => {
    const cfg: AppConfig = { feishu: { dir: '/config/dir' } };

    const result = resolveFeishuDir(cfg);
    // absolute config path stays as-is
    expect(result).toBe(resolve(process.cwd(), '/config/dir'));
});

test('5.7c resolveFeishuDir falls back to default when neither CLI nor config', () => {
    const cfg: AppConfig = {};

    const result = resolveFeishuDir(cfg);
    expect(result).toBe(resolve(process.cwd(), './docs/feishu'));
});

// ============ 5.8 resolveFeishuDir 相对路径解析 ============

test('5.8 resolveFeishuDir resolves relative paths against cwd', () => {
    const cfg: AppConfig = { feishu: { dir: './my-feishu-docs' } };

    const result = resolveFeishuDir(cfg);
    expect(result).toBe(resolve(process.cwd(), './my-feishu-docs'));
});

// ============ deepseek.model 配置测试 ============

test('loadConfig 正确解析 deepseek.model 字段', async () => {
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            deepseek: { token: 'sk-test', model: 'deepseek-v3' }
        }));

        await withXdg(parentDir, async () => {
            const cfg = await loadConfig();
            expect(cfg.deepseek?.model).toBe('deepseek-v3');
        });
    } finally {
        cleanup();
    }
});

test('loadConfig 不传 model 字段时不报错（可选字段）', async () => {
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            deepseek: { token: 'sk-test' }
        }));

        await withXdg(parentDir, async () => {
            const cfg = await loadConfig();
            expect(cfg.deepseek?.token).toBe('sk-test');
            expect(cfg.deepseek?.model).toBeUndefined();
        });
    } finally {
        cleanup();
    }
});

// ============ deepseek.reasoningEffort 配置测试 ============

test('loadConfig 正确解析 deepseek.reasoningEffort 字段', async () => {
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            deepseek: { token: 'sk-test', model: 'deepseek-v3', reasoningEffort: 'high' }
        }));

        await withXdg(parentDir, async () => {
            const cfg = await loadConfig();
            expect(cfg.deepseek?.reasoningEffort).toBe('high');
        });
    } finally {
        cleanup();
    }
});

test('loadConfig 不传 reasoningEffort 字段时不报错（可选字段）', async () => {
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            deepseek: { token: 'sk-test', model: 'deepseek-v3' }
        }));

        await withXdg(parentDir, async () => {
            const cfg = await loadConfig();
            expect(cfg.deepseek?.reasoningEffort).toBeUndefined();
        });
    } finally {
        cleanup();
    }
});

test('loadConfig reasoningEffort 接受 low/medium/high 合法值', async () => {
    const values = ['low', 'medium', 'high'] as const;
    const { parentDir, configDir, cleanup } = createTempConfigDir();
    try {
        mkdirSync(configDir, { recursive: true });
        for (const v of values) {
            writeFileSync(join(configDir, 'config.json'), JSON.stringify({
                deepseek: { reasoningEffort: v }
            }));

            await withXdg(parentDir, async () => {
                const cfg = await loadConfig();
                expect(cfg.deepseek?.reasoningEffort).toBe(v);
            });
        }
    } finally {
        cleanup();
    }
});

test('resolveToken 在配置含 model 字段时仍正确返回 token', () => {
    const cfg: AppConfig = { deepseek: { token: 'config-token', model: 'deepseek-v3' } };
    const env = {} as typeof process.env;

    const result = resolveToken(cfg, env);
    expect(result).toBe('config-token');
});

// ============ 5.9 getConfigDir XDG 设置/未设置场景 ============

test('5.9 getConfigDir uses XDG_CONFIG_HOME when set', () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/custom/xdg';
    try {
        expect(getConfigDir()).toBe('/custom/xdg/cmd4bun');
    } finally {
        if (prevXdg) process.env.XDG_CONFIG_HOME = prevXdg;
        else delete process.env.XDG_CONFIG_HOME;
    }
});

test('5.9b getConfigDir falls back to ~/.config when XDG_CONFIG_HOME unset', () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
        expect(getConfigDir()).toBe(join(homedir(), '.config', 'cmd4bun'));
    } finally {
        if (prevXdg) process.env.XDG_CONFIG_HOME = prevXdg;
    }
});

test('5.9c getConfigPath returns config.json under the config dir', () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/test/xdg';
    try {
        expect(getConfigPath()).toBe('/test/xdg/cmd4bun/config.json');
    } finally {
        if (prevXdg) process.env.XDG_CONFIG_HOME = prevXdg;
        else delete process.env.XDG_CONFIG_HOME;
    }
});

// ============ resolveFeishuGroupConfig 助手 ============

describe('resolveFeishuGroupConfig', () => {
    test('命中 feishu.default 应返回 default 配置', () => {
        const cfg: AppConfig = { feishu: { default: { aimDirectory: './docs' } } };
        expect(resolveFeishuGroupConfig(cfg, 'default')).toEqual({ aimDirectory: './docs' });
    });

    test('命中自定义 group 应返回对应配置', () => {
        const cfg: AppConfig = { feishu: { blog: { aimDirectory: './blog', aimUrl: 'https://blog.example.com' } } };
        expect(resolveFeishuGroupConfig(cfg, 'blog')).toEqual({ aimDirectory: './blog', aimUrl: 'https://blog.example.com' });
    });

    test('未配置该 group 应返回 null', () => {
        const cfg: AppConfig = { feishu: { default: { aimDirectory: './docs' } } };
        expect(resolveFeishuGroupConfig(cfg, 'blog')).toBeNull();
    });

    test('feishu 字段缺失应返回 null', () => {
        const cfg: AppConfig = {};
        expect(resolveFeishuGroupConfig(cfg, 'default')).toBeNull();
    });

    test('dir 是字符串字段不应被当作 group 配置', () => {
        const cfg: AppConfig = { feishu: { dir: './docs/feishu' } };
        expect(resolveFeishuGroupConfig(cfg, 'dir')).toBeNull();
    });
});

// ============ loadConfig 老配置警告 ============

describe('loadConfig 老配置警告', () => {
    test('检测到老 feishu.aimDirectory 应打 stderr 警告', async () => {
        const { parentDir, configDir, cleanup } = createTempConfigDir();
        const errors: string[] = [];
        const origErr = console.error;
        console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
        try {
            mkdirSync(configDir, { recursive: true });
            writeFileSync(join(configDir, 'config.json'), JSON.stringify({
                feishu: { aimDirectory: './legacy' }
            }));

            await withXdg(parentDir, async () => {
                await loadConfig();
            });
            const joined = errors.join('\n');
            expect(joined).toContain('aimDirectory');
            expect(joined).toContain('default');
        } finally {
            console.error = origErr;
            cleanup();
        }
    });

    test('检测到老 feishu.aimUrl 应打 stderr 警告', async () => {
        const { parentDir, configDir, cleanup } = createTempConfigDir();
        const errors: string[] = [];
        const origErr = console.error;
        console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
        try {
            mkdirSync(configDir, { recursive: true });
            writeFileSync(join(configDir, 'config.json'), JSON.stringify({
                feishu: { aimUrl: 'https://legacy.example.com' }
            }));

            await withXdg(parentDir, async () => {
                await loadConfig();
            });
            const joined = errors.join('\n');
            expect(joined).toContain('aimUrl');
        } finally {
            console.error = origErr;
            cleanup();
        }
    });

    test('新结构 feishu.default.aimDirectory 不应触发警告', async () => {
        const { parentDir, configDir, cleanup } = createTempConfigDir();
        const errors: string[] = [];
        const origErr = console.error;
        console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
        try {
            mkdirSync(configDir, { recursive: true });
            writeFileSync(join(configDir, 'config.json'), JSON.stringify({
                feishu: { default: { aimDirectory: './docs' } }
            }));

            await withXdg(parentDir, async () => {
                await loadConfig();
            });
            const joined = errors.join('\n');
            expect(joined).not.toContain('aimDirectory');
            expect(joined).not.toContain('aimUrl');
        } finally {
            console.error = origErr;
            cleanup();
        }
    });
});
