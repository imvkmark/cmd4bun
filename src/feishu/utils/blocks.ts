// 飞书 wiki 块转换：<cite> 引用块 → Markdown 链接，<callout> 块 → VitePress ::: container，
// <sub-page-list> 块 → Markdown 无序列表

import { parseHtmlAttrs } from './markdown';

/**
 * resolveLink 回调的返回值(三态):
 * - path: 相对路径(同 group 内的 human_path),调用方负责追加 .md
 * - url:  绝对 URL(跨 group aimUrl + slug + .html,或 sheet/file 的 upload_url),调用方原样输出
 * - reason: 解析失败,调用方保留原文 + warning
 */
export type ResolveLinkResult = { path: string } | { url: string } | { reason: string };

/**
 * 解析内容中的 <cite> 引用块，将 Wiki 文档引用替换为 Markdown 链接。
 *
 * 匹配规则：
 * - <cite type="doc" file-type="wiki" doc-id="..." title="..."></cite>
 * - 通过 resolveLink(docId) 回调获取 human_path
 * - 命中返回 [title](human_path.md)，未命中保留原始标签
 *
 * 降级路径（均保留原文 + warning）：
 * - type 不是 'doc' 或 file-type 不是 'wiki' → 当前不解析，提示后续按需扩展
 * - 缺 doc-id 属性 → 提示作者补齐
 * - resolveLink 返回 { reason }（节点缺失 / human_path 未就绪） → 提示检查索引或重跑 sync
 */
export function resolveCiteBlocks(
    content: string,
    resolveLink: (docId: string) => ResolveLinkResult
): { result: string; warnings: string[] } {
    const warnings: string[] = [];

    const result = content.replace(
        /<cite\s+([^>]*?)>\s*<\/cite>/g,
        (match, attrsStr: string) => {
            const attrs = parseHtmlAttrs(attrsStr);

            if (attrs.type !== 'doc') {
                warnings.push(
                    `<cite> 不支持的 type="${attrs.type ?? ''}" (仅处理 type="doc"): ${match}`
                );
                return match;
            }

            if (attrs['file-type'] !== 'wiki') {
                warnings.push(
                    `<cite> 不支持的 file-type="${attrs['file-type'] ?? ''}" (仅处理 file-type="wiki"): ${match}`
                );
                return match;
            }

            const docId = attrs['doc-id'];
            const title = attrs.title ?? 'Untitled';

            if (!docId) {
                warnings.push(`<cite> 缺少 doc-id 属性: ${match}`);
                return match;
            }

            const linkResult = resolveLink(docId);
            if ('reason' in linkResult) {
                warnings.push(`<cite> ${linkResult.reason} (doc-id=${docId}, title="${title}")`);
                return match;
            }

            // url 分支(绝对 URL,如跨 group aimUrl 或 sheet/file upload_url)原样输出,不加 .md
            if ('url' in linkResult) {
                return `[${title}](${linkResult.url})`;
            }

            // path 分支(相对路径)追加 .md
            return `[${title}](${linkResult.path}.md)`;
        }
    );

    return { result, warnings };
}

/**
 * 将飞书 <callout> 块转换为 VitePress ::: container 语法，并对内部链接做格式转换。
 *
 * 转换目标(因 VitePress `:::` 容器内 HTML 块不再渲染 Markdown 语法):
 * - `<a href="X">text</a>` 飞书原生 HTML 锚点 → 保持 `<a>` 标签形态,只换 href
 * - `[text](url)` Markdown 链接 → 走 resolveLink 转换(同 `<a>` 四分支决策)
 *
 * emoji → container 类型映射：
 *   📆 → info, 💡 → tip, ✅ → tip
 *   ⚠️ → warning
 *   ❌ → danger, 🚫 → danger, 🔴 → danger
 *
 * 外壳替换：
 * - <callout emoji="📆"> → ::: info 📆
 * - </callout> → :::
 *
 * 内部链接 href 替换(由 download-flow 传入的 resolveLink 闭包统一处理):
 * - http(s):// 完整 URL → 原样保留(外部链接)
 * - 路径形式(/path/to/doc.md 或 .md 结尾)→ calloutResolveLink 用当前 group aimUrl 拼绝对 URL
 * - 飞书 token → 走 resolveLink 四分支(DB lookup + 同组 path / 跨组 url / 缺失 reason)
 *
 * 关键语义：保持 `<a>` 标签形态不转 Markdown(VitePress `:::` 容器内允许 raw HTML,
 * `<a href="...">` 用 URL 解析语义与 Markdown `[](url)` 等效,但能保留 `class` /
 * `target` 等其他属性)。
 */
