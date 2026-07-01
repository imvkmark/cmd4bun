// resolveAimDirectory 共享 helper 单元测试
//
// 覆盖 5 个场景:group 命中 / group fallback default / group 与 default 都缺 / feishu 整个未配置 / 相对路径解析

import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import { resolveAimDirectory, resolveAimUrl, collectAllAimDirectories } from '../../src/feishu/aim-dir';
import type { AppConfig } from '../../src/config';

describe('resolveAimDirectory', () => {
    test('group 命中 feishu.{group}.aimDirectory', () => {
        const cfg: AppConfig = {
            feishu: {
                blog: { aimDirectory: '/tmp/blog' }
            }
        };
        expect(resolveAimDirectory(cfg, 'blog')).toBe('/tmp/blog');
    });

    test('group 缺, fallback 到 feishu.default.aimDirectory', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimDirectory: '/tmp/default' }
            }
        };
        expect(resolveAimDirectory(cfg, 'blog')).toBe('/tmp/default');
    });

    test('group 缺, 但 feishu.default 完全没配 aimDirectory → 返回 null', () => {
        const cfg: AppConfig = {
            feishu: {
                default: {}
            }
        };
        expect(resolveAimDirectory(cfg, 'blog')).toBe(null);
    });

    test('group 与 default 都未配置, 返回 null', () => {
        const cfg: AppConfig = {
            feishu: {
                dir: './docs/feishu'
            }
        };
        expect(resolveAimDirectory(cfg, 'blog')).toBe(null);
    });

    test('feishu 整个未配置, 返回 null', () => {
        const cfg: AppConfig = {};
        expect(resolveAimDirectory(cfg, 'blog')).toBe(null);
    });

    test('相对路径解析为绝对路径 (基于 process.cwd())', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimDirectory: './relative/path' }
            }
        };
        const result = resolveAimDirectory(cfg, 'default');
        expect(result).toBe(join(process.cwd(), './relative/path'));
    });

    test('group 优先于 default', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimDirectory: '/tmp/default' },
                blog: { aimDirectory: '/tmp/blog' }
            }
        };
        expect(resolveAimDirectory(cfg, 'blog')).toBe('/tmp/blog');
    });
});

describe('resolveAimUrl', () => {
    test('group 命中 feishu.{group}.aimUrl', () => {
        const cfg: AppConfig = {
            feishu: {
                blog: { aimUrl: 'https://blog.example.com' }
            }
        };
        expect(resolveAimUrl(cfg, 'blog')).toBe('https://blog.example.com');
    });

    test('group 缺 aimUrl, fallback 到 feishu.default.aimUrl', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimUrl: 'https://default.example.com' }
            }
        };
        expect(resolveAimUrl(cfg, 'blog')).toBe('https://default.example.com');
    });

    test('group 缺 aimUrl 但配了 aimDirectory, fallback 到 default.aimUrl', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimUrl: 'https://default.example.com' },
                blog: { aimDirectory: '/tmp/blog' }
            }
        };
        expect(resolveAimUrl(cfg, 'blog')).toBe('https://default.example.com');
    });

    test('group 与 default 都未配置 aimUrl → 返回 null', () => {
        const cfg: AppConfig = {
            feishu: {
                dir: './docs/feishu',
                blog: { aimDirectory: '/tmp/blog' }
            }
        };
        expect(resolveAimUrl(cfg, 'blog')).toBe(null);
    });

    test('group 完全未配置, feishu 整个未配 aimUrl → 返回 null', () => {
        const cfg: AppConfig = {
            feishu: {
                blog: { aimDirectory: '/tmp/blog' }
            }
        };
        expect(resolveAimUrl(cfg, 'docs')).toBe(null);
    });

    test('feishu 整个未配置, 返回 null', () => {
        const cfg: AppConfig = {};
        expect(resolveAimUrl(cfg, 'blog')).toBe(null);
    });

    test('group 命中 default 自身应返回 feishu.default.aimUrl', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimUrl: 'https://default.example.com' }
            }
        };
        expect(resolveAimUrl(cfg, 'default')).toBe('https://default.example.com');
    });

    test('group 优先于 default', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimUrl: 'https://default.example.com' },
                blog: { aimUrl: 'https://blog.example.com' }
            }
        };
        expect(resolveAimUrl(cfg, 'blog')).toBe('https://blog.example.com');
    });
});

describe('collectAllAimDirectories', () => {
    test('单 group 命中 feishu.{group}.aimDirectory', () => {
        const cfg: AppConfig = {
            feishu: {
                blog: { aimDirectory: '/tmp/blog' }
            }
        };
        expect(collectAllAimDirectories(cfg)).toEqual(['/tmp/blog']);
    });

    test('group 缺 aimDirectory 时 fallback 到 feishu.default.aimDirectory', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimDirectory: '/tmp/default' },
                docs: {}
            }
        };
        // docs 走 fallback → /tmp/default;default 自身 → /tmp/default;去重后单条
        expect(collectAllAimDirectories(cfg)).toEqual(['/tmp/default']);
    });

    test('多 group 全部命中, 重复路径自动去重', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimDirectory: '/tmp/default' },
                blog: { aimDirectory: '/tmp/blog' },
                docs: { aimDirectory: '/tmp/docs' }
            }
        };
        expect(collectAllAimDirectories(cfg)).toEqual(['/tmp/default', '/tmp/blog', '/tmp/docs']);
    });

    test('多 group 全部 fallback 到 default, 全部去重为同一条', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimDirectory: '/tmp/default' },
                blog: {},
                docs: {}
            }
        };
        expect(collectAllAimDirectories(cfg)).toEqual(['/tmp/default']);
    });

    test('group 与 default 都缺 aimDirectory → 排除集为空', () => {
        const cfg: AppConfig = {
            feishu: {
                default: {},
                blog: {}
            }
        };
        expect(collectAllAimDirectories(cfg)).toEqual([]);
    });

    test('feishu 整个未配置 → 返回空数组', () => {
        const cfg: AppConfig = {};
        expect(collectAllAimDirectories(cfg)).toEqual([]);
    });

    test('跳过 dir 字符串字段与 aimUrl 字符串字段', () => {
        const cfg: AppConfig = {
            feishu: {
                dir: './docs/feishu',
                // aimUrl 是字符串,typeof 不是 object,被过滤
                default: { aimDirectory: '/tmp/default' }
            }
        };
        // dir 跳过,default 命中
        expect(collectAllAimDirectories(cfg)).toEqual(['/tmp/default']);
    });

    test('相对路径被 path.resolve 绝对化', () => {
        const cfg: AppConfig = {
            feishu: {
                default: { aimDirectory: './relative/path' }
            }
        };
        const result = collectAllAimDirectories(cfg);
        expect(result).toEqual([join(process.cwd(), './relative/path')]);
    });
});
