// 异步原语：sleep、终端进度写入、限流器

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export function writeProgress(text: string) {
    process.stdout.write(`\r\x1b[K${text}`);
}

/**
 * 基于最小间隔的简易限流器。
 * 多次调用 waitForSlot() 会按 qps 速率串行等待，常用于网络请求节流。
 */
export function createRateLimiter(qps: number): () => Promise<void> {
    const interval = Math.ceil(1000 / qps);
    let nextAt = 0;
    let chain = Promise.resolve();

    return () => {
        chain = chain.then(async () => {
            const now = Date.now();
            const wait = Math.max(0, nextAt - now);
            nextAt = Math.max(now, nextAt) + interval;
            if (wait > 0) await sleep(wait);
        });
        return chain;
    };
}
