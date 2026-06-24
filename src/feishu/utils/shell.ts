// 飞书 CLI (lark-cli) 封装：同步/异步执行、JSON 解析、结构化错误

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function execJSON<T>(cmdArgs: string[]): T | null {
    const result = Bun.spawnSync(['lark-cli', ...cmdArgs], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000
    });

    return parseJSONResult<T>(result.exitCode, result.stdout, result.stderr);
}

export async function execJSONAsync<T>(cmdArgs: string[]): Promise<T | null> {
    const proc = Bun.spawn(['lark-cli', ...cmdArgs], {
        stdout: 'pipe',
        stderr: 'pipe'
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
        proc.exited
    ]);

    return parseJSONResult<T>(exitCode, stdout, stderr);
}

/** 飞书 API 结构化错误 */
export class FeishuAPIError extends Error {
    constructor(
        message: string,
        public readonly code: number,
        public readonly type: string,
        public readonly subtype: string,
        public readonly retryable: boolean,
        public readonly logId?: string
    ) {
        super(message);
        this.name = 'FeishuAPIError';
    }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function parseJSONResult<T>(exitCode: number | null, stdoutBytes: ArrayBuffer | Uint8Array, stderrBytes: ArrayBuffer | Uint8Array): T | null {
    if (exitCode !== 0) {
        const stderr = new TextDecoder().decode(stderrBytes).trim();
        if (stderr) throw new Error(stderr);
        return null;
    }

    const stdout = new TextDecoder().decode(stdoutBytes).trim();
    if (!stdout) return null;

    try {
        const json = JSON.parse(stdout) as Record<string, unknown>;
        if (json.ok === false && json.error) {
            const err = json.error as Record<string, string>;
            throw new FeishuAPIError(
                err.message ?? 'API error',
                err.code ? Number(err.code) : 0,
                err.type ?? '',
                err.subtype ?? '',
                err.retryable === 'true',
                err.log_id
            );
        }
        return json as T;
    } catch (e) {
        if (e instanceof FeishuAPIError) throw e;
        return null;
    }
}