export function resolveCalloutBlocks(
    content: string,
    resolveLink: (docId: string) => ResolveLinkResult
): { result: string; warnings: string[] } {
    // emoji → VitePress container 类型映射
    const emojiTypeMap: Record<string, string> = {
        '📆': 'info',
        '💡': 'tip',
        '✅': 'tip',
        '⚠️': 'warning',
        '❌': 'danger',
        '🚫': 'danger',
        '🔴': 'danger'
    };

    const warnings: string[] = [];

    // 块级匹配 <callout emoji="X">...</callout>,块内处理链接替换
    const result = content.replace(
        /<callout\s+emoji="([^"]*)">([\s\S]*?)<\/callout>/g,
        (_match, emoji: string, inner: string) => {
            const type = emojiTypeMap[emoji] ?? 'info';

            // 第一步:处理飞书原生 HTML 锚点 <a href="...">text</a>
            // (走 resolveLink 四分支,保持 <a> 标签形态只换 href)
            const htmlLinkProcessed = inner.replace(
                /<a\s+([^>]*?)href=(["'])([^"']*)\2([^>]*)>([\s\S]*?)<\/a>/gi,
                (aMatch, preAttrs: string, quote: string, href: string, postAttrs: string, text: string) => {
                    // 完整 URL(http(s)://)→ 原样保留,不调 resolveLink
                    if (/^https?:\/\//i.test(href)) {
                        return aMatch;
                    }
                    // 飞书 token → 走 resolveLink 四分支
                    const linkResult = resolveLink(href);
                    if ('reason' in linkResult) {
                        warnings.push(`<callout> <a> ${linkResult.reason} (href=${href})`);
                        return aMatch;
                    }
                    // path 分支(同组):追加 .md
                    // url 分支(跨组绝对 URL):原样输出
                    const newHref = 'path' in linkResult ? `${linkResult.path}.md` : linkResult.url;
                    return `<a ${preAttrs}href=${quote}${newHref}${quote}${postAttrs}>${text}</a>`;
                }
            );

            // 第二步:处理 Markdown 链接 [text](url) → 走 resolveLink 转换
            // 飞书 callout 内常含 <p><ul><li>[text](/path/to/doc.md)</li></ul></p> 这种
            // HTML 块包 Markdown 链接的形态,VitePress 容器内 HTML 块不再渲染 Markdown,
            // 必须把 [text](url) 转成 <a> 标签。
            // URL 走 resolveLink 决策(与 <a> 共用):
            // - http(s):// 完整 URL → 原样保留
            // - 路径形式(/path/to/doc.md 或 .md 结尾)→ 当前 group aimUrl 拼绝对 URL
            // - 飞书 token → DB lookup + 四分支
            // 顺序:在 HTML <a> 处理之后,避免重复处理已转换的 <a> 标签。
            const processedInner = htmlLinkProcessed.replace(
                /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
                (_m, text: string, url: string) => {
                    // http(s):// 完整 URL → 原样保留,不调 resolveLink
                    if (/^https?:\/\//i.test(url)) {
                        return `<a href="${url}">${text}</a>`;
                    }
                    // 其他形式 → 走 resolveLink(路径形式由 calloutResolveLink 包装识别)
                    const linkResult = resolveLink(url);
                    if ('reason' in linkResult) {
                        warnings.push(`<callout> <md-link> ${linkResult.reason} (url=${url})`);
                        return _m;
                    }
                    // path 分支(同组):追加 .md
                    // url 分支(跨组/路径绝对 URL):原样输出
                    const href = 'path' in linkResult ? `${linkResult.path}.md` : linkResult.url;
                    return `<a href="${href}">${text}</a>`;
                }
            );

            return `::: ${type} ${emoji}\n${processedInner}\n:::`;
        }
    );

    return { result, warnings };
}

