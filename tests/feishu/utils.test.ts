// 飞书工具函数单元测试
import { test, expect, describe } from 'bun:test';
import { toDatetime, extractHeadings, extractBodyPreview, formatUpdatedAt, parseAndStripFrontmatter, parseFrontmatterMeta, sanitize, xmlToReadable, parseHtmlAttrs, resolveCiteBlocks, resolveSubPageListBlocks, convertDocumentTitleToHeading } from '../../src/feishu/utils';
import type { ResolveLinkResult } from '../../src/feishu/utils';

// ============ toDatetime ============

test('toDatetime: 有效时间戳应返回正确格式', () => {
    const result = toDatetime('1775572309');
    expect(result).toBe('2026-04-07 14:31:49');
});

test('toDatetime: 空字符串应返回空字符串', () => {
    expect(toDatetime('')).toBe('');
});

test('toDatetime: 非法格式应返回空字符串', () => {
    expect(toDatetime('abc')).toBe('');
    expect(toDatetime('-1')).toBe('');
    expect(toDatetime('0')).toBe('');
});

// ============ extractHeadings ============

test('extractHeadings: 多级标题应全部提取', () => {
    const md = `# 一级标题

一些正文

## 二级标题

更多正文

### 三级标题

结尾`;
    const result = extractHeadings(md);
    expect(result).toEqual(['一级标题', '二级标题', '三级标题']);
});

test('extractHeadings: 无标题文档应返回空数组', () => {
    const md = '这是一段纯正文，没有任何标题标记。';
    expect(extractHeadings(md)).toEqual([]);
});

test('extractHeadings: 含特殊字符的标题应正确处理', () => {
    const md = `# Hello World
## 测试 {#custom-id}
### 带符号：@#$%`;
    const result = extractHeadings(md);
    expect(result).toEqual(['Hello World', '测试', '带符号：@#$%']);
});

test('extractHeadings: 重复标题应去重', () => {
    const md = `# 标题A
## 标题B
# 标题A`;
    const result = extractHeadings(md);
    expect(result).toEqual(['标题A', '标题B']);
});

// ============ extractBodyPreview ============

test('extractBodyPreview: 正常正文应提取前 N 个中文字符', () => {
    const md = `---
slug: test
---

# 第一章节

这是正文第一段内容。继续第二句。

## 子标题

第三段正文内容。`;
    const result = extractBodyPreview(md, 10);
    expect(result).toBe('这是正文第一段内容。继续第二句。第三段正文内容。'.slice(0, 10));
    expect(result.length).toBe(10);
});

test('extractBodyPreview: 跳过 YAML frontmatter', () => {
    const md = `---
title: Test
slug: test-page
---

正文开始`;
    const result = extractBodyPreview(md, 100);
    expect(result).toContain('正文开始');
    expect(result).not.toContain('title:');
    expect(result).not.toContain('slug:');
});

test('extractBodyPreview: 跳过标题行和空行', () => {
    const md = `## 标题

- 列表项
- 列表项2

正文内容`;
    const result = extractBodyPreview(md, 50);
    expect(result).not.toContain('标题');
    expect(result).toContain('列表项');
    expect(result).toContain('正文内容');
});

test('extractBodyPreview: 正文少于 maxLen 时返回全部', () => {
    const md = '简短正文';
    const result = extractBodyPreview(md, 500);
    expect(result).toBe('简短正文');
});

test('extractBodyPreview: 混合中英文应保留', () => {
    const md = 'Hello 世界 测试 abc';
    const result = extractBodyPreview(md, 10);
    // 字符计数包含中英文，保留单词间单个空格：slice(0,10) → 'Hello 世界 测'
    expect(result).toBe('Hello 世界 测');
});

// ============ formatUpdatedAt ============

test('formatUpdatedAt: 有效 ISO 8601 应返回正确格式', () => {
    const result = formatUpdatedAt('2026-04-07T14:31:49Z');
    expect(result).toBe('2026-04-07 14:31:49');
});

test('formatUpdatedAt: 空字符串应返回空字符串', () => {
    expect(formatUpdatedAt('')).toBe('');
});

test('formatUpdatedAt: 非法格式应返回空字符串', () => {
    expect(formatUpdatedAt('not-a-date')).toBe('');
});

// ============ parseAndStripFrontmatter ============

