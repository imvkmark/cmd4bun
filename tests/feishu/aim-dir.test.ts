// resolveAimDirectory 共享 helper 单元测试
//
// 覆盖 5 个场景:group 命中 / group fallback default / group 与 default 都缺 / feishu 整个未配置 / 相对路径解析

import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import { resolveAimDirectory } from '../../src/feishu/aim-dir';
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
