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
 * renderer 侧账号登录工具：登录状态机实现在 `src/common/account/login-flow.ts`，
 * 本模块只补齐 renderer 差异——accountAPI 经 preload 暴露且方法可选（需收窄）、
 * 默认语言取自 document/navigator、错误码 key 采用 renderer 的 camelCase 约定。
 * 账号面板与设置向导共享这里的类型与驱动，不再各自实现轮询状态机。
 */

import {
    ACCOUNT_LOGIN_POLL_INTERVAL_MS,
    ACCOUNT_LOGIN_TIMEOUT_MS,
    describeAccountError as describeAccountErrorWithKeys,
    describeLoginFlowStatus,
    resolveLocalizedText as resolveLocalizedTextWithLocale,
    runAccountLoginFlow as runAccountLoginFlowCore,
    type AccountErrorKeyResolver,
    type AccountLoginField,
    type AccountLoginFlowStartResult,
    type AccountLoginFlowState,
    type AccountLoginFlowTransport,
    type AccountLoginMethod,
    type AccountSession,
    type AccountUser,
    type LocalizedText
} from '../../common/account/login-flow.js';

export type {
    AccountLoginField,
    AccountLoginFlowState,
    AccountLoginFlowStartResult,
    AccountLoginMethod,
    AccountSession,
    AccountUser,
    LocalizedText
};
export { ACCOUNT_LOGIN_POLL_INTERVAL_MS, ACCOUNT_LOGIN_TIMEOUT_MS, describeLoginFlowStatus };

export interface AccountConfig {
    mode: 'personal' | 'enterprise' | 'nologin';
    default_base_url: string;
    enterprise_base_url: string;
}

/** preload 暴露的 accountAPI 形状（方法可能随宿主版本演进，故全部可选）。 */
export interface AccountApi {
    getConfig?(): Promise<AccountConfig>;
    configure?(patch: Partial<AccountConfig>): Promise<unknown>;
    isSetupComplete?(): Promise<boolean>;
    isAvailable?(kind: 'personal' | 'enterprise'): Promise<boolean>;
    getSession?(): Promise<AccountSession | null>;
    getUserInfo?(): Promise<AccountUser | null>;
    getLoginMethods?(kind: 'personal' | 'enterprise'): Promise<AccountLoginMethod[]>;
    startLogin?(kind: 'personal' | 'enterprise', methodId: string): Promise<AccountLoginFlowStartResult>;
    submitLogin?(flowId: string, values: Record<string, string>): Promise<AccountLoginFlowState>;
    pollLogin?(flowId: string): Promise<AccountLoginFlowState>;
    cancelLogin?(flowId: string): Promise<unknown>;
    updateDisplayName?(displayName: string): Promise<unknown>;
    refreshToken?(): Promise<unknown>;
    logout?(): Promise<unknown>;
    onSessionChanged?(callback: (session: AccountSession | null) => void): () => void;
}

export function getAccountApi(): AccountApi | undefined {
    return (globalThis as { accountAPI?: AccountApi }).accountAPI;
}

/** 渲染进程默认语言：document/navigator 缺失（如纯逻辑测试）时回退英文。 */
function defaultRendererLocale(): string {
    if (typeof document !== 'undefined' && document.documentElement?.lang) return document.documentElement.lang;
    if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
    return 'en';
}

/** 将插件声明的多语言文本解析为当前语言的字符串。 */
export function resolveLocalizedText(value: LocalizedText | undefined, locale?: string): string {
    return resolveLocalizedTextWithLocale(value, locale ?? defaultRendererLocale());
}

type Translator = (key: string, params?: Record<string, string | number>) => string;

/** renderer 错误码 key 约定：`renderer.account.errors.<camelCase>`。 */
const resolveRendererErrorKey: AccountErrorKeyResolver = (name) =>
    `renderer.account.errors.${name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`;

/** 把宿主/插件抛出的错误转换为面向用户的本地化文案。 */
export function describeAccountError(error: unknown, translate: Translator): string {
    return describeAccountErrorWithKeys(error, translate, resolveRendererErrorKey);
}

/** 统一 GUI 登录失败的展示形状：`<前缀>：<原因>`。 */
export function formatAccountLoginError(error: unknown, translate: Translator, prefix: string): string {
    return `${prefix}：${describeAccountError(error, translate)}`;
}

export interface AccountLoginFlowOptions {
    api: AccountApi;
    kind: 'personal' | 'enterprise';
    method: AccountLoginMethod;
    /** form 方式的字段值；由调用方完成必填校验。 */
    values?: Record<string, string>;
    /** 等待态回调（设备码 / 浏览器跳转 / 插件自定义等待文案）。 */
    onStatus?: (message: string | undefined) => void;
    onFlowStarted?: (flowId: string) => void;
    /** 覆盖默认语言解析（未提供时按 document/navigator 推断）。 */
    resolveText?: (value: LocalizedText | undefined) => string;
    now?: () => number;
    delay?: (ms: number) => Promise<void>;
}

/** 将可选的 accountAPI 收窄为登录流传输面。 */
function toTransport(api: AccountApi): AccountLoginFlowTransport {
    if (!api.startLogin || !api.pollLogin) {
        throw new Error('account:backend_unavailable');
    }
    return {
        startLogin: (kind, methodId) => api.startLogin!(kind, methodId),
        submitLogin: (flowId, values) => {
            if (!api.submitLogin) throw new Error('account:login_flow_not_submittable');
            return api.submitLogin(flowId, values);
        },
        pollLogin: (flowId) => api.pollLogin!(flowId),
        cancelLogin: (flowId) => api.cancelLogin?.(flowId) ?? Promise.resolve()
    };
}

/**
 * 驱动一次完整登录（状态机见 common 核心）：
 * - form 方法：提交字段值后返回；
 * - browser / device-code 方法：轮询直到 completed / failed，超时抛出。
 * 成功时返回公开会话（不含 token）。
 */
export async function runAccountLoginFlow(options: AccountLoginFlowOptions): Promise<AccountSession> {
    const { api, kind, method } = options;
    return runAccountLoginFlowCore({
        transport: toTransport(api),
        kind,
        method,
        values: options.values,
        onState: (_state, statusText) => {
            if (statusText !== undefined) options.onStatus?.(statusText);
        },
        onFlowStarted: options.onFlowStarted,
        resolveText: (value) => options.resolveText?.(value) ?? resolveLocalizedText(value),
        now: options.now,
        delay: options.delay
    });
}
