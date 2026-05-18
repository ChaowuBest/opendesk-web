import { getPlatform } from '../../platforms/base.js';

/**
 * 从模型对象中提取是否支持视觉/图像输入的能力。
 * 兼容多种 API 格式：
 * - OpenRouter: architecture.modality 包含 "image" 或 "multimodal"
 * - 通用: capabilities.vision, supports_vision
 */
function extractVisionSupport(model: any): boolean | undefined {
    if (!model) return undefined;

    const modality = model.architecture?.modality ?? model.modality ?? '';
    if (typeof modality === 'string') {
        const lower = modality.toLowerCase();
        if (lower.includes('image') || lower.includes('multimodal') || lower.includes('vision')) {
            return true;
        }
    }

    if (model.capabilities?.vision === true) return true;
    if (model.supports_vision === true) return true;
    if (model.model_info?.supports_vision === true) return true;

    return undefined;
}

function pickPositiveNumber(candidates: unknown[]): number {
    for (const val of candidates) {
        if (typeof val === 'number' && val > 0) return val;
    }
    return 0;
}

/**
 * 从模型对象中提取上下文窗口大小，兼容多种 API 格式：
 * - 火山引擎 Ark: token_limits.context_window
 * - OpenRouter: context_length
 * - vLLM: max_model_len
 * - 通用: context_window, max_context_length
 */
function extractContextSize(model: any): number {
    if (!model) return 0;
    return pickPositiveNumber([
        model.token_limits?.context_window,
        model.token_limits?.max_input_token_length,
        model.context_length,
        model.context_window,
        model.max_context_length,
        model.max_model_len,
        model.model_info?.context_length,
        model.model_info?.context_window
    ]);
}

/**
 * 从模型对象中提取最大输出 token 数，兼容多种 API 格式：
 * - OpenAI 兼容: token_limits.max_output_tokens / max_completion_tokens
 * - 通用: max_output_tokens / max_completion_tokens / output_token_limit
 * - 扩展: model_info.max_output_tokens / top_provider.max_completion_tokens
 */
function extractMaxOutputTokens(model: any): number {
    if (!model) return 0;
    return pickPositiveNumber([
        model.token_limits?.max_output_tokens,
        model.token_limits?.max_completion_tokens,
        model.max_output_tokens,
        model.max_completion_tokens,
        model.output_token_limit,
        model.model_info?.max_output_tokens,
        model.model_info?.max_completion_tokens,
        model.top_provider?.max_completion_tokens
    ]);
}

/**
 * 在模型列表中查找目标模型，支持多种匹配策略：
 * 1. id 精确匹配
 * 2. name 精确匹配
 * 3. id 或 name 前缀匹配（取最新的）
 */
function findModelInList(models: any[], modelName: string): any | undefined {
    const norm = modelName.toLowerCase().replace(/[._]/g, '-');
    const normId = (m: any) => (m.id ?? '').toLowerCase().replace(/[._]/g, '-');
    const normName = (m: any) => (m.name ?? '').toLowerCase().replace(/[._]/g, '-');

    return (
        models.find((m: any) => m.id === modelName) ??
        models.find((m: any) => m.name === modelName) ??
        models.find((m: any) => normId(m) === norm) ??
        models.find((m: any) => normName(m) === norm) ??
        models
            .filter((m: any) => {
                const id = normId(m),
                    name = normName(m);
                return id.startsWith(norm) || name.startsWith(norm) || norm.startsWith(id) || norm.startsWith(name);
            })
            .sort((a: any, b: any) => (b.created ?? 0) - (a.created ?? 0))[0]
    );
}

/**
 * 尝试通过 OpenAI 兼容 API 的 /models 端点获取模型的上下文窗口大小。
 * 失败时返回 0 表示未知。
 */