describe('parseAndStripFrontmatter', () => {
    test('有 slug 的 YAML 代码块应被移除且返回 slug 值', () => {
        const md = `# 文档标题

一些正文内容。

\`\`\`yaml
slug: my-page
\`\`\`

更多正文。`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBe('my-page');
        expect(cleanedContent).not.toContain('slug:');
        expect(cleanedContent).not.toContain('```yaml');
        expect(cleanedContent).not.toContain('```');
        expect(cleanedContent).toContain('# 文档标题');
        expect(cleanedContent).toContain('一些正文内容');
        expect(cleanedContent).toContain('更多正文');
    });

    test('无 slug 的 YAML 代码块应保持内容不变', () => {
        const md = `# 标题

\`\`\`yaml
title: 测试
author: someone
\`\`\`

正文内容。`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBeNull();
        expect(cleanedContent).toBe(md);
    });

    test('无 YAML 代码块时应返回 null 且内容不变', () => {
        const md = '# 纯 Markdown 文档\n\n没有任何代码块\n\n结束';
        const { slug, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBeNull();
        expect(cleanedContent).toBe(md);
    });

    test('仅移除第一个含 slug 的 YAML 代码块，保留其他 YAML 块', () => {
        const md = `# 文档

\`\`\`yaml
slug: first-slug
\`\`\`

其他内容。

\`\`\`yaml
title: 配置信息
version: "1.0"
\`\`\`

结尾。`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBe('first-slug');
        expect(cleanedContent).not.toContain('slug:');
        expect(cleanedContent).not.toContain('first-slug');
        // 第二个 YAML 块应保留
        expect(cleanedContent).toContain('title: 配置信息');
        expect(cleanedContent).toContain('version: "1.0"');
    });

    test('支持 ```yml 语法', () => {
        const md = `# 文档

\`\`\`yml
slug: yml-slug
\`\`\`

正文。`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBe('yml-slug');
        expect(cleanedContent).not.toContain('yml-slug');
        expect(cleanedContent).not.toContain('```yml');
    });

    test('slug 值中含特殊字符时应正确提取', () => {
        const md = `\`\`\`yaml
slug: path/to/doc-v2.0_test
\`\`\`

正文`;
        const { slug, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBe('path/to/doc-v2.0_test');
        expect(cleanedContent).not.toContain('slug:');
    });

    test('slug 冒号前后有空格时应正确提取', () => {
        const md = `\`\`\`yaml
slug  :   spaced-slug
\`\`\`

正文`;
        const { slug } = parseAndStripFrontmatter(md);
        expect(slug).toBe('spaced-slug');
    });

    test('slug 代码块移除后不应产生多余空行', () => {
        const md = `# 标题

\`\`\`yaml
slug: test
\`\`\`

正文`;
        const { cleanedContent } = parseAndStripFrontmatter(md);
        // 不应有 3 个或更多连续换行
        expect(cleanedContent).not.toMatch(/\n{3,}/);
        // 标题和正文之间应刚好一个空行
        expect(cleanedContent).toBe('# 标题\n\n正文');
    });
});

// ============ parseFrontmatterMeta ============

describe('parseFrontmatterMeta', () => {
    test('YAML 块中 slug 字段应正确解析', () => {
        const content = `\`\`\`yaml
slug: my-page
\`\`\``;
        expect(parseFrontmatterMeta(content)).toEqual({ slug: 'my-page', ignore: false, group: 'default' });
    });

    test('解析 ignore 字段 — 值为 Y 时返回 true', () => {
        const content = `\`\`\`yaml
slug: draft-page
ignore: Y
\`\`\``;
        expect(parseFrontmatterMeta(content)).toEqual({ slug: 'draft-page', ignore: true, group: 'default' });
    });

    test('解析 ignore 字段 — 小写 y 不应识别', () => {
        const content = `\`\`\`yaml
ignore: y
\`\`\``;
        expect(parseFrontmatterMeta(content).ignore).toBe(false);
    });

    test('解析 ignore 字段 — yes/true/1/N/false/0 均视为 false', () => {
        const cases = ['yes', 'true', '1', 'N', 'no', 'false', '0', 'y'];
        for (const v of cases) {
            const content = `\`\`\`yaml
ignore: ${v}
\`\`\``;
            expect(parseFrontmatterMeta(content).ignore).toBe(false);
        }
    });

    test('解析 ignore 字段 — Y 带前后空白 trim 后仍识别为 true', () => {
        const cases = ['Y', '  Y', 'Y  ', '  Y  '];
        for (const v of cases) {
            const content = `\`\`\`yaml
ignore: ${v}
\`\`\``;
            expect(parseFrontmatterMeta(content).ignore).toBe(true);
        }
    });

    test('解析 ignore 字段 — 缺失时默认 false', () => {
        const content = `\`\`\`yaml
slug: regular-page
\`\`\``;
        expect(parseFrontmatterMeta(content)).toEqual({ slug: 'regular-page', ignore: false, group: 'default' });
    });

    test('解析 ignore 字段 — 空值视为 false', () => {
        const content = `\`\`\`yaml
ignore:
\`\`\``;
        expect(parseFrontmatterMeta(content).ignore).toBe(false);
    });

    test('无 YAML 块时 ignore 应为 false', () => {
        expect(parseFrontmatterMeta('# 纯 Markdown')).toEqual({ slug: null, ignore: false, group: 'default' });
    });

    test('YAML 块只有 slug 时 ignore 应为 false', () => {
        const content = `\`\`\`yaml
slug: only-slug
title: Some Title
\`\`\``;
        expect(parseFrontmatterMeta(content)).toEqual({ slug: 'only-slug', ignore: false, group: 'default' });
    });

    test('YAML 块只有 ignore 时 slug 应为 null、ignore 应为 true', () => {
        const content = `\`\`\`yaml
ignore: Y
\`\`\``;
        expect(parseFrontmatterMeta(content)).toEqual({ slug: null, ignore: true, group: 'default' });
    });
});

describe('parseAndStripFrontmatter — ignore 字段', () => {
    test('有 ignore: Y 的 YAML 代码块应被移除', () => {
        const md = `# 标题

\`\`\`yaml
ignore: Y
\`\`\`

正文。`;
        const { ignore, cleanedContent } = parseAndStripFrontmatter(md);
        expect(ignore).toBe(true);
        expect(cleanedContent).not.toContain('ignore:');
        expect(cleanedContent).not.toContain('```yaml');
        expect(cleanedContent).toContain('# 标题');
        expect(cleanedContent).toContain('正文。');
    });

    test('同时含 slug 和 ignore 的 YAML 代码块应被移除', () => {
        const md = `# 标题

\`\`\`yaml
slug: my-draft
ignore: Y
\`\`\`

正文。`;
        const { slug, ignore, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBe('my-draft');
        expect(ignore).toBe(true);
        expect(cleanedContent).not.toContain('slug:');
        expect(cleanedContent).not.toContain('ignore:');
        expect(cleanedContent).not.toContain('```yaml');
    });

    test('无 slug 也无 ignore 的 YAML 块应保留', () => {
        const md = `# 标题

\`\`\`yaml
title: 普通配置
author: someone
\`\`\`

正文。`;
        const { slug, ignore, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBeNull();
        expect(ignore).toBe(false);
        expect(cleanedContent).toBe(md);
    });

    test('ignore: N 的 YAML 块视为不忽略且应被移除（用于覆盖存量）', () => {
        const md = `# 标题

\`\`\`yaml
ignore: N
\`\`\`

正文。`;
        const { ignore, cleanedContent } = parseAndStripFrontmatter(md);
        expect(ignore).toBe(false);
        expect(cleanedContent).not.toContain('ignore:');
    });
});

// ============ sanitize ============

test('sanitize removes invalid path characters', () => {
    expect(sanitize('hello/world')).toBe('hello_world');
    expect(sanitize('test:file')).toBe('test_file');
    expect(sanitize('a*b?c')).toBe('a_b_c');
});

test('sanitize replaces newlines and tabs with underscores', () => {
    expect(sanitize('hello\nworld')).toBe('hello_world');
    expect(sanitize('a\tb')).toBe('a_b');
});

test('sanitize trims long names', () => {
    const long = 'a'.repeat(100);
    const result = sanitize(long);
    expect(result.length).toBeLessThanOrEqual(80);
});

test('sanitize returns underscore for empty result', () => {
    expect(sanitize('')).toBe('_');
    expect(sanitize('   ')).toBe('_');
});

test('sanitize handles normal names', () => {
    expect(sanitize('Hello World')).toBe('Hello World');
    expect(sanitize('  spaces  ')).toBe('spaces');
});

// ============ xmlToReadable ============

test('xmlToReadable converts heading tags', () => {
    const xml = '<heading1>Title</heading1>';
    const result = xmlToReadable(xml);
    expect(result).toBe('# Title');
});

test('xmlToReadable converts multiple heading levels', () => {
    const xml = '<heading1>H1</heading1><heading2>H2</heading2><heading3>H3</heading3>';
    const result = xmlToReadable(xml);
    expect(result).toContain('# H1');
    expect(result).toContain('## H2');
    expect(result).toContain('### H3');
});

// ============ parseFrontmatterMeta / parseAndStripFrontmatter — group 字段 ============

describe('解析 group 字段', () => {
    test('合法小写名应原样返回', () => {
        const content = `\`\`\`yaml
group: blog
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('blog');
    });

    test('合法名含连字符和数字应原样返回', () => {
        const content = `\`\`\`yaml
group: docs-2026
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('docs-2026');
    });

    test('缺失 group 字段应降级为 default', () => {
        const content = `\`\`\`yaml
slug: my-page
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('default');
    });

    test('group 字段为空值应降级为 default', () => {
        const content = `\`\`\`yaml
group:
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('default');
    });

    test('group 含大写字母应降级为 default', () => {
        const content = `\`\`\`yaml
group: Blog
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('default');
    });

    test('group 含下划线应降级为 default', () => {
        const content = `\`\`\`yaml
group: my_blog
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('default');
    });

    test('group 含路径分隔符应降级为 default', () => {
        const content = `\`\`\`yaml
group: ../etc
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('default');
    });

    test('group 含中文应降级为 default', () => {
        const content = `\`\`\`yaml
group: 博客
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('default');
    });

    test('group 含前后空白应 trim 后校验', () => {
        const content = `\`\`\`yaml
group:   docs-2026
\`\`\``;
        expect(parseFrontmatterMeta(content).group).toBe('docs-2026');
    });

    test('parseAndStripFrontmatter — 仅 group 字段也应剥离 YAML 块', () => {
        const md = `# 标题

\`\`\`yaml
group: blog
\`\`\`

正文。`;
        const { group, cleanedContent } = parseAndStripFrontmatter(md);
        expect(group).toBe('blog');
        expect(cleanedContent).not.toContain('```yaml');
        expect(cleanedContent).not.toContain('group:');
        expect(cleanedContent).toContain('# 标题');
        expect(cleanedContent).toContain('正文。');
    });

    test('parseAndStripFrontmatter — slug + ignore + group 三字段同时剥离', () => {
        const md = `# 标题

\`\`\`yaml
slug: my-page
ignore: Y
group: docs
\`\`\`

正文。`;
        const { slug, ignore, group, cleanedContent } = parseAndStripFrontmatter(md);
        expect(slug).toBe('my-page');
        expect(ignore).toBe(true);
        expect(group).toBe('docs');
        expect(cleanedContent).not.toContain('```yaml');
    });

    test('parseFrontmatterMeta — 无 YAML 块时 group 应为 default', () => {
        expect(parseFrontmatterMeta('# 纯 Markdown\n\n正文').group).toBe('default');
    });
});

test('xmlToReadable converts list items', () => {
    const xml = '<list_item>Item 1</list_item><list_item>Item 2</list_item>';
    const result = xmlToReadable(xml);
    expect(result).toContain('- Item 1');
    expect(result).toContain('- Item 2');
});

test('xmlToReadable converts links', () => {
    const xml = '<a href="https://example.com">click here</a>';
    const result = xmlToReadable(xml);
    expect(result).toBe('[click here](https://example.com)');
});

test('xmlToReadable converts divider', () => {
    const xml = '<divider/>';
    const result = xmlToReadable(xml);
    expect(result).toContain('---');
});

test('xmlToReadable handles code blocks', () => {
    const xml = '<code_block>console.log("hi")</code_block>';
    const result = xmlToReadable(xml);
    expect(result).toContain('```');
    expect(result).toContain('console.log("hi")');
});

test('xmlToReadable collapses excessive newlines', () => {
    const xml = '<paragraph>a</paragraph><paragraph>b</paragraph>';
    const result = xmlToReadable(xml);
    expect(result).not.toMatch(/\n{3,}/);
});

test('xmlToReadable handles empty input', () => {
    expect(xmlToReadable('')).toBe('');
});

// ============ convertDocumentTitleToHeading ============

describe('convertDocumentTitleToHeading', () => {
    test('顶部 <title> 行改写为一级标题（带 emoji 标题）', () => {
        const input = '<title>⚠️ MgrApp</title>\n\n::: warning ⚠️\n前后端分离\n:::';
        expect(convertDocumentTitleToHeading(input)).toBe('# ⚠️ MgrApp\n\n::: warning ⚠️\n前后端分离\n:::');
    });

    test('标题前有空白也能改写', () => {
        const input = '  \n<title>Foo</title>\n\n正文';
        expect(convertDocumentTitleToHeading(input)).toBe('# Foo\n\n正文');
    });

    test('无 <title> 行时原样返回', () => {
        const input = '# 标题\n\n正文';
        expect(convertDocumentTitleToHeading(input)).toBe(input);
    });

    test('正文里的 <title>（HTML 代码块示例）不应被改写', () => {
        const input = '# favicon\n\n```html\n<head><title>Empty Icon Test</title></head>\n```\n';
        expect(convertDocumentTitleToHeading(input)).toBe(input);
    });
});

// ============ parseHtmlAttrs ============

describe('parseHtmlAttrs', () => {
    test('解析标准 cite 属性', () => {
        const attrs = parseHtmlAttrs('doc-id="L2GBwZnBgiaHNJkOHR2c81Nynif" file-type="wiki" title="Flutter 安装和环境设置" type="doc"');
        expect(attrs).toEqual({
            'doc-id': 'L2GBwZnBgiaHNJkOHR2c81Nynif',
            'file-type': 'wiki',
            title: 'Flutter 安装和环境设置',
            type: 'doc'
        });
    });

    test('解析单个属性', () => {
        const attrs = parseHtmlAttrs('key="value"');
        expect(attrs).toEqual({ key: 'value' });
    });

    test('属性值为空字符串', () => {
        const attrs = parseHtmlAttrs('name=""');
        expect(attrs).toEqual({ name: '' });
    });

    test('多个属性含空格', () => {
        const attrs = parseHtmlAttrs('  a="1"  b="2"  ');
        expect(attrs).toEqual({ a: '1', b: '2' });
    });

    test('空字符串返回空对象', () => {
        expect(parseHtmlAttrs('')).toEqual({});
    });

    test('无属性字符串返回空对象', () => {
        expect(parseHtmlAttrs('no-attrs-here')).toEqual({});
    });
});

// ============ resolveCiteBlocks ============

describe('resolveCiteBlocks', () => {
    const mockResolveLink = (map: Record<string, string | null>) =>
        (docId: string): ResolveLinkResult => {
            const path = map[docId] ?? null;
            return path ? { path } : { reason: 'doc-id 未在索引中找到，请先运行 sync' };
        };

    test('type=doc file-type=wiki 命中应替换为 Markdown 链接', () => {
        const content = '正文 <cite doc-id="abc123" file-type="wiki" title="测试文档" type="doc"></cite> 结尾';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({ abc123: 'path/to/doc' })
        );
        expect(result).toBe('正文 [测试文档](path/to/doc.md) 结尾');
        expect(warnings).toEqual([]);
    });

    test('未命中应保留原始标签并产生警告', () => {
        const content = '<cite doc-id="not-found" file-type="wiki" title="缺失文档" type="doc"></cite>';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({})
        );
        expect(result).toBe(content);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('not-found');
        expect(warnings[0]!).toContain('缺失文档');
    });

    test('multiple cite blocks 多个引用应全部处理', () => {
        const content = 'A <cite doc-id="id1" file-type="wiki" title="文档1" type="doc"></cite> B <cite doc-id="id2" file-type="wiki" title="文档2" type="doc"></cite> C';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({ id1: 'path/1', id2: 'path/2' })
        );
        expect(result).toBe('A [文档1](path/1.md) B [文档2](path/2.md) C');
        expect(warnings).toEqual([]);
    });

    test('type 非 doc 应保留原始标签并产生警告', () => {
        const content = '<cite doc-id="x" file-type="wiki" title="T" type="file"></cite>';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({ x: 'path' })
        );
        expect(result).toBe(content);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('type="file"');
        expect(warnings[0]!).toContain('仅处理 type="doc"');
    });

    test('file-type 非 wiki 应保留原始标签并产生警告', () => {
        const content = '<cite doc-id="x" file-type="docx" title="T" type="doc"></cite>';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({ x: 'path' })
        );
        expect(result).toBe(content);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('file-type="docx"');
        expect(warnings[0]!).toContain('仅处理 file-type="wiki"');
    });

    test('type 缺失应保留原始标签并产生警告', () => {
        const content = '<cite doc-id="x" file-type="wiki" title="T"></cite>';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({ x: 'path' })
        );
        expect(result).toBe(content);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('type=""');
    });

    test('缺少 doc-id 属性应保留原始标签并警告', () => {
        const content = '<cite file-type="wiki" title="无ID" type="doc"></cite>';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({})
        );
        expect(result).toBe(content);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('缺少 doc-id');
    });

    test('无 title 属性默认使用 Untitled', () => {
        const content = '<cite doc-id="abc" file-type="wiki" type="doc"></cite>';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({ abc: 'some/path' })
        );
        expect(result).toBe('[Untitled](some/path.md)');
        expect(warnings).toEqual([]);
    });

    test('内容中无 cite 标签应原样返回', () => {
        const content = '# 标题\n\n纯 Markdown 正文，无任何引用。';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({})
        );
        expect(result).toBe(content);
        expect(warnings).toEqual([]);
    });

    test('部分命中部分未命中应混合处理', () => {
        const content = '<cite doc-id="good" file-type="wiki" title="好" type="doc"></cite> <cite doc-id="bad" file-type="wiki" title="坏" type="doc"></cite>';
        const { result, warnings } = resolveCiteBlocks(
            content,
            mockResolveLink({ good: 'found' })
        );
        expect(result).toContain('[好](found.md)');
        expect(result).toContain('<cite doc-id="bad"');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('bad');
    });

    test('human_path 为 null 应返回 reason 使 cite 保留', () => {
        // resolveLink 在 human_path 为 null 时返回 { reason }
        const resolveLink = (docId: string): ResolveLinkResult => {
            if (docId === 'null-path') return { reason: 'human_path is null' };
            return { path: 'some/path' };
        };
        const content = '<cite doc-id="null-path" file-type="wiki" title="空路径" type="doc"></cite>';
        const { result, warnings } = resolveCiteBlocks(content, resolveLink);
        expect(result).toBe(content);
        expect(warnings).toHaveLength(1);
    });
});

