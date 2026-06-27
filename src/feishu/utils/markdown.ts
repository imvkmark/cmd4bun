// Markdown 解析工具：frontmatter 元数据提取、标题/正文预览、HTML 属性解析

const YAML_BLOCK_RE = /```(?:ya?ml|YAML|YML)\s*\n([\s\S]*?)```/;

/** group 字段校验规则:仅允许小写字母、数字、连字符 */
const GROUP_RE = /^[a-z0-9-]+$/;

/**
 * 校验并归一化 group 值。
 * 通过 [a-z0-9-]+ 校验返回原值,否则(空/非法字符)返回 'default'。
 * 用于 frontmatter 解析器对 group 字段做降级兜底。
 */
function normalizeGroup(raw: string | null | undefined): string {
    const trimmed = (raw ?? '').trim();
    return trimmed && GROUP_RE.test(trimmed) ? trimmed : 'default';
}

/**
 * 从 Markdown 内容中解析第一个 YAML code block 的 slug、ignore 与 group 字段。
 *
 * 匹配规则：
 * 1. 找到第一个 ```yaml 或 ```yml 代码块
 * 2. 在块内匹配 `slug:`、`ignore:` 与 `group:` 行
 * 3. 提取冒号后的值并清理空白
 *
 * 返回 { slug, ignore, group }：
 * - slug: trim 后的字符串，找不到则返回 null
 * - ignore: 仅当 `ignore:` 值 trim 后严格等于 `Y`（区分大小写）时为 true,
 *   其他情况(`y`/`yes`/`true`/`N`/空/缺失)一律为 false
 * - group: 通过 `[a-z0-9-]+` 校验的字符串,否则或缺失返回 `'default'`
 */
export function parseFrontmatterMeta(content: string): { slug: string | null; ignore: boolean; group: string } {
    const blockMatch = YAML_BLOCK_RE.exec(content);
    if (!blockMatch?.[1]) return { slug: null, ignore: false, group: 'default' };

    const yamlBody = blockMatch[1];

    // slug: 或 slug : 行,值可以包含空格、字母数字、/、-、_、.
    // 使用 [^\S\n](空格和 tab,不含换行)避免跨行匹配
    const slugRe = /^slug[^\S\n]*:[^\S\n]*(.+)$/m;
    const slugMatch = slugRe.exec(yamlBody);
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- trim 空字符串归一为 null 是预期语义
    const slug = slugMatch?.[1]?.trim() || null;

    // ignore: 严格匹配字面量 Y(区分大小写)
    const ignoreRe = /^ignore[^\S\n]*:[^\S\n]*(.*)$/m;
    const ignoreMatch = ignoreRe.exec(yamlBody);
    const ignore = (ignoreMatch?.[1]?.trim() ?? '') === 'Y';

    // group: 仅允许小写字母、数字、连字符;非法值降级为 'default'
    const groupRe = /^group[^\S\n]*:[^\S\n]*(.*)$/m;
    const groupMatch = groupRe.exec(yamlBody);
    const group = normalizeGroup(groupMatch?.[1]);

    return { slug, ignore, group };
}

/**
 * 从 Markdown 内容中解析第一个 YAML code block 的 slug、ignore 与 group 字段,同时移除该代码块。
 *
 * 与 parseFrontmatterMeta 的区别：在提取元数据后,将包含 slug/ignore/group 的 YAML 代码块
 * 从内容中完全移除。YAML 代码块是内部解析 human_path/ignore/group 的机制,
 * 不应出现在最终下载的 .md 文件中。
 *
 * 移除规则：
 * 1. 找到第一个 ```yaml 或 ```yml 代码块
 * 2. 若块内匹配到 `slug:`、`ignore:` 或 `group:` 字段之一(不论值是什么),移除整个代码块
 * 3. 若都不匹配,保留内容不变(避免误删无关 YAML 块)
 *
 * 返回 { slug, ignore, group, cleanedContent }。
 */