export async function fetchContextSizeFromAPI(modelInstance: {
    base_url: string;
    api_key: string;
    model_name: string;
}): Promise<number> {
    const { base_url: baseUrl, api_key: apiKey, model_name: modelName } = modelInstance;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const resp = await getPlatform().fetch(`${baseUrl}/models/${encodeURIComponent(modelName)}`, {
            headers,
            signal: AbortSignal.timeout(5000)
        });
        if (resp.ok) {
            const size = extractContextSize(await resp.json());
            if (size > 0) return size;
        }
    } catch {
        /* 忽略单模型端点错误 */
    }

    try {
        const resp = await getPlatform().fetch(`${baseUrl}/models`, {
            headers,
            signal: AbortSignal.timeout(8000)
        });
        if (resp.ok) {
            const body = await resp.json();
            const models: any[] = body.data ?? body;
            const match = findModelInList(models, modelName);
            if (match) {
                const size = extractContextSize(match);
                if (size > 0) return size;
            }
        }
    } catch {
        /* 忽略列表端点错误 */
    }

    return 0;
}

/**
 * 尝试通过 OpenAI 兼容 API 的 /models 端点获取模型的最大输出 token 数。
 * 失败时返回 0 表示未知。
 */
export async function fetchMaxOutputTokensFromAPI(modelInstance: {
    base_url: string;
    api_key: string;
    model_name: string;
}): Promise<number> {
    const { base_url: baseUrl, api_key: apiKey, model_name: modelName } = modelInstance;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const resp = await getPlatform().fetch(`${baseUrl}/models/${encodeURIComponent(modelName)}`, {
            headers,
            signal: AbortSignal.timeout(5000)
        });
        if (resp.ok) {
            const size = extractMaxOutputTokens(await resp.json());
            if (size > 0) return size;
        }
    } catch {
        /* 忽略单模型端点错误 */
    }

    try {
        const resp = await getPlatform().fetch(`${baseUrl}/models`, {
            headers,
            signal: AbortSignal.timeout(8000)
        });
        if (resp.ok) {
            const body = await resp.json();
            const models: any[] = body.data ?? body;
            const match = findModelInList(models, modelName);
            if (match) {
                const size = extractMaxOutputTokens(match);
                if (size > 0) return size;
            }
        }
    } catch {
        /* 忽略列表端点错误 */
    }

    return 0;
}

/**
 * 尝试通过 OpenAI 兼容 API 的 /models 端点获取模型是否支持视觉输入。
 * 返回 true/false，如果无法判断则返回 undefined。
 */
export async function fetchVisionSupportFromAPI(modelInstance: {
    base_url: string;
    api_key: string;
    model_name: string;
}): Promise<boolean | undefined> {
    const { base_url: baseUrl, api_key: apiKey, model_name: modelName } = modelInstance;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const resp = await getPlatform().fetch(`${baseUrl}/models/${encodeURIComponent(modelName)}`, {
            headers,
            signal: AbortSignal.timeout(5000)
        });
        if (resp.ok) {
            const result = extractVisionSupport(await resp.json());
            if (result !== undefined) return result;
        }
    } catch {
        /* 忽略单模型端点错误 */
    }

    try {
        const resp = await getPlatform().fetch(`${baseUrl}/models`, {
            headers,
            signal: AbortSignal.timeout(8000)
        });
        if (resp.ok) {
            const body = await resp.json();
            const models: any[] = body.data ?? body;
            const match = findModelInList(models, modelName);
            if (match) {
                const result = extractVisionSupport(match);
                if (result !== undefined) return result;
            }
        }
    } catch {
        /* 忽略列表端点错误 */
    }

    return undefined;
}

/**
 * 已知支持视觉/图像输入的模型查找表。
 * 值为 true 表示支持视觉，false 表示明确不支持。
 */