// ============ resolveSubPageListBlocks ============

describe('resolveSubPageListBlocks', () => {
    const mockResolveLink = (map: Record<string, string | null>) =>
        (docId: string): ResolveLinkResult => {
            const path = map[docId] ?? null;
            return path ? { path } : { reason: 'doc-id 未在索引中找到，请先运行 sync' };
        };

    test('多个 sub-page 全部命中应输出完整 Markdown 无序列表', () => {
        const content = '<sub-page-list space-id="s1" wiki-token="w1">'
            + '<sub-page doc-id="a" file-type="docx" title="文档A"/>'
            + '<sub-page doc-id="b" file-type="docx" title="文档B"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ a: 'path/a', b: 'path/b' })
        );
        expect(result).toBe('- [文档A](path/a.md)\n- [文档B](path/b.md)');
        expect(warnings).toEqual([]);
    });

    test('全部未命中应输出空字符串并逐项产生 warning', () => {
        const content = '<sub-page-list space-id="s1">'
            + '<sub-page doc-id="x1" file-type="docx" title="缺失1"/>'
            + '<sub-page doc-id="x2" file-type="docx" title="缺失2"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({})
        );
        expect(result).toBe('');
        expect(warnings).toHaveLength(2);
        expect(warnings[0]!).toContain('x1');
        expect(warnings[0]!).toContain('缺失1');
        expect(warnings[1]!).toContain('x2');
    });

    test('部分命中应混合输出链接和原始标签', () => {
        const content = '<sub-page-list>'
            + '<sub-page doc-id="hit" file-type="docx" title="命中"/>'
            + '<sub-page doc-id="miss" file-type="docx" title="未命中"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ hit: 'path/hit' })
        );
        expect(result).toContain('- [命中](path/hit.md)');
        expect(result).toContain('<sub-page doc-id="miss"');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('miss');
    });

    test('缺 doc-id 属性应保留原文并产生 warning', () => {
        const content = '<sub-page-list>'
            + '<sub-page file-type="docx" title="无ID"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({})
        );
        expect(result).toContain('<sub-page file-type="docx" title="无ID"/>');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!).toContain('缺少 doc-id');
    });

    test('缺 title 属性命中时应使用 Untitled', () => {
        const content = '<sub-page-list>'
            + '<sub-page doc-id="a" file-type="docx"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ a: 'p/a' })
        );
        expect(result).toBe('- [Untitled](p/a.md)');
        expect(warnings).toEqual([]);
    });

    test('空 sub-page-list 块应输出空字符串', () => {
        const content = '前置文本 <sub-page-list></sub-page-list> 后置文本';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({})
        );
        expect(result).toBe('前置文本  后置文本');
        expect(warnings).toEqual([]);
    });

    test('space-id 与 wiki-token 属性不影响解析结果', () => {
        const content = '<sub-page-list space-id="S123" wiki-token="W456">'
            + '<sub-page doc-id="a" file-type="docx" title="A"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ a: 'p/a' })
        );
        expect(result).toBe('- [A](p/a.md)');
        expect(warnings).toEqual([]);
    });

    test('file-type=docx 命中应附加 .md 后缀', () => {
        const content = '<sub-page-list>'
            + '<sub-page doc-id="d1" file-type="docx" title="Doc"/>'
            + '</sub-page-list>';
        const { result } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ d1: 'human/path' })
        );
        expect(result).toBe('- [Doc](human/path.md)');
    });

    test('file-type=sheet 命中应直出 upload_url 不加 .md', () => {
        const content = '<sub-page-list>'
            + '<sub-page doc-id="s1" file-type="sheet" title="表格"/>'
            + '</sub-page-list>';
        const { result } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ s1: 'https://oss.example.com/abc.xlsx' })
        );
        expect(result).toBe('- [表格](https://oss.example.com/abc.xlsx)');
    });

    test('file-type=file 命中应直出 upload_url 不加 .md', () => {
        const content = '<sub-page-list>'
            + '<sub-page doc-id="f1" file-type="file" title="PDF"/>'
            + '</sub-page-list>';
        const { result } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ f1: 'https://oss.example.com/abc.pdf' })
        );
        expect(result).toBe('- [PDF](https://oss.example.com/abc.pdf)');
    });

    test('file-type=bitable/mindnote 等不支持类型应保留原文并产生警告', () => {
        const content = '<sub-page-list>'
            + '<sub-page doc-id="b1" file-type="bitable" title="多维表"/>'
            + '<sub-page doc-id="m1" file-type="mindnote" title="脑图"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ b1: 'p', m1: 'p' })
        );
        expect(result).toContain('<sub-page doc-id="b1"');
        expect(result).toContain('<sub-page doc-id="m1"');
        expect(warnings).toHaveLength(2);
        expect(warnings[0]!).toContain('file-type="bitable"');
        expect(warnings[0]!).toContain('仅处理 docx/sheet/file');
        expect(warnings[1]!).toContain('file-type="mindnote"');
    });

    test('多个 sub-page-list 块应独立处理', () => {
        const content = '<sub-page-list>'
            + '<sub-page doc-id="a" file-type="docx" title="A"/>'
            + '</sub-page-list>'
            + '中间文本'
            + '<sub-page-list>'
            + '<sub-page doc-id="b" file-type="docx" title="B"/>'
            + '</sub-page-list>';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({ a: 'p/a', b: 'p/b' })
        );
        expect(result).toContain('- [A](p/a.md)');
        expect(result).toContain('- [B](p/b.md)');
        expect(result).toContain('中间文本');
        expect(warnings).toEqual([]);
    });

    test('内容中无 sub-page-list 标签应原样返回', () => {
        const content = '# 标题\n\n纯 Markdown 正文，无任何 sub-page 引用。';
        const { result, warnings } = resolveSubPageListBlocks(
            content,
            mockResolveLink({})
        );
        expect(result).toBe(content);
        expect(warnings).toEqual([]);
    });
});
