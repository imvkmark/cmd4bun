// 飞书 Wiki API 调用：知识库扫描、节点遍历、文档内容获取

import { execJSON, execJSONAsync, xmlToReadable, createRateLimiter, writeProgress, sanitize, extractHeadings, extractBodyPreview, FeishuAPIError } from './utils';
import { loadConfig } from '../config';
import { chat } from '../shared/deepseek-client';
import { C } from '../shared/colors';

// ============ Types ============

interface FeishuSpace {
    space_id: string;
    name: string;
    description?: string;
    space_type?: string;
}

export interface WikiNode {
    node_token: string;
    obj_token: string;
    obj_type: string;
    title: string;
    parent_node_token: string;
    has_child: boolean;
    space_id: string;
    node_create_time?: string;
    obj_edit_time?: string;
    obj_create_time?: string;
}

// ============ 可生成本地 Markdown 文件的类型白名单 ============
// 表示"会写本地 .md 文件并注入 frontmatter"的类型（仅 doc/docx）。
//
// 三处引用：
// 1. `sync-flow.ts:formatObjTypeCounts` 与 `isDownloadable` —— 区分"文档"与"其他类型"用于日志分组。
// 2. `download-flow.ts:downNode` —— 非 doc/docx/file/sheet 节点抛错，作为单节点下载入口的类型快速失败校验。
// 3. `db.ts:getDownloadQueue` 的 SQL 不再直接使用此常量，而是独立写为
//    `obj_type IN ('doc', 'docx', 'file', 'sheet')`，因为 downNode 实际还处理 file/sheet
//    (file/sheet 不生成本地 Markdown，但走 OSS 通道写 upload_url，属于"可下载"但不属于"可生成本地 Markdown")。

export const FETCHABLE_TYPES = new Set(['doc', 'docx']);

// ============ Wiki API ============

export function fetchSpaces(): FeishuSpace[] {
    const res = execJSON<{ data?: { items?: FeishuSpace[]; spaces?: FeishuSpace[] } }>([
        'wiki', '+space-list', '--page-all', '--page-limit', '0', '--json', '--as', 'user'
    ]);
    return res?.data?.spaces ?? res?.data?.items ?? [];
}

export function fetchChildNodes(spaceId: string, parentToken?: string): WikiNode[] {
    const args = [
        'wiki', '+node-list',
        '--space-id', spaceId,
        '--page-all', '--page-limit', '0',
        '--json', '--as', 'user'
    ];
    if (parentToken) {
        args.push('--parent-node-token', parentToken);
    }

    /** -------
    {
      has_child: true,
      node_token: "AHxTw6NUEiW9sbkUBrncDdrbnNd",
      node_type: "origin",
      obj_token: "WEEKd4Ps0omrvjx9s0PcsuSSnOd",
      obj_type: "docx",
      parent_node_token: "PJbuwxIxGiXmW9k2NQ1cacsWnox",
      space_id: "7562969962420109313",
      title: "运维 WIP",
    }
    ----------- */
    const res = execJSON<{ data?: { items?: WikiNode[]; nodes?: WikiNode[] } }>(args);
    return res?.data?.nodes ?? res?.data?.items ?? [];
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export async function* fetchAllNodes(spaceId: string, spaceName: string, qps = 1.6): AsyncGenerator<WikiNode, Map<string, WikiNode>> {
    const allNodes = new Map<string, WikiNode>();
    const queue: (string | undefined)[] = [undefined];
    const limiter = createRateLimiter(qps);
    let si = 0;

    while (queue.length > 0) {
        const parent = queue.shift();
        const children = fetchChildNodes(spaceId, parent);

        for (const node of children) {
            allNodes.set(node.node_token, node);
            if (node.has_child) queue.push(node.node_token);
            yield node;
        }

        writeProgress(`    ${C.cyan}${SPINNER[si++ % SPINNER.length]}${C.reset} ${spaceName} 扫描节点... ${allNodes.size} 个`);

        if (queue.length > 0) await limiter();
    }

    return allNodes;
}

// ============ 路径构建 ============

export function buildPath(node: WikiNode, nodeMap: Map<string, WikiNode>): string {
    const parts: string[] = [];
    let cur: WikiNode | undefined = node;

    while (cur) {
        parts.unshift(sanitize(cur.title));
        const p: string = cur.parent_node_token;
        cur = p ? nodeMap.get(p) : undefined;
    }

    const fileName = parts.pop() ?? '_';
    return parts.length > 0 ? `${parts.join('/')}/${fileName}` : fileName;
}

// ============ 文档获取 ============

export async function fetchDocContent(objToken: string, waitForDownloadSlot: () => Promise<void>): Promise<string> {
    try {
        await waitForDownloadSlot();
        const mdRes = await execJSONAsync<{
            data?: {
                document?: { content?: string };
                markdown?: string;
                content?: string;
                raw_content?: string;
            };
        }>([
            'api', 'POST', `/open-apis/docs_ai/v1/documents/${objToken}/fetch`,
            '--data', '{"format":"markdown"}',
            '--as', 'user'
        ]);
        const data = mdRes?.data;
        if (data) {
            const content
                = data.document?.content ?? data.markdown ?? data.content ?? data.raw_content;
            if (content) return content;
        }
    } catch {
    // fallback
    }

    await waitForDownloadSlot();
    const res = await execJSONAsync<Record<string, unknown>>([
        'docs', '+fetch',
        '--doc', objToken,
        '--api-version', 'v2',
        '--json', '--as', 'user'
    ]);

    if (!res) return '';

    let content = '';
    const data = res.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object') {
        const doc = data.document as Record<string, unknown> | undefined;
        const raw = doc?.content ?? data.content ?? data.markdown ?? data.raw_content;
        content = typeof raw === 'string' ? raw : '';
    }
    if (!content && typeof res.content === 'string') {
        content = res.content;
    }

    if (!content) return '';
    if (content.trimStart().startsWith('<')) return xmlToReadable(content);
    return content;
}

