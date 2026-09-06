/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * browser capability 的纯逻辑：URL 匹配模式编译与 hint 校验。
 *
 * 这些函数不依赖 PluginHost 状态，便于单独测试与复用。
 */

import type { BrowserHint } from '../../../../../packages/plugin-sdk/src/index.js';

/**
 * 去掉地址中的协议部分（`https://`、`//` 等），并去除结尾多余的 `/`。
 *
 * 插件声明的 pattern 与页面地址都经过该归一化后再比较，
 * 因此 `https://www.bing.com`、`//www.bing.com`、`www.bing.com` 等价。
 */
export function normalizeHintAddress(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const withoutProtocol = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
    return withoutProtocol.replace(/\/+$/, '');
}

/** 编译后的地址匹配规则：注册时构造一次，快照期间反复复用 */
export interface CompiledHintPattern {
    /** 展示用原始 pattern（归一化字符串或 RegExp 字面量形式，如 `/^a.+$/gi`） */
    readonly display: string;
    /** 判断页面地址（含协议与否均可）是否命中该 pattern */
    matches(address: string): boolean;
}

/** 把通配符 pattern 转为正则源码：`**` 跨段、`*` 匹配单段，其余字符按字面转义 */
function globToRegExpSource(glob: string): string {
    let source = '';
    for (let i = 0; i < glob.length; ) {
        if (glob.startsWith('/**/', i)) {
            // 中段的 `/**/` 允许 `**` 匹配零段：`docs/**/search` 命中 `docs/search`
            source += '(?:/.*)?/';
            i += 4;
        } else if (glob.startsWith('**', i)) {
            source += '.*';
            i += 2;
        } else if (glob[i] === '*') {
            source += '[^/]*';
            i += 1;
        } else {
            source += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            i += 1;
        }
    }
    return source;
}

/** 前缀命中要求边界字符为段边界（/ ? # 或串尾），避免 `a.com` 误命中 `a.com.evil.com` */
function matchesPrefix(address: string, prefix: string): boolean {
    if (!address.startsWith(prefix)) return false;
    const next = address[prefix.length];
    return next === undefined || next === '/' || next === '?' || next === '#';
}

/**
 * 把插件声明的地址 pattern 编译为可复用的匹配器。
 *
 * - 字符串不含 `*`：按前缀匹配，前缀需结束在 `/`、`?`、`#` 或地址末尾的边界上；
 * - 字符串含 `*`：按通配符整体匹配路径，`*` 匹配单段（不含 `/`），`**` 跨段，
 *   query 与 hash 不参与匹配；
 * - RegExp：对去掉协议后的完整地址（含 query）做正则匹配，g/y 标志会被剥离以免
 *   `lastIndex` 在多次快照间残留。
 *
 * 归一化后为空（或传入非法类型）时抛 `plugin.browser_hint_url_prefix_invalid`，
 * 由 register 阶段捕获并计入插件诊断。
 */
export function compileHintPattern(pattern: string | RegExp): CompiledHintPattern {
    if (pattern instanceof RegExp) {
        const matcher = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
        return {
            display: String(pattern),
            matches: (address) => matcher.test(normalizeHintAddress(address))
        };
    }
    const normalized = normalizeHintAddress(typeof pattern === 'string' ? pattern : '');
    if (!normalized) throw new Error('plugin.browser_hint_url_prefix_invalid');
    if (normalized.includes('*')) {
        const matcher = new RegExp(`^${globToRegExpSource(normalized)}(?=$|[?#])`);
        return {
            display: normalized,
            matches: (address) => matcher.test(normalizeHintAddress(address))
        };
    }
    return {
        display: normalized,
        matches: (address) => matchesPrefix(normalizeHintAddress(address), normalized)
    };
}

/** 校验生成器返回的单个 hint，非法结构直接抛错并计入插件诊断 */
export function validateBrowserHint(hint: unknown): asserts hint is BrowserHint {
    if (!hint || typeof hint !== 'object') throw new Error('plugin.browser_hint_invalid');
    const candidate = hint as Record<string, unknown>;
    if (candidate.kind === 'text') {
        if (typeof candidate.content !== 'string' || !candidate.content.trim()) {
            throw new Error('plugin.browser_hint_text_content_invalid');
        }
        return;
    }
    if (candidate.kind === 'action') {
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        if (!name || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name)) {
            throw new Error('plugin.browser_hint_action_name_invalid');
        }
        if (typeof candidate.description !== 'string' || !candidate.description.trim()) {
            throw new Error(`plugin.browser_hint_action_description_invalid:${name}`);
        }
        if (typeof candidate.functionStr !== 'string' || !candidate.functionStr.trim()) {
            throw new Error(`plugin.browser_hint_action_function_invalid:${name}`);
        }
        if (
            candidate.args !== undefined &&
            (!candidate.args ||
                typeof candidate.args !== 'object' ||
                Array.isArray(candidate.args) ||
                Object.values(candidate.args).some((value) => typeof value !== 'string'))
        ) {
            throw new Error(`plugin.browser_hint_action_args_invalid:${name}`);
        }
        return;
    }
    throw new Error('plugin.browser_hint_kind_invalid');
}
