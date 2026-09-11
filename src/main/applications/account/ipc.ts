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

import type { AccountRuntime } from './runtime.js';
import type { AccountConfig, AccountKind, AccountSession } from './types.js';

type IpcHandler = (event: unknown, ...args: any[]) => unknown;

export interface AccountIpcRegistrar {
    handle(channel: string, handler: IpcHandler): void;
}

export interface AccountIpcDependencies {
    ipc: AccountIpcRegistrar;
    runtime: AccountRuntime;
    publishSessionChanged(session: AccountSession | null): void;
}

function ok(data: unknown) {
    return { status: 'ok', data };
}

function failure(error: unknown) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
}

/**
 * 统一所有 account IPC handler 的返回契约：成功返回 {status:'ok',data}，
 * 失败（含账号后端尚未注册的启动窗口期）返回 {status:'error',message}，
 * 保证 renderer 拿到一致的错误形状而不是裸的 handler 异常。
 */
function wrap<Result>(handler: (...args: any[]) => Result): IpcHandler {
    return async (_event, ...args: any[]) => {
        try {
            return ok(await handler(...args));
        } catch (error) {
            return failure(error);
        }
    };
}

export function registerAccountAPIHandlers(deps: AccountIpcDependencies): void {
    const { ipc, runtime, publishSessionChanged } = deps;
    const service = runtime.getService();

    ipc.handle(
        'account:getConfig',
        wrap(() => runtime.config.get())
    );
    ipc.handle(
        'account:configure',
        wrap((patch: Partial<AccountConfig>) => runtime.config.configure(patch))
    );
    ipc.handle(
        'account:isSetupComplete',
        wrap(() => runtime.config.isSetupComplete())
    );
    ipc.handle(
        'account:isAvailable',
        wrap((kind: AccountKind) => runtime.config.isAvailable(kind))
    );
    ipc.handle(
        'account:getSession',
        wrap(() => service.getSession())
    );
    ipc.handle(
        'account:getLoginMethods',
        wrap(async (kind: AccountKind) => await service.getLoginMethods(kind))
    );
    ipc.handle(
        'account:startLogin',
        wrap(async (kind: AccountKind, methodId: string) => await service.startLogin(kind, methodId))
    );
    ipc.handle(
        'account:submitLogin',
        wrap(async (flowId: string, values: Record<string, string>) => {
            const state = await service.submitLogin(flowId, values);
            if (state.status === 'completed') publishSessionChanged(state.session);
            return state;
        })
    );
    ipc.handle(
        'account:pollLogin',
        wrap(async (flowId: string) => {
            const state = await service.pollLogin(flowId);
            if (state.status === 'completed') publishSessionChanged(state.session);
            return state;
        })
    );
    ipc.handle(
        'account:cancelLogin',
        wrap(async (flowId: string) => {
            await service.cancelLogin(flowId);
            return null;
        })
    );
    ipc.handle(
        'account:getUserInfo',
        wrap(async () => await service.getUserInfo())
    );
    ipc.handle(
        'account:updateDisplayName',
        wrap(async (displayName: string) => {
            const user = await service.updateDisplayName(displayName);
            publishSessionChanged(service.getSession());
            return user;
        })
    );
    ipc.handle(
        'account:refreshToken',
        wrap(async () => {
            const session = await service.refreshToken();
            publishSessionChanged(session);
            return session;
        })
    );
    ipc.handle(
        'account:logout',
        wrap(async () => {
            await service.logout();
            publishSessionChanged(null);
            return null;
        })
    );
}
