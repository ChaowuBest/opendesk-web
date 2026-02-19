/**
 * 常见模型上下文窗口大小查找表及鲁棒匹配逻辑。
 * 当 API 无法返回上下文信息时用作兜底。
 *
 * key 统一为小写，分隔符用 `-`（即 `.` `_` 都被替换为 `-`）。
 */
const KNOWN_CONTEXT_SIZES: Record<string, number> = {
    // ── DeepSeek ──
    'deepseek-v3': 131072,
    'deepseek-v3-1': 131072,
    'deepseek-v3-2': 131072,
    'deepseek-r1': 131072,
    'deepseek-r1-distill-qwen-7b': 65536,
    'deepseek-r1-distill-qwen-32b': 65536,
    'deepseek-r1-distill-llama-8b': 65536,
    'deepseek-r1-distill-llama-70b': 65536,

    // ── Kimi / Moonshot ──
    'kimi-k2': 262144,
    'kimi-k2-5': 262144,
    'moonshot-v1-8k': 8192,
    'moonshot-v1-32k': 32768,
    'moonshot-v1-128k': 131072,

    // ── GLM / Zhipu ──
    'glm-4': 128000,
    'glm-4-5': 128000,
    'glm-4-5-air': 128000,
    'glm-4-7': 204800,
    'glm-5': 128000,

    // ── Qwen / Alibaba ──
    'qwen3-0-6b': 32768,
    'qwen3-1-7b': 131072,
    'qwen3-4b': 131072,
    'qwen3-8b': 131072,
    'qwen3-14b': 131072,
    'qwen3-30b': 131072,
    'qwen3-32b': 131072,
    'qwen3-235b': 131072,
    'qwen2-5-7b': 131072,
    'qwen2-5-14b': 131072,
    'qwen2-5-32b': 131072,
    'qwen2-5-72b': 131072,
    'qwen2-5-coder-7b': 131072,
    'qwen2-5-coder-32b': 131072,
    'qwq-32b': 131072,

    // ── Doubao / ByteDance ──
    'doubao-pro-32k': 32768,
    'doubao-lite-32k': 32768,
    'doubao-pro-128k': 131072,
    'doubao-pro-256k': 262144,
    'doubao-1-5-pro-32k': 131072,
    'doubao-1-5-lite-32k': 32768,
    'doubao-1-5-pro-256k': 262144,
    'doubao-1-5-thinking-pro': 131072,
    'doubao-seed-1-6': 262144,
    'doubao-seed-1-6-flash': 262144,
    'doubao-seed-1-6-thinking': 262144,
    'doubao-seed-1-6-lite': 262144,
    'doubao-seed-1-8': 262144,
    'doubao-seed-2-0-pro': 262144,
    'doubao-seed-2-0-lite': 262144,
    'doubao-seed-2-0-mini': 262144,
    'doubao-seed-2-0-code': 262144,

    // ── OpenAI ──
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-4-32k': 32768,
    'gpt-3-5-turbo': 16384,
    'gpt-3-5-turbo-16k': 16384,
    'o1': 200000,
    'o1-mini': 128000,
    'o1-pro': 200000,
    'o3': 200000,
    'o3-mini': 200000,
    'o4-mini': 200000,

    // ── Claude / Anthropic ──
    'claude-4-opus': 200000,
    'claude-4-sonnet': 200000,
    'claude-3-7-sonnet': 200000,
    'claude-3-5-sonnet': 200000,
    'claude-3-5-haiku': 200000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,

    // ── Gemini / Google ──
    'gemini-2-5-flash': 1048576,
    'gemini-2-5-pro': 1048576,
    'gemini-2-0-flash': 1048576,
    'gemini-1-5-pro': 2097152,
    'gemini-1-5-flash': 1048576,

    // ── Llama / Meta ──
    'llama-3-3-70b': 131072,
    'llama-3-1-8b': 131072,
    'llama-3-1-70b': 131072,
    'llama-3-1-405b': 131072,
    'llama-4-scout': 10485760,
    'llama-4-maverick': 1048576,

    // ── Mistral ──
    'mistral-large': 131072,
    'mistral-small': 131072,
    'mistral-medium': 32768,
    'mistral-7b': 32768,
    'mixtral-8x7b': 32768,
    'mixtral-8x22b': 65536,

    // ── MiniMax ──
    'minimax-m2-5': 1048576,

    // ── Yi / 01.AI ──
    'yi-large': 32768,
    'yi-lightning': 16384,

    // ── Internlm ──
    'internlm3-8b': 32768,
    'internlm2-5-20b': 32768,
};

/**
 * 标准化模型名称：小写 + 分隔符归一化为 `-`
 */
function normalize(name: string): string {
    return name.toLowerCase().replace(/[._]/g, '-');
}

/**
 * 去掉 provider 前缀（`/` 之前的部分）
 * "Pro/moonshotai/Kimi-K2.5" → "Kimi-K2.5"
 * "deepseek-ai/DeepSeek-V3.2" → "DeepSeek-V3.2"
 */
function stripProviderPrefix(name: string): string {
    const idx = name.lastIndexOf('/');
    return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * 逐步去掉尾部的日期/版本后缀：
 *   1. 6 位日期  "-241215"
 *   2. ISO 日期  "-2024-08-06"
 *   3. 常见变体  "-instruct", "-chat", "-preview", "-latest", "-terminus", "-thinking" 等
 */
function stripSuffixes(name: string): string[] {
    const variants: string[] = [name];
    const push = (v: string) => { if (v !== name && !variants.includes(v)) variants.push(v); };

    // 6 位日期后缀
    push(name.replace(/-\d{6}$/, ''));
    // ISO 日期后缀
    push(name.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
    // 常见变体词
    const suffixPattern = /-(instruct|chat|preview|latest|terminus|thinking|character|functioncall|browsing|online|turbo|fast|slow|free|hf|fp16|bf16|awq|gptq|gguf)$/;
    for (const v of [...variants]) {
        const stripped = v.replace(suffixPattern, '');
        push(stripped);
    }
    return variants;
}

/**
 * 在查找表中查找模型的上下文大小。
 *
 * 匹配策略（按优先级）：
 *   1. 去前缀 + 标准化后精确匹配
 *   2. 再逐步去掉日期/变体后缀匹配
 *   3. 最长 key 前缀匹配（模型名以 key 开头）
 *   4. 反向前缀匹配（key 以模型名开头，取最长的）
 */
export function lookupKnownContextSize(rawModelName: string): number {
    const base = normalize(stripProviderPrefix(rawModelName));
    const candidates = stripSuffixes(base);

    for (const c of candidates) {
        if (KNOWN_CONTEXT_SIZES[c] !== undefined) return KNOWN_CONTEXT_SIZES[c];
    }

    // 最长 key 前缀匹配：key 是 base 的前缀
    let bestLen = 0, bestSize = 0;
    for (const [key, size] of Object.entries(KNOWN_CONTEXT_SIZES)) {
        if (base.startsWith(key) && key.length > bestLen) {
            bestLen = key.length;
            bestSize = size;
        }
    }
    if (bestSize > 0) return bestSize;

    // 反向前缀匹配：base（或其去后缀版本）是 key 的前缀
    for (const c of candidates) {
        let rBestLen = 0, rBestSize = 0;
        for (const [key, size] of Object.entries(KNOWN_CONTEXT_SIZES)) {
            if (key.startsWith(c) && c.length > rBestLen) {
                rBestLen = c.length;
                rBestSize = size;
            }
        }
        if (rBestSize > 0) return rBestSize;
    }

    return 0;
}
