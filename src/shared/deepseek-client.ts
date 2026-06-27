// 共享 DeepSeek API 客户端，commit 和 feishu 模块共用

import type { DeepseekConfig } from '../config';

// ============ Types ============

export interface DeepSeekRequest {
    systemPrompt: string;
    userPrompt: string;
    /** 模型可选项，覆盖 config 中的默认值 */
    model?: string;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
}

// ============ API Call ============

export async function chat(
    config: DeepseekConfig,
    request: DeepSeekRequest
): Promise<string> {
    const token = config.token;
    if (!token) return '';

    const model = request.model ?? config.model ?? 'deepseek-chat';

    const body: Record<string, unknown> = {
        model,
        messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt }
        ],
        max_tokens: request.maxTokens ?? 1024,
        stream: false
    };

    if (request.temperature !== undefined) {
        body.temperature = request.temperature;
    }
    if (request.reasoningEffort) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = request.reasoningEffort;
    }

    try {
        const resp = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });
        if (!resp.ok) return '';

        const json = await resp.json() as { choices?: { message?: { content?: string } }[] };
        return (json.choices?.[0]?.message?.content ?? '').trim();
    } catch {
        return '';
    }
}