const KNOWN_VISION_MODELS: Record<string, boolean> = {
    // ── OpenAI ──
    'gpt-5-2': true,
    'gpt-5-3-codex': true,
    'gpt-5': true,
    'gpt-4o': true,
    'gpt-4o-mini': true,
    'gpt-4-turbo': true,
    'gpt-4': false,
    o1: true,
    'o1-mini': true,
    o3: true,
    'o3-mini': true,
    'o4-mini': true,

    // ── Claude / Anthropic ──
    'claude-4-6-opus': true,
    'claude-4-6-sonnet': true,
    'claude-4-opus': true,
    'claude-4-sonnet': true,
    'claude-3-7-sonnet': true,
    'claude-3-5-sonnet': true,
    'claude-3-5-haiku': true,
    'claude-3-opus': true,
    'claude-3-sonnet': true,
    'claude-3-haiku': true,

    // ── Gemini / Google ──
    'gemini-3-pro': true,
    'gemini-3-flash': true,
    'gemini-2-5-flash': true,
    'gemini-2-5-pro': true,
    'gemini-2-0-flash': true,
    'gemini-1-5-pro': true,
    'gemini-1-5-flash': true,

    // ── DeepSeek ──
    'deepseek-v3': false,
    'deepseek-v3-1': false,
    'deepseek-v3-2': false,
    'deepseek-r1': false,

    // ── Qwen / Alibaba ──
    'qwen-vl-max': true,
    'qwen-vl-plus': true,
    'qwen2-5-vl-7b': true,
    'qwen2-5-vl-72b': true,
    'qwen3-5-max': true,

    // ── GLM / Zhipu ──
    'glm-4v': true,
    'glm-4v-plus': true,
    'glm-4': false,
    'glm-4-5': false,
    'glm-4-5-air': false,
    'glm-5': true,
    'glm-5-turbo': true,

    // ── Kimi / Moonshot ──
    'kimi-k2': true,
    'kimi-k2-5': true,

    // ── Doubao / ByteDance ──
    'doubao-1-5-pro-32k': true,
    'doubao-seed-1-6': true,
    'doubao-seed-1-8': true,
    'doubao-seed-2-0-pro': true,

    // ── Llama / Meta ──
    'llama-4-scout': true,
    'llama-4-maverick': true
};

/**
 * 在查找表中查找模型是否支持视觉输入。
 * 使用与 lookupKnownContextSize 相同的匹配策略。
 */
export function lookupKnownVisionSupport(rawModelName: string): boolean | undefined {
    const base = normalize(stripProviderPrefix(rawModelName));
    const candidates = stripSuffixes(base);

    for (const c of candidates) {
        if (KNOWN_VISION_MODELS[c] !== undefined) return KNOWN_VISION_MODELS[c];
    }

    let bestLen = 0;
    let bestResult: boolean | undefined = undefined;
    for (const [key, support] of Object.entries(KNOWN_VISION_MODELS)) {
        if (base.startsWith(key) && key.length > bestLen) {
            bestLen = key.length;
            bestResult = support;
        }
    }
    if (bestResult !== undefined) return bestResult;

    for (const c of candidates) {
        let rBestLen = 0;
        let rBestResult: boolean | undefined = undefined;
        for (const [key, support] of Object.entries(KNOWN_VISION_MODELS)) {
            if (key.startsWith(c) && c.length > rBestLen) {
                rBestLen = c.length;
                rBestResult = support;
            }
        }
        if (rBestResult !== undefined) return rBestResult;
    }

    return undefined;
}

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
    'glm-4-7': 202752,
    'glm-5': 202752,

    // ── Qwen / Alibaba ──
    'qwen3.5-max': 1000000,
    'qwen3.5-397b': 262144,
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
    'gpt-5-2': 400000,
    'gpt-5-3-codex': 400000,
    'gpt-5': 272000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-4-32k': 32768, // 旧版，API 兼容
    'gpt-3-5-turbo': 16384,
    'gpt-3-5-turbo-16k': 16384,
    o1: 200000,
    'o1-mini': 128000,
    'o1-pro': 200000,
    o3: 200000,
    'o3-mini': 200000,
    'o4-mini': 200000,

    // ── Claude / Anthropic ──
    'claude-4-6-opus': 200000, // 1M 需 beta header
    'claude-4-6-sonnet': 200000,
    'claude-4-opus': 200000,
    'claude-4-sonnet': 200000,
    'claude-3-7-sonnet': 200000,
    'claude-3-5-sonnet': 200000,
    'claude-3-5-haiku': 200000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,

    // ── Gemini / Google ──
    'gemini-3-pro': 1048576,
    'gemini-3-flash': 200000,
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
    'minimax-01': 4194304, // 4M 开源长上下文
    'minimax-m2-5': 204800,
    'minimax-m2-5-highspeed': 204800,
    'minimax-m2': 204800
};

