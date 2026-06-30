// resolveAimDirectory 共享 helper 单元测试
//
// 覆盖 5 个场景:group 命中 / group fallback default / group 与 default 都缺 / feishu 整个未配置 / 相对路径解析

import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import { resolveAimDirectory, resolveAimUrl } from '../../src/feishu/aim-dir';
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
