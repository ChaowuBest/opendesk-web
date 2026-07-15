import { fetchModelUrl, type ModelNetworkConfig } from './model-network.js';

/**
 * 已知模型的信息记录，合并了上下文窗口大小、最大输出 token 和视觉支持。
 * 当 API 无法返回模型信息时用作兜底。
 *
 * key 统一为小写，分隔符用 `-`（即 `.` `_` 都被替换为 `-`）。
 * vision 为 undefined 表示未知，false 表示明确不支持。
 */
interface ModelInfo {
    /** 上下文窗口大小（token），0 表示未知 */
    contextSize: number;
    /** 最大输出 token 数，0 表示未知 */
    maxOutputTokens: number;
    /** 是否支持视觉/图像输入，undefined 表示未知，false 表示明确不支持 */
    vision?: boolean;
}

/**
 * 已知模型信息查找表。
 * 数据来源：各厂商官方文档 + llmdb.xyz 交叉验证（2026-07）。
 */
const KNOWN_MODELS: Record<string, ModelInfo> = {
    // ═══════════════════════════════════════════════
    // OpenAI / GPT
    // ═══════════════════════════════════════════════
    'gpt-5-2': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-1': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-mini': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-pro': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-thinking': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-5': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-5-pro': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-5-instant': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-6': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-6-sol': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-6-terra': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-6-luna': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-4': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-4-pro': { contextSize: 1050000, maxOutputTokens: 128000, vision: true },
    'gpt-5-4-mini': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-4-nano': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-3': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-5-3-codex': { contextSize: 400000, maxOutputTokens: 128000, vision: true },
    'gpt-4-1': { contextSize: 1047576, maxOutputTokens: 32768, vision: true },
    'gpt-4-1-mini': { contextSize: 1047576, maxOutputTokens: 32768, vision: true },
    'gpt-4-1-nano': { contextSize: 1047576, maxOutputTokens: 32768, vision: true },
    'gpt-4o': { contextSize: 128000, maxOutputTokens: 16384, vision: true },
    'gpt-4o-mini': { contextSize: 128000, maxOutputTokens: 16384, vision: true },
    'gpt-4-turbo': { contextSize: 128000, maxOutputTokens: 4096, vision: true },
    'gpt-4': { contextSize: 8192, maxOutputTokens: 4096, vision: false },
    'gpt-4-32k': { contextSize: 32768, maxOutputTokens: 4096, vision: false },
    'gpt-3-5-turbo': { contextSize: 16384, maxOutputTokens: 4096, vision: false },
    'gpt-3-5-turbo-16k': { contextSize: 16384, maxOutputTokens: 4096, vision: false },
    o1: { contextSize: 200000, maxOutputTokens: 100000, vision: true },
    'o1-mini': { contextSize: 128000, maxOutputTokens: 65536, vision: false },
    'o1-pro': { contextSize: 200000, maxOutputTokens: 100000, vision: true },
    o3: { contextSize: 200000, maxOutputTokens: 100000, vision: true },
    'o3-mini': { contextSize: 200000, maxOutputTokens: 100000, vision: false },
    'o4-mini': { contextSize: 200000, maxOutputTokens: 100000, vision: true },

    // ═══════════════════════════════════════════════
    // Claude / Anthropic
    // ═══════════════════════════════════════════════
    'claude-4-8-opus': { contextSize: 1000000, maxOutputTokens: 64000, vision: true },
    'claude-4-7-opus': { contextSize: 1000000, maxOutputTokens: 64000, vision: true },
    // 4.6 系列 1M 上下文需要 anthropic-beta: max-tokens-sampling-2025-06-15 header
    'claude-4-6-opus': { contextSize: 1000000, maxOutputTokens: 64000, vision: true },
    'claude-4-6-sonnet': { contextSize: 1000000, maxOutputTokens: 64000, vision: true },
    'claude-4-5-opus': { contextSize: 200000, maxOutputTokens: 64000, vision: true },
    'claude-4-5-sonnet': { contextSize: 200000, maxOutputTokens: 64000, vision: true },
    'claude-4-5-haiku': { contextSize: 200000, maxOutputTokens: 64000, vision: true },
    'claude-4-opus': { contextSize: 200000, maxOutputTokens: 64000, vision: true },
    'claude-4-sonnet': { contextSize: 200000, maxOutputTokens: 64000, vision: true },
    'claude-3-7-sonnet': { contextSize: 200000, maxOutputTokens: 64000, vision: true },
    'claude-3-5-sonnet': { contextSize: 200000, maxOutputTokens: 8192, vision: true },
    'claude-3-5-haiku': { contextSize: 200000, maxOutputTokens: 8192, vision: true },
    'claude-3-opus': { contextSize: 200000, maxOutputTokens: 4096, vision: true },
    'claude-3-sonnet': { contextSize: 200000, maxOutputTokens: 4096, vision: true },
    'claude-3-haiku': { contextSize: 200000, maxOutputTokens: 4096, vision: true },

    // ═══════════════════════════════════════════════
    // Gemini / Google
    // ═══════════════════════════════════════════════
    'gemini-3-1-flash': { contextSize: 1000000, maxOutputTokens: 65536, vision: true },
    'gemini-3-pro': { contextSize: 1048576, maxOutputTokens: 65536, vision: true },
    'gemini-3-flash': { contextSize: 1000000, maxOutputTokens: 65536, vision: true },
    'gemini-2-5-pro': { contextSize: 1048576, maxOutputTokens: 65536, vision: true },
    'gemini-2-5-flash': { contextSize: 1048576, maxOutputTokens: 65536, vision: true },
    'gemini-2-0-flash': { contextSize: 1048576, maxOutputTokens: 8192, vision: true },
    'gemini-1-5-pro': { contextSize: 2097152, maxOutputTokens: 8192, vision: true },
    'gemini-1-5-flash': { contextSize: 1048576, maxOutputTokens: 8192, vision: true },

    // ═══════════════════════════════════════════════
    // Gemma / Google
    // ═══════════════════════════════════════════════
    'gemma-4-31b-it': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'gemma-4-26b-a4b-it': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'gemma-4-12b-it': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'gemma-4-e4b-it': { contextSize: 131072, maxOutputTokens: 0, vision: true },
    'gemma-4-e2b-it': { contextSize: 131072, maxOutputTokens: 0, vision: true },

    // ═══════════════════════════════════════════════
    // DeepSeek
    // ═══════════════════════════════════════════════
    'deepseek-v4-pro': { contextSize: 1000000, maxOutputTokens: 0, vision: false },
    'deepseek-v4-flash': { contextSize: 1000000, maxOutputTokens: 0, vision: false },
    'deepseek-v4': { contextSize: 1000000, maxOutputTokens: 0, vision: false },
    'deepseek-v3-2': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'deepseek-v3-1': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'deepseek-v3': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'deepseek-r1': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'deepseek-r1-distill-qwen-7b': { contextSize: 131072, maxOutputTokens: 0 },
    'deepseek-r1-distill-qwen-32b': { contextSize: 131072, maxOutputTokens: 0 },
    'deepseek-r1-distill-llama-8b': { contextSize: 131072, maxOutputTokens: 0 },
    'deepseek-r1-distill-llama-70b': { contextSize: 131072, maxOutputTokens: 0 },

    // ═══════════════════════════════════════════════
    // Qwen / Alibaba
    // ═══════════════════════════════════════════════
    'qwen3-7-max': { contextSize: 1000000, maxOutputTokens: 0 },
    'qwen3-7-plus': { contextSize: 1000000, maxOutputTokens: 0, vision: true },
    'qwen3-6-max': { contextSize: 240000, maxOutputTokens: 0 },
    'qwen3-6-plus': { contextSize: 991000, maxOutputTokens: 0, vision: true },
    'qwen3-6-flash': { contextSize: 991000, maxOutputTokens: 0, vision: true },
    'qwen3-6-27b': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'qwen3-6-35b': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'qwen3-5-max': { contextSize: 1000000, maxOutputTokens: 0, vision: true },
    'qwen3-5-plus': { contextSize: 1000000, maxOutputTokens: 0, vision: true },
    'qwen3-5-flash': { contextSize: 1000000, maxOutputTokens: 0, vision: true },
    'qwen3-5-397b': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'qwen3-5-122b': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'qwen3-5-35b': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'qwen3-5-27b': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'qwen3-max': { contextSize: 258048, maxOutputTokens: 0 },
    'qwen3-coder-plus': { contextSize: 1000000, maxOutputTokens: 0 },
    'qwen3-coder-flash': { contextSize: 1000000, maxOutputTokens: 0 },
    'qwen3-coder-480b': { contextSize: 262144, maxOutputTokens: 0 },
    'qwen3-235b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen3-32b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen3-30b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen3-14b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen3-8b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen3-4b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen3-1-7b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen3-0-6b': { contextSize: 32768, maxOutputTokens: 0 },
    'qwen3-vl-plus': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'qwen3-vl-235b': { contextSize: 131072, maxOutputTokens: 0, vision: true },
    'qwen3-vl-30b': { contextSize: 131072, maxOutputTokens: 0, vision: true },
    'qwen3-omni-flash': { contextSize: 65536, maxOutputTokens: 0, vision: true },
    'qwen3-next-80b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen2-5-72b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen2-5-32b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen2-5-14b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen2-5-7b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen2-5-coder-32b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen2-5-coder-7b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen-vl-max': { contextSize: 0, maxOutputTokens: 0, vision: true },
    'qwen-vl-plus': { contextSize: 0, maxOutputTokens: 0, vision: true },
    'qwen2-5-vl-7b': { contextSize: 0, maxOutputTokens: 0, vision: true },
    'qwen2-5-vl-72b': { contextSize: 0, maxOutputTokens: 0, vision: true },
    'qwq-32b': { contextSize: 131072, maxOutputTokens: 0 },
    'qwen-plus': { contextSize: 1000000, maxOutputTokens: 0 },
    'qwen-flash': { contextSize: 1000000, maxOutputTokens: 0 },
    'qwen-max': { contextSize: 131072, maxOutputTokens: 0 },

    // ═══════════════════════════════════════════════
    // GLM / Zhipu
    // ═══════════════════════════════════════════════
    'glm-5-2': { contextSize: 1000000, maxOutputTokens: 0, vision: false },
    'glm-5-1': { contextSize: 202752, maxOutputTokens: 0, vision: false },
    'glm-5': { contextSize: 204800, maxOutputTokens: 0, vision: false },
    'glm-5-turbo': { contextSize: 200000, maxOutputTokens: 0, vision: false },
    'glm-5v-turbo': { contextSize: 200000, maxOutputTokens: 0, vision: true },
    'glm-4-7': { contextSize: 204800, maxOutputTokens: 0 },
    'glm-4-7-flashx': { contextSize: 200000, maxOutputTokens: 0 },
    'glm-4-6': { contextSize: 204800, maxOutputTokens: 0 },
    'glm-4-6v': { contextSize: 128000, maxOutputTokens: 0, vision: true },
    'glm-4-5': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'glm-4-5-air': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'glm-4-5-airx': { contextSize: 128000, maxOutputTokens: 0 },
    'glm-4-5-x': { contextSize: 128000, maxOutputTokens: 0 },
    'glm-4-5v': { contextSize: 64000, maxOutputTokens: 0, vision: true },
    'glm-4': { contextSize: 128000, maxOutputTokens: 0, vision: false },
    'glm-4v': { contextSize: 0, maxOutputTokens: 0, vision: true },
    'glm-4v-plus': { contextSize: 0, maxOutputTokens: 0, vision: true },
    'glm-for-coding': { contextSize: 200000, maxOutputTokens: 0 },

    // ═══════════════════════════════════════════════
    // Grok / xAI
    // ═══════════════════════════════════════════════
    'grok-4-3': { contextSize: 1000000, maxOutputTokens: 65536, vision: true },
    'grok-4-1': { contextSize: 200000, maxOutputTokens: 65536, vision: true },
    'grok-4': { contextSize: 256000, maxOutputTokens: 65536, vision: true },
    'grok-4-fast-reasoning': { contextSize: 2000000, maxOutputTokens: 65536, vision: true },
    'grok-4-fast-non-reasoning': { contextSize: 2000000, maxOutputTokens: 65536, vision: true },
    'grok-4-20': { contextSize: 2000000, maxOutputTokens: 65536, vision: true },
    'grok-code-fast-1': { contextSize: 256000, maxOutputTokens: 65536, vision: true },
    'grok-build-0-1': { contextSize: 256000, maxOutputTokens: 65536, vision: true },
    'grok-3': { contextSize: 131072, maxOutputTokens: 32768 },
    'grok-3-mini': { contextSize: 131072, maxOutputTokens: 32768 },

    // ═══════════════════════════════════════════════
    // MiniMax
    // ═══════════════════════════════════════════════
    'minimax-m3': { contextSize: 1000000, maxOutputTokens: 0, vision: true },
    'minimax-m2-7': { contextSize: 204800, maxOutputTokens: 0 },
    'minimax-m2-5': { contextSize: 204800, maxOutputTokens: 0 },
    'minimax-m2-5-highspeed': { contextSize: 204800, maxOutputTokens: 0 },
    'minimax-m2-1': { contextSize: 200000, maxOutputTokens: 0 },
    'minimax-m2': { contextSize: 200000, maxOutputTokens: 0 },
    'minimax-m1': { contextSize: 1000000, maxOutputTokens: 0 },
    'minimax-01': { contextSize: 4194304, maxOutputTokens: 0 },

    // ═══════════════════════════════════════════════
    // MiMo / Xiaomi
    // ═══════════════════════════════════════════════
    'mimo-v2-5': { contextSize: 1048576, maxOutputTokens: 131072, vision: true },
    'mimo-v2-5-pro': { contextSize: 1048576, maxOutputTokens: 131072, vision: false },

    // ═══════════════════════════════════════════════
    // Kimi / Moonshot
    // ═══════════════════════════════════════════════
    'kimi-k2-7-code': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'kimi-k2-6': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'kimi-k2-5': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'kimi-k2': { contextSize: 262144, maxOutputTokens: 0 },
    'kimi-k2-turbo': { contextSize: 262144, maxOutputTokens: 0 },
    'kimi-k2-thinking': { contextSize: 262144, maxOutputTokens: 0 },
    'moonshot-v1-8k': { contextSize: 8192, maxOutputTokens: 0 },
    'moonshot-v1-32k': { contextSize: 32768, maxOutputTokens: 0 },
    'moonshot-v1-128k': { contextSize: 131072, maxOutputTokens: 0 },

    // ═══════════════════════════════════════════════
    // Hy / Tencent-Hunyuan
    // ═══════════════════════════════════════════════
    hy3: { contextSize: 262144, maxOutputTokens: 0, vision: false },
    'hy3-fp8': { contextSize: 262144, maxOutputTokens: 0, vision: false },
    'hy3-preview': { contextSize: 262144, maxOutputTokens: 0, vision: false },

    // ═══════════════════════════════════════════════
    // Doubao / ByteDance
    // ═══════════════════════════════════════════════
    'doubao-seed-2-1-pro': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-2-1-turbo': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-2-0-pro': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-2-0-lite': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-2-0-mini': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-2-0-code': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-1-8': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-1-6': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-1-6-flash': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-1-6-thinking': { contextSize: 256000, maxOutputTokens: 0, vision: true },
    'doubao-seed-1-6-lite': { contextSize: 256000, maxOutputTokens: 0 },
    'doubao-1-5-pro-32k': { contextSize: 32768, maxOutputTokens: 0, vision: true },
    'doubao-1-5-lite-32k': { contextSize: 32768, maxOutputTokens: 0 },
    'doubao-1-5-pro-256k': { contextSize: 262144, maxOutputTokens: 0, vision: true },
    'doubao-1-5-thinking-pro': { contextSize: 131072, maxOutputTokens: 0 },
    'doubao-pro-32k': { contextSize: 32768, maxOutputTokens: 0 },
    'doubao-lite-32k': { contextSize: 32768, maxOutputTokens: 0 },
    'doubao-pro-128k': { contextSize: 131072, maxOutputTokens: 0 },
    'doubao-pro-256k': { contextSize: 262144, maxOutputTokens: 0 },

    // ═══════════════════════════════════════════════
    // Llama / Meta
    // ═══════════════════════════════════════════════
    'llama-4-scout': { contextSize: 10485760, maxOutputTokens: 0, vision: true },
    'llama-4-maverick': { contextSize: 1048576, maxOutputTokens: 0, vision: true },
    'llama-3-3-70b': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'llama-3-1-8b': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'llama-3-1-70b': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'llama-3-1-405b': { contextSize: 131072, maxOutputTokens: 0, vision: false },

    // ═══════════════════════════════════════════════
    // Mistral
    // ═══════════════════════════════════════════════
    'mistral-large': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'mistral-small': { contextSize: 131072, maxOutputTokens: 0, vision: false },
    'mistral-medium': { contextSize: 32768, maxOutputTokens: 0, vision: false },
    'mistral-7b': { contextSize: 32768, maxOutputTokens: 0, vision: false },
    'mixtral-8x7b': { contextSize: 32768, maxOutputTokens: 0, vision: false },
    'mixtral-8x22b': { contextSize: 65536, maxOutputTokens: 0, vision: false }
};