/**
 * 常见模型最大输出 token 上限查找表。
 * 仅在 API 元数据不可用时兜底，用于 summary 输出预留与 max_completion_tokens 默认值。
 */
const KNOWN_MAX_OUTPUT_TOKENS: Record<string, number> = {
    // ── OpenAI ──
    'gpt-5-2': 128000,
    'gpt-5-3-codex': 128000,
    'gpt-5': 128000,
    'gpt-4o': 16384,
    'gpt-4o-mini': 16384,
    'gpt-4-turbo': 4096,
    'gpt-4': 4096,
    'gpt-4-32k': 4096,
    'gpt-3-5-turbo': 4096,
    'gpt-3-5-turbo-16k': 4096,
    o1: 100000,
    'o1-mini': 65536,
    'o1-pro': 100000,
    o3: 100000,
    'o3-mini': 100000,
    'o4-mini': 100000,

    // ── Claude / Anthropic ──
    'claude-4-6-opus': 64000,
    'claude-4-6-sonnet': 64000,
    'claude-4-opus': 64000,
    'claude-4-sonnet': 64000,
    'claude-3-7-sonnet': 64000,
    'claude-3-5-sonnet': 8192,
    'claude-3-5-haiku': 8192,
    'claude-3-opus': 4096,
    'claude-3-sonnet': 4096,
    'claude-3-haiku': 4096,

    // ── Gemini / Google ──
    'gemini-3-pro': 65536,
    'gemini-3-flash': 65536,
    'gemini-2-5-flash': 65536,
    'gemini-2-5-pro': 65536,
    'gemini-2-0-flash': 8192,
    'gemini-1-5-pro': 8192,
    'gemini-1-5-flash': 8192
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
    const push = (v: string) => {
        if (v !== name && !variants.includes(v)) variants.push(v);
    };

    // 6 位日期后缀
    push(name.replace(/-\d{6}$/, ''));
    // ISO 日期后缀
    push(name.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
    // 常见变体词
    const suffixPattern =
        /-(instruct|chat|preview|latest|terminus|thinking|character|functioncall|browsing|online|turbo|fast|slow|free|hf|fp16|bf16|awq|gptq|gguf)$/;
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
    let bestLen = 0,
        bestSize = 0;
    for (const [key, size] of Object.entries(KNOWN_CONTEXT_SIZES)) {
        if (base.startsWith(key) && key.length > bestLen) {
            bestLen = key.length;
            bestSize = size;
        }
    }
    if (bestSize > 0) return bestSize;

    // 反向前缀匹配：base（或其去后缀版本）是 key 的前缀
    for (const c of candidates) {
        let rBestLen = 0,
            rBestSize = 0;
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

/**
 * 在查找表中查找模型的最大输出 token 上限。
 * 匹配策略与 lookupKnownContextSize 保持一致。
 */
export function lookupKnownMaxOutputTokens(rawModelName: string): number {
    const base = normalize(stripProviderPrefix(rawModelName));
    const candidates = stripSuffixes(base);

    for (const c of candidates) {
        if (KNOWN_MAX_OUTPUT_TOKENS[c] !== undefined) return KNOWN_MAX_OUTPUT_TOKENS[c];
    }

    let bestLen = 0;
    let bestSize = 0;
    for (const [key, size] of Object.entries(KNOWN_MAX_OUTPUT_TOKENS)) {
        if (base.startsWith(key) && key.length > bestLen) {
            bestLen = key.length;
            bestSize = size;
        }
    }
    if (bestSize > 0) return bestSize;

    for (const c of candidates) {
        let rBestLen = 0;
        let rBestSize = 0;
        for (const [key, size] of Object.entries(KNOWN_MAX_OUTPUT_TOKENS)) {
            if (key.startsWith(c) && c.length > rBestLen) {
                rBestLen = c.length;
                rBestSize = size;
            }
        }
        if (rBestSize > 0) return rBestSize;
    }

    return 0;
}
