/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 账号登录流核心驱动（无宿主依赖，主进程与 renderer 共用）。
 *
 * 统一实现 start → submit（表单）→ poll（浏览器/设备码）→ completed/failed
 * 的状态机与超时策略；各端（CLI / TUI / GUI 面板 / 向导）只提供：
 * - transport：startLogin / submitLogin / pollLogin 三个方法（主进程是
 *   AccountService，renderer 是经 preload 的 accountAPI，签名一致）；
 * - 字段值来源：GUI 在调用前已收集好（values），终端逐字段询问（collectValues）；
 * - 状态展示与文本解析回调（onState / resolveText）。
 */

export type LocalizedText = string | Record<string, string>;

export interface AccountUser {
    id: string;
    username: string;
    email?: string;
    display_name?: string;
    avatar_url?: string;
}

export interface AccountSession {
    backendId: string;
    kind: 'personal' | 'enterprise';
    baseUrl: string;
    user: AccountUser;
}

export interface AccountLoginField {
    id: string;
    type: 'text' | 'password' | 'email';
    label: LocalizedText;
    placeholder?: LocalizedText;
    autocomplete?: string;
    required?: boolean;
}

export type AccountLoginMethod =
    | { id: string; type: 'form'; displayName: LocalizedText; fields: readonly AccountLoginField[] }
    | { id: string; type: 'browser' | 'device-code'; displayName: LocalizedText };

export type AccountLoginFlowState =
    | { status: 'ready' }
    | { status: 'waiting'; message?: LocalizedText }
    | { status: 'opening-browser'; url: string }
    | { status: 'device-code'; code: string; verificationUrl: string }
    | { status: 'completed'; session: unknown }
    | { status: 'failed'; errorCode: string };

export interface AccountLoginFlowStartResult {
    flowId: string;
    state: AccountLoginFlowState;
}

/** 登录流传输面：主进程 AccountService 与 renderer accountAPI 的公共签名。 */
export interface AccountLoginFlowTransport {
    startLogin(kind: 'personal' | 'enterprise', methodId: string): Promise<AccountLoginFlowStartResult>;
    submitLogin(flowId: string, values: Readonly<Record<string, string>>): Promise<AccountLoginFlowState>;
    pollLogin(flowId: string): Promise<AccountLoginFlowState>;
    cancelLogin?(flowId: string): Promise<unknown>;
}

export const ACCOUNT_LOGIN_POLL_INTERVAL_MS = 1000;
export const ACCOUNT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

type Translator = (key: string, params?: Record<string, string | number>) => string;

/** 将插件声明的多语言文本解析为指定语言的字符串。 */
export function resolveLocalizedText(value: LocalizedText | undefined, locale: string): string {
    if (typeof value === 'string') return value;
    if (!value) return '';
    const exact = value[locale];
    if (exact) return exact;
    const language = locale.split('-')[0]?.toLowerCase();
    const matched = Object.entries(value).find(([key]) => key.split('-')[0]?.toLowerCase() === language);
    return matched?.[1] ?? Object.values(value)[0] ?? '';
}

/** 将登录流的中间状态转换为用户可读的等待文案；无可展示内容时返回 undefined。 */
export function describeLoginFlowStatus(
    state: AccountLoginFlowState,
    resolveText: (value: LocalizedText | undefined) => string
): string | undefined {
    if (state.status === 'device-code') {
        return `${state.code} · ${state.verificationUrl}`;
    }
    if (state.status === 'waiting') {
        return state.message ? resolveText(state.message) : undefined;
    }
    if (state.status === 'opening-browser') {
        return state.url;
    }
    return undefined;
}

/**
 * `account:<name>[:<detail>]` 错误码到本地化 key 的解析器。
 * 各端 key 命名约定不同（CLI snake_case、GUI camelCase），由调用方提供映射。
 */
export type AccountErrorKeyResolver = (name: string) => string;

/** 把宿主/插件抛出的错误转换为面向用户的本地化文案，未知错误码原样透出。 */
export function describeAccountError(
    error: unknown,
    translate: Translator,
    resolveKey: AccountErrorKeyResolver
): string {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('account:')) return message;
    const rest = message.slice('account:'.length);
    const separator = rest.indexOf(':');
    const name = separator === -1 ? rest : rest.slice(0, separator);
    const detail = separator === -1 ? undefined : rest.slice(separator + 1);
    const key = resolveKey(name);
    // field_required 文案使用 ${field} 占位，其余使用 ${detail}；多余参数会被忽略
    const translated = translate(key, detail !== undefined ? { detail, field: detail } : undefined);
    return translated === key ? message : translated;
}

export interface AccountLoginFlowOptions {
    transport: AccountLoginFlowTransport;
    kind: 'personal' | 'enterprise';
    method: AccountLoginMethod;
    /** 表单字段值（GUI：表单已在页面上收集完成）。 */
    values?: Record<string, string>;
    /** 表单字段值收集器（终端：按插件声明逐字段询问）。 */
    collectValues?: (fields: readonly AccountLoginField[]) => Promise<Record<string, string>>;
    /** 状态回调：statusText 为可展示的等待文案（设备码/浏览器跳转/插件自定义），无则 undefined。 */
    onState?: (state: AccountLoginFlowState, statusText: string | undefined) => void;
    onFlowStarted?: (flowId: string) => void;
    resolveText?: (value: LocalizedText | undefined) => string;
    now?: () => number;
    delay?: (ms: number) => Promise<void>;
}

/**
 * 驱动一次完整登录：
 * - form 方法：提交字段值后返回；
 * - browser / device-code 方法：轮询直到 completed / failed，超时抛出
 *   `account:login_timeout`，失败抛出插件错误码。
 * 成功时返回公开会话（不含 token）。
 */
export async function runAccountLoginFlow(options: AccountLoginFlowOptions): Promise<AccountSession> {
    const { transport, kind, method } = options;
    const started = await transport.startLogin(kind, method.id);
    const flowId = started.flowId;
    options.onFlowStarted?.(flowId);
    let state = started.state;
    try {
        if (method.type === 'form' && state.status === 'ready') {
            const values =
                options.values ?? (options.collectValues ? await options.collectValues(method.fields) : undefined);
            state = await transport.submitLogin(flowId, values ?? {});
        }
        const now = options.now ?? Date.now;
        const delay = options.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        const resolveText = options.resolveText ?? ((value) => resolveLocalizedText(value, 'en'));
        const deadline = now() + ACCOUNT_LOGIN_TIMEOUT_MS;
        while (state.status !== 'completed' && state.status !== 'failed') {
            options.onState?.(state, describeLoginFlowStatus(state, resolveText));
            if (now() >= deadline) throw new Error('account:login_timeout');
            await delay(ACCOUNT_LOGIN_POLL_INTERVAL_MS);
            state = await transport.pollLogin(flowId);
        }
        if (state.status === 'failed') throw new Error(state.errorCode);
        return state.session as AccountSession;
    } catch (error) {
        if (state.status !== 'completed' && state.status !== 'failed') {
            try {
                await transport.cancelLogin?.(flowId);
            } catch {
                // Preserve the original login error when cleanup fails.
            }
        }
        throw error;
    }
}
