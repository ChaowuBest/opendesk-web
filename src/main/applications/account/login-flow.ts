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

import {
    ACCOUNT_LOGIN_POLL_INTERVAL_MS,
    ACCOUNT_LOGIN_TIMEOUT_MS,
    describeAccountError,
    runAccountLoginFlow as runAccountLoginFlowCore,
    type AccountLoginField
} from '../../../common/account/login-flow.js';
import type { PluginAccountLoginMethod, PluginDisplayName } from '../../../../packages/plugin-sdk/src/index.js';
import { t } from '../../../locale/index.js';
import type { AccountService } from './service.js';
import type { AccountKind, AccountSession } from './types.js';

export type LoginFlowService = Pick<AccountService, 'startLogin' | 'submitLogin' | 'pollLogin' | 'cancelLogin'>;

export { ACCOUNT_LOGIN_POLL_INTERVAL_MS as LOGIN_FLOW_POLL_INTERVAL_MS };
export { ACCOUNT_LOGIN_TIMEOUT_MS as LOGIN_FLOW_TIMEOUT_MS };

/**
 * 登录流的终端 IO 抽象：CLI 用 readline 实现，交互式 TUI 用输入区 prompt 实现。
 * 文案解析交给调用方（resolveText），驱动器本身不依赖具体语言环境。
 */
export interface LoginFlowIo {
    resolveText(displayName: PluginDisplayName | undefined): string;
    promptText(label: string): Promise<string>;
    promptSecret(label: string): Promise<string>;
    showStatus(message: string): void;
    delay(ms: number): Promise<void>;
    now(): number;
}

/**
 * 以方法驱动的方式完成一次账号登录：状态机在 `src/common/account/login-flow.ts`
 * 中实现，本适配器只补齐终端差异——
 * - form 方法：按插件声明的字段逐项收集输入（password 类型走密文输入）后 submit；
 * - browser / device-code 方法：展示状态并轮询，直到 completed / failed。
 * 驱动器不感知任何具体登录方式（如用户名/密码），全部信息来自插件。
 */
export async function runLoginFlow(
    service: LoginFlowService,
    kind: AccountKind,
    method: PluginAccountLoginMethod,
    io: LoginFlowIo
): Promise<AccountSession> {
    return runAccountLoginFlowCore({
        transport: service,
        kind,
        method,
        collectValues: (fields) => collectFormValues(fields, io),
        onState: (_state, statusText) => {
            if (statusText !== undefined) io.showStatus(statusText);
        },
        resolveText: (value) => io.resolveText(value),
        now: () => io.now(),
        delay: (ms) => io.delay(ms)
    });
}

/** 将驱动器抛出的错误映射为本地化文案，其余原样透出。 */
export function describeLoginError(error: unknown): string {
    return describeAccountError(error, t, (name) =>
        name === 'field_required' ? 'cli.account.field_required' : `cli.account.errors.${name}`
    );
}

async function collectFormValues(
    fields: readonly AccountLoginField[],
    io: LoginFlowIo
): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const field of fields) {
        const label = io.resolveText(field.label) || field.id;
        const value = field.type === 'password' ? await io.promptSecret(label) : await io.promptText(label);
        if (field.required && !value.trim()) throw new Error(`account:field_required:${label}`);
        values[field.id] = value;
    }
    return values;
}