export function parseAndStripFrontmatter(content: string): { slug: string | null; ignore: boolean; group: string; cleanedContent: string } {
    const blockMatch = YAML_BLOCK_RE.exec(content);
    if (!blockMatch?.[1]) return { slug: null, ignore: false, group: 'default', cleanedContent: content };

    const yamlBody = blockMatch[1];

    // slug: 或 slug : 行,值可以包含空格、字母数字、/、-、_、.
    // 使用 [^\S\n](空格和 tab,不含换行)避免跨行匹配
    const slugRe = /^slug[^\S\n]*:[^\S\n]*(.+)$/m;
    const slugMatch = slugRe.exec(yamlBody);
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- trim 空字符串归一为 null 是预期语义
    const slug = slugMatch?.[1]?.trim() || null;

    // ignore: 严格匹配字面量 Y(trim 后),其他值(含空/缺失)一律为 false
    const ignoreRe = /^ignore[^\S\n]*:[^\S\n]*(.*)$/m;
    const ignoreMatch = ignoreRe.exec(yamlBody);
    const ignore = (ignoreMatch?.[1]?.trim() ?? '') === 'Y';

    // group: 仅允许小写字母、数字、连字符;非法值降级为 'default'
    const groupRe = /^group[^\S\n]*:[^\S\n]*(.*)$/m;
    const groupMatch = groupRe.exec(yamlBody);
    const group = normalizeGroup(groupMatch?.[1]);

    // 仅当 YAML 块含 slug、ignore 或 group 字段之一时移除代码块：
    // 即使用户写 `ignore: N` 取消忽略,也要剥离 YAML 块以保证覆盖写语义
    if (slug === null && !ignoreMatch && !groupMatch) {
        return { slug: null, ignore: false, group: 'default', cleanedContent: content };
    }

    const cleanedContent = content.slice(0, blockMatch.index) + content.slice(blockMatch.index + blockMatch[0].length);
    // 清理可能产生的多余空行(连续 3 个以上换行 → 2 个)
    const normalized = cleanedContent.replace(/\n{3,}/g, '\n\n');

    return { slug, ignore, group, cleanedContent: normalized };
}

/**
 * 从 Markdown 文本中提取所有 # 标题的正文（不含 # 前缀和尾随锚点链接）。
 * 返回去重后的标题数组。
 */
export function extractHeadings(markdown: string): string[] {
    const lines = markdown.split('\n');
    const headings: string[] = [];
    for (const line of lines) {
        const m = /^(#{1,6})\s+(.+)/.exec(line);
        if (m) {
            let text = m[2]!.trim();
            // 去除尾随的锚点链接如 {#some-id}
            text = text.replace(/\s*\{#[^}]+\}\s*$/, '').trim();
            if (text) headings.push(text);
        }
    }
    return [...new Set(headings)];
}

/**
 * 从 Markdown 正文中提取纯文本预览。
 * 跳过 YAML frontmatter（---...---）、标题行（#）、空行，
 * 拼接前 maxLen 个中文字符作为摘要。
 */
export function extractBodyPreview(markdown: string, maxLen: number): string {
    // 跳过 YAML frontmatter
    let body = markdown;
    if (body.startsWith('---')) {
        const end = body.indexOf('---', 3);
        if (end !== -1) {
            body = body.slice(end + 3);
        }
    }

    const lines = body.split('\n');
    const parts: string[] = [];
    let count = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        // 跳过标题行和空行
        if (!trimmed || trimmed.startsWith('#')) continue;
        // 跳过纯 URL 行、图片行、分割线等非正文行
        if (/^!?\[.*?\]\(.*?\)$/.test(trimmed)) continue;
        if (/^---$/.test(trimmed)) continue;
        if (trimmed.startsWith('```')) continue;

        // eslint-disable-next-line no-useless-escape
        const stripped = trimmed.replace(/[\[\]()*_~`>|]/g, '').trim();
        if (!stripped) continue;

        parts.push(stripped);
        count += stripped.length;
        if (count >= maxLen) break;
    }

    const joined = parts.join('').slice(0, maxLen);
    return joined.replace(/\s+/g, ' ').trim();
}

/**
 * 把飞书 docs_ai API 返回内容顶部的 `<title>...</title>` 行改写为一级 Markdown 标题。
 *
 * 该 API 转换文档时会将文档标题作为首行嵌入 markdown，格式为
 * `<title>{文档标题}</title>`，与正文以空行分隔。这个标签是 API 产物，
 * 不是文档内容；若原样写入 .md 会显示成 `<title>⚠️ MgrApp</title>` 字面文本。
 *
 * 这里把它改写成 `# {文档标题}`，与正文其余部分保持一致的 Markdown 结构，
 * 避免依赖写入端的模板/注入逻辑（documentTitle 不一定注入到了正文）。
 *
 * 只改写"开头"的标题行（容许前导空白），不动正文里的 `<title>` 标签——
 * 后者通常是 HTML 代码块示例（如 favicon 文档里 `<head><title>...</title></head>`）。
 *
 * 标题内容用 `[^<]*` 限定不含 `<`，避免贪婪匹配跨过真实标签边界。
 */
export function convertDocumentTitleToHeading(content: string): string {
    return content.replace(
        /^(\s*)<title>([^<]*)<\/title>\s*\n?/,
        (_match, _leadingWs: string, title: string) => `# ${title}\n\n`
    );
}

/**
 * 解析 HTML 标签属性字符串为键值对。
 * 例：'doc-id="abc" title="Hello World"' → { 'doc-id': 'abc', title: 'Hello World' }
 */
export function parseHtmlAttrs(attrsStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /(\S+?)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrsStr)) !== null) {
        attrs[m[1]!] = m[2]!;
    }
    return attrs;
}