// ═══════════════════════════════════════════════
// 提取函数（兼容多种 API 格式）
// ═══════════════════════════════════════════════

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

// ═══════════════════════════════════════════════
// API 查询函数
// ═══════════════════════════════════════════════

/**
 * 尝试通过 OpenAI 兼容 API 的 /models 端点获取模型的上下文窗口大小。
 * 失败时返回 0 表示未知。
 */
export async function fetchContextSizeFromAPI(
    modelInstance: {
        base_url: string;
        api_key: string;
        model_name: string;
    } & ModelNetworkConfig
): Promise<number> {
    const { base_url: baseUrl, api_key: apiKey, model_name: modelName } = modelInstance;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const resp = await fetchModelUrl(modelInstance, `${baseUrl}/models/${encodeURIComponent(modelName)}`, {
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
        const resp = await fetchModelUrl(modelInstance, `${baseUrl}/models`, {
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
export async function fetchMaxOutputTokensFromAPI(
    modelInstance: {
        base_url: string;
        api_key: string;
        model_name: string;
    } & ModelNetworkConfig
): Promise<number> {
    const { base_url: baseUrl, api_key: apiKey, model_name: modelName } = modelInstance;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const resp = await fetchModelUrl(modelInstance, `${baseUrl}/models/${encodeURIComponent(modelName)}`, {
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
        const resp = await fetchModelUrl(modelInstance, `${baseUrl}/models`, {
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
export async function fetchVisionSupportFromAPI(
    modelInstance: {
        base_url: string;
        api_key: string;
        model_name: string;
    } & ModelNetworkConfig
): Promise<boolean | undefined> {
    const { base_url: baseUrl, api_key: apiKey, model_name: modelName } = modelInstance;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const resp = await fetchModelUrl(modelInstance, `${baseUrl}/models/${encodeURIComponent(modelName)}`, {
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
        const resp = await fetchModelUrl(modelInstance, `${baseUrl}/models`, {
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

// ═══════════════════════════════════════════════
// 名称标准化与匹配辅助
// ═══════════════════════════════════════════════

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

// ═══════════════════════════════════════════════
// 统一的模型信息查找
// ═══════════════════════════════════════════════

/**
 * 在 KNOWN_MODELS 表中查找模型信息。
 *
 * 匹配策略（按优先级）：
 *   1. 去前缀 + 标准化后精确匹配
 *   2. 再逐步去掉日期/变体后缀匹配
 *   3. 前缀匹配：key 是 base 的前缀 → 输入比 key 更具体，取最长 key（最精确匹配）
 *   4. 反向前缀匹配：base 是 key 的前缀 → 输入太短/模糊，保守取 contextSize 最小的
 *
 * 前缀匹配（step 3）与反向前缀匹配（step 4）使用不同策略：
 * - 前缀匹配中 key 越长约精确，应优先选择；
 * - 反向前缀匹配中多个 key 都可能匹配同一个短输入，保守兜底。
 */
function lookupModelInfo(rawModelName: string): ModelInfo | undefined {
    const base = normalize(stripProviderPrefix(rawModelName));
    const candidates = stripSuffixes(base);

    for (const c of candidates) {
        if (KNOWN_MODELS[c] !== undefined) return KNOWN_MODELS[c];
    }

    // 前缀匹配：key 是 base 的前缀 → 输入比 key 更具体，取最长 key（最精确匹配）
    let bestLen = 0;
    let bestInfo: ModelInfo | undefined = undefined;
    for (const [key, info] of Object.entries(KNOWN_MODELS)) {
        if (base.startsWith(key) && info.contextSize > 0 && key.length > bestLen) {
            bestLen = key.length;
            bestInfo = info;
        }
    }
    if (bestInfo) return bestInfo;

    // 反向前缀匹配：base（或其去后缀版本）是 key 的前缀 → 输入太短/模糊，
    // 多个 key 都可能匹配，保守取 contextSize 最小的，避免高估模型能力。
    for (const c of candidates) {
        let rBestInfo: ModelInfo | undefined = undefined;
        let rBestSize = Infinity;
        for (const [key, info] of Object.entries(KNOWN_MODELS)) {
            if (key.startsWith(c) && info.contextSize > 0 && info.contextSize < rBestSize) {
                rBestSize = info.contextSize;
                rBestInfo = info;
            }
        }
        if (rBestInfo) return rBestInfo;
    }

    return undefined;
}

/**
 * 在 KNOWN_MODELS 表中查找模型的上下文窗口大小。
 * 匹配策略与 lookupModelInfo 保持一致。
 */
export function lookupKnownContextSize(rawModelName: string): number {
    return lookupModelInfo(rawModelName)?.contextSize ?? 0;
}

/**
 * 在 KNOWN_MODELS 表中查找模型的最大输出 token 上限。
 * 匹配策略与 lookupModelInfo 保持一致。
 */
export function lookupKnownMaxOutputTokens(rawModelName: string): number {
    return lookupModelInfo(rawModelName)?.maxOutputTokens ?? 0;
}

/**
 * 在 KNOWN_MODELS 表中查找模型是否支持视觉输入。
 * 匹配策略与 lookupModelInfo 保持一致。
 */
export function lookupKnownVisionSupport(rawModelName: string): boolean | undefined {
    return lookupModelInfo(rawModelName)?.vision;
}
