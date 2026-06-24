import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// ============ Types ============

export interface DeepseekConfig {
    token?: string;
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface FeishuGroupConfig {
    aimDirectory?: string;
    aimUrl?: string;
}

/**
 * 飞书配置:顶层 `dir` 是同步输出目录;
 * `default` 与各 group 对象(键名即 group 名)各自配置 aimDirectory / aimUrl。
 *
 * 示例:
 * ```json
 * {
 *   "feishu": {
 *     "dir": "./docs/feishu",
 *     "default": { "aimDirectory": "./docs", "aimUrl": "https://example.com/docs" },
 *     "blog": { "aimDirectory": "./blog", "aimUrl": "https://example.com/blog" }
 *   }
 * }
 * ```
 *
 * 索引签名 `[group: string]` 允许任意 group 名,实际取值时通过 `resolveFeishuGroupConfig`
 * 判断值是否为对象(过滤掉 `dir` 等字符串字段)。
 */
interface FeishuConfig {
    dir?: string;
    default?: FeishuGroupConfig;
    [group: string]: FeishuGroupConfig | string | undefined;
}

interface OssConfig {
    profile?: string;
    bucket?: string;
    region?: string;
    pathPrefix?: string;
    urlPrefix?: string;
}

interface SkillsConfig {
    directory?: string;
}

export interface AppConfig {
    deepseek?: DeepseekConfig;
    feishu?: FeishuConfig;
    oss?: OssConfig;
    skills?: SkillsConfig;
}

// ============ Path Helpers ============

export function getConfigDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, 'cmd4bun');
    return join(homedir(), '.config', 'cmd4bun');
}

export function getConfigPath(): string {
    return join(getConfigDir(), 'config.json');
}

// ============ Config Loading ============

/**
 * 检测并警告老版飞书配置(feishu.aimDirectory / feishu.aimUrl 顶层字段)。
 * 这两个字段已迁移到 feishu.default.aimDirectory / feishu.default.aimUrl,
 * 老键不再被读取。检测到时打 stderr 警告并提示迁移,不阻断运行(用户可继续使用 default 分组,
 * 但老键的值会被忽略)。
 */
function warnLegacyFeishuConfig(parsed: Record<string, unknown>): void {
    const feishu = parsed.feishu;
    if (!feishu || typeof feishu !== 'object') return;
    const legacy: string[] = [];
    if ('aimDirectory' in feishu) legacy.push('aimDirectory');
    if ('aimUrl' in feishu) legacy.push('aimUrl');
    if (legacy.length > 0) {
        console.error(
            `[cmd4bun] 检测到老版飞书配置 feishu.{${legacy.join(', ')}}。`
            + `请迁移到 feishu.default.{${legacy.join(', ')}} 命名空间,老键将被忽略。`
        );
    }
}

export async function loadConfig(): Promise<AppConfig> {
    const configPath = getConfigPath();
    try {
        const file = Bun.file(configPath);
        const exists = await file.exists();
        if (!exists) return {};
        const parsed = (await file.json()) as AppConfig;
        warnLegacyFeishuConfig(parsed as Record<string, unknown>);
        return parsed;
    } catch (err) {
        if (err instanceof SyntaxError) {
            console.warn(
                `[cmd4bun] Invalid JSON in config file: ${configPath} — ${err.message}`
            );
        }
        return {};
    }
}

// ============ Token Resolution ============

export function resolveToken(
    cfg: AppConfig,
    env: typeof process.env
): string | undefined {
    if (env.CMD_BUN_DEEPSEEK_TOKEN) return env.CMD_BUN_DEEPSEEK_TOKEN;
    if (cfg.deepseek?.token) return cfg.deepseek.token;
    return undefined;
}

// ============ Feishu Dir Resolution ============

export function resolveFeishuDir(cfg: AppConfig, cliValue?: string): string {
    if (cliValue !== undefined) return resolve(process.cwd(), cliValue);
    if (cfg.feishu?.dir) return resolve(process.cwd(), cfg.feishu.dir);
    return resolve(process.cwd(), './docs/feishu');
}

// ============ Feishu Group Resolution ============

/**
 * 从飞书配置中按 group 名取对应 group 配置。
 *
 * 索引签名下 `feishu[key]` 的类型是 `FeishuGroupConfig | string | undefined`,
 * 需要运行时判断是否为对象(过滤掉 `dir` 这类字符串字段)。
 *
 * @returns 命中时返回对应 group 配置对象;未配置该 group 时返回 null(调用方决定 fallback 到 default)
 */
export function resolveFeishuGroupConfig(
    cfg: AppConfig,
    group: string
): FeishuGroupConfig | null {
    const feishu = cfg.feishu;
    if (!feishu) return null;
    const value = feishu[group];
    if (typeof value !== 'object') return null;
    return value;
}

// ============ OSS Config Builder ============

export interface OssClientConfig {
    profile: string;
    bucket: string;
    region: string;
    pathPrefix: string;
    urlPrefix: string;
}

export function buildOssConfig(cfg: AppConfig): OssClientConfig | null {
    const oss = cfg.oss;
    if (!oss) return null;
    if (oss.profile && oss.bucket && oss.pathPrefix && oss.urlPrefix) {
        return {
            profile: oss.profile,
            bucket: oss.bucket,
            region: oss.region ?? 'oss-cn-hangzhou',
            pathPrefix: oss.pathPrefix,
            urlPrefix: oss.urlPrefix
        };
    }
    return null;
}