// ============ 节点元信息 ============

/**
 * 调用 wiki +node-get 获取节点远端的 updated_at。
 * 使用 execJSONAsync 以支持并发调用和速率控制。
 * 遇到限流错误（99991400）时自动指数退避重试，最多 5 次。
 */
export async function fetchNodeMetaAsync(objToken: string, objType: string): Promise<{ updated_at: string } | null> {
    const validTypes = new Set(['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'slides', 'file']);

    if (!validTypes.has(objType)) return null;
    try {
        const res = await execJSONAsync<{ data?: { updated_at?: string }; ok: boolean; error?: { code: number; message: string } }>([
            'wiki', '+node-get',
            '--node-token', objToken,
            '--obj-type', objType,
            '--json', '--as', 'user'
        ]);
        if (!res?.ok) {
            throw new FeishuAPIError(res?.error?.message ?? 'API error', res?.error?.code ?? 0, '', '', false, '');
        }
        const node = res.data;
        if (!node) return null;
        return {
            updated_at: node.updated_at ?? ''
        };
    } catch (err) {
        if (String(err).includes('131005')) {
            throw new FeishuAPIError('not found', 131005, '', '', false, '');
        }
        return null;
    }
}

// ============ DeepSeek 描述生成 ============

/**
 * 调用 DeepSeek API 生成文本摘要。
 * 通过 loadConfig() 加载 deepseek.token 和 deepseek.model。
 * 失败时返回空字符串。
 */
export async function generateDescription(prompt: string): Promise<string> {
    const cfg = await loadConfig();
    const token = cfg.deepseek?.token;
    if (!token) return '';

    return chat({ token, model: cfg.deepseek?.model, reasoningEffort: cfg.deepseek?.reasoningEffort }, {
        systemPrompt: '你是一个文档摘要专家。请根据提供的内容生成一段不超过200个汉字的简洁描述。只返回描述文本，不要包含任何其他内容。',
        userPrompt: prompt,
        temperature: 0.7
    });
}

/**
 * 根据文档标题和 Markdown 内容解析并生成描述。
 * 优先使用 headings 作为摘要源；当标题的中文字符数 <= 10 时，
 * 改使用 extractBodyPreview(markdown, 500) 提取正文前 500 个中文字符作为源文本。
 */
export async function resolveDescription(markdown: string): Promise<string> {
    const headings = extractHeadings(markdown);
    if (headings.length === 0) {
    // 无标题时直接用正文预览
        const bodyText = extractBodyPreview(markdown, 500);
        if (!bodyText) return '';
        return generateDescription(bodyText);
    }

    const joined = headings.join(' ');
    // 统计中文字符数（Unicode 范围 一-鿿）
    const chineseChars = joined.match(/[一-鿿]/g) ?? [];
    if (chineseChars.length <= 10) {
        const bodyText = extractBodyPreview(markdown, 500);
        if (!bodyText) return '';
        return generateDescription(bodyText);
    }

    return generateDescription(joined);
}
