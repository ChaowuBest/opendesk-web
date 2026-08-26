/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * browser capability 的纯逻辑：URL 前缀归一化、匹配与 hint 校验。
 *
 * 这些函数不依赖 PluginHost 状态，便于单独测试与复用。
 */

import type { BrowserHint } from '../../../../../packages/plugin-sdk/src/index.js';

/**
 * 去掉地址中的协议部分（`https://`、`//` 等），并去除结尾多余的 `/`。
 *
 * 插件声明的 urlPrefix 与页面地址都经过该归一化后再比较，
 * 因此 `https://www.bing.com`、`//www.bing.com`、`www.bing.com` 等价。
 */
export function normalizeHintAddress(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const withoutProtocol = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
    return withoutProtocol.replace(/\/+$/, '');
}

/** 判断页面地址是否命中插件声明的 urlPrefix（均按 normalizeHintAddress 归一化后做前缀匹配） */
export function matchesHintUrlPrefix(address: string, urlPrefix: string): boolean {
    const prefix = normalizeHintAddress(urlPrefix);
    if (!prefix) return false;
    return normalizeHintAddress(address).startsWith(prefix);
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
