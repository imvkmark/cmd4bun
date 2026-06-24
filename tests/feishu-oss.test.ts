import { test, expect } from 'bun:test';
import { normalizeUrlPrefix, normalizePathPrefix, buildPublicUrl, isAlreadyPublic } from '../src/feishu/images';

// ============ 6.3 OSS 公网 URL 生成测试 ============

test('6.3 normalizeUrlPrefix 移除末尾斜杠', () => {
    expect(normalizeUrlPrefix('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrlPrefix('https://example.com')).toBe('https://example.com');
    expect(normalizeUrlPrefix('https://example.com/path/')).toBe('https://example.com/path');
});

test('6.3 normalizePathPrefix 移除前后斜杠', () => {
    expect(normalizePathPrefix('/feishu-images/')).toBe('feishu-images');
    expect(normalizePathPrefix('feishu-images/')).toBe('feishu-images');
    expect(normalizePathPrefix('/feishu-images')).toBe('feishu-images');
    expect(normalizePathPrefix('feishu-images')).toBe('feishu-images');
    expect(normalizePathPrefix('')).toBe('');
});

test('6.3 buildPublicUrl 正确组合 URL', () => {
    expect(buildPublicUrl('https://static.example.com', 'feishu-images', 'abc123.png'))
        .toBe('https://static.example.com/feishu-images/abc123.png');
});

test('6.3 buildPublicUrl 处理空 pathPrefix', () => {
    expect(buildPublicUrl('https://static.example.com', '', 'abc123.png'))
        .toBe('https://static.example.com/abc123.png');
});

test('6.3 buildPublicUrl 自动归一化斜杠', () => {
    expect(buildPublicUrl('https://static.example.com/', '/feishu-images/', 'abc123.png'))
        .toBe('https://static.example.com/feishu-images/abc123.png');
});

// ============ 6.4 已公网化图片直接跳过测试 ============

test('6.4 isAlreadyPublic 识别相同域名的 URL', () => {
    expect(isAlreadyPublic(
        'https://static.example.com/feishu-images/abc123.png',
        'https://static.example.com'
    )).toBe(true);
});

test('6.4 isAlreadyPublic 识别相同域名带路径的 URL', () => {
    expect(isAlreadyPublic(
        'https://static.example.com/feishu-images/abc123.png',
        'https://static.example.com/feishu-images'
    )).toBe(true);
});

test('6.4 isAlreadyPublic 识别不同域名的 URL', () => {
    expect(isAlreadyPublic(
        'https://example.com/image.png',
        'https://static.example.com'
    )).toBe(false);
});

test('6.4 isAlreadyPublic 处理无效 URL', () => {
    expect(isAlreadyPublic('not-a-url', 'https://static.example.com')).toBe(false);
});