/**
 * 解析内容中的 <sub-page-list> 块，将飞书内嵌的子文档索引折叠为 Markdown 无序列表。
 *
 * 匹配规则：
 * - <sub-page-list space-id="..." wiki-token="...">...</sub-page-list> 块级匹配
 * - 块内每个 <sub-page doc-id="..." file-type="..." title="..."/> 子项
 * - 通过 resolveLink(docId) 回调获取 human_path 或 upload_url
 *
 * 子项处理：
 * - file-type=docx 命中 → `- [title](human_path.md)`
 * - file-type=sheet|file 命中 → `- [title](upload_url)`（直出，不加 .md）
 * - 缺 doc-id → 保留原文 + warning
 * - file-type 非 docx/sheet/file → 保留原文 + warning（提示作者检查是否为支持类型）
 * - resolveLink 返回 { reason } → 保留原文 + warning
 *
 * 块级处理：
 * - 至少 1 个子项产出（命中或降级保留）→ 输出 join('\n') 的列表
 * - 全部子项未命中 → 整块输出空字符串（外壳丢弃）
 *
 * doc-id 语义：sub-page 的 doc-id 是飞书文档对象的全局 ID（对应 nodes.obj_token），
 * 不是 wiki 树节点 ID（node_token）。调用方需在 resolveLink 回调中按 obj_token 查库。
 * space-id / wiki-token 不参与解析，仅作信息保留。
 */
export function resolveSubPageListBlocks(
    content: string,
    resolveLink: (docId: string) => ResolveLinkResult
): { result: string; warnings: string[] } {
    const warnings: string[] = [];

    const result = content.replace(
        /<sub-page-list\b[^>]*>([\s\S]*?)<\/sub-page-list>/g,
        (_block, inner: string) => {
            const lines: string[] = [];
            // 计数"有效子项":命中 / 格式问题(保留原文);不算 resolveLink 失败的纯未命中
            let meaningfulCount = 0;
            inner.replace(
                /<sub-page\b([^>]*?)\/>/g,
                (itemMatch, attrsStr: string) => {
                    const attrs = parseHtmlAttrs(attrsStr);
                    const docId = attrs['doc-id'];
                    const title = attrs.title ?? 'Untitled';
                    const fileType = attrs['file-type'] ?? 'docx';

                    if (!docId) {
                        warnings.push(`<sub-page> 缺少 doc-id 属性: ${itemMatch}`);
                        lines.push(`- ${itemMatch}`);
                        meaningfulCount++;
                        return itemMatch;
                    }

                    if (fileType !== 'docx' && fileType !== 'sheet' && fileType !== 'file') {
                        warnings.push(
                            `<sub-page> 不支持的 file-type="${fileType}" (仅处理 docx/sheet/file): ${itemMatch}`
                        );
                        lines.push(`- ${itemMatch}`);
                        meaningfulCount++;
                        return itemMatch;
                    }

                    const link = resolveLink(docId);
                    if ('reason' in link) {
                        warnings.push(`<sub-page> ${link.reason} (doc-id=${docId}, title="${title}")`);
                        lines.push(`- ${itemMatch}`);
                        return itemMatch;
                    }

                    // url 分支(绝对 URL,如跨 group aimUrl 或 sheet/file upload_url)原样输出
                    if ('url' in link) {
                        lines.push(`- [${title}](${link.url})`);
                    } else {
                        // path 分支:docx 追加 .md;sheet/file 的 upload_url 已自带后缀,直出
                        const path = fileType === 'docx' ? `${link.path}.md` : link.path;
                        lines.push(`- [${title}](${path})`);
                    }
                    meaningfulCount++;
                    return itemMatch;
                }
            );

            // 全部子项都是"resolveLink 失败"(格式正确但节点缺失) → 丢弃整块
            // 至少 1 项有有效内容(命中 / 缺 doc-id 保留 / 不支持类型保留) → 输出列表
            return meaningfulCount > 0 ? lines.join('\n') : '';
        }
    );

    return { result, warnings };
}
