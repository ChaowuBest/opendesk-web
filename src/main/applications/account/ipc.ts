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

export function registerAccountAPIHandlers(deps: AccountIpcDependencies): void {
    const { ipc, runtime, publishSessionChanged } = deps;
    const service = runtime.getService();

    ipc.handle('account:getConfig', () => ok(runtime.config.get()));
    ipc.handle('account:configure', (_event, patch: Partial<AccountConfig>) => ok(runtime.config.configure(patch)));
    ipc.handle('account:isSetupComplete', () => ok(runtime.config.isSetupComplete()));
    ipc.handle('account:isAvailable', (_event, kind: AccountKind) => ok(runtime.config.isAvailable(kind)));
    ipc.handle('account:getSession', () => ok(service.getSession()));

    ipc.handle('account:getUserInfo', async () => {
        try {
            return ok(await service.getUserInfo());
        } catch (error) {
            return failure(error);
        }
    });

    ipc.handle('account:login', async (_event, kind: AccountKind, username: string, password: string) => {
        try {
            const session = await service.login(kind, username, password);
            publishSessionChanged(session);
            return ok(session);
        } catch (error) {
            return failure(error);
        }
    });

    ipc.handle('account:updateDisplayName', async (_event, displayName: string) => {
        try {
            const user = await service.updateDisplayName(displayName);
            publishSessionChanged(service.getSession());
            return ok(user);
        } catch (error) {
            return failure(error);
        }
    });

    ipc.handle('account:refreshToken', async () => {
        try {
            const session = await service.refreshToken();
            publishSessionChanged(session);
            return ok(session);
        } catch (error) {
            return failure(error);
        }
    });

    ipc.handle('account:logout', async () => {
        try {
            await service.logout();
            publishSessionChanged(null);
            return ok(null);
        } catch (error) {
            return failure(error);
        }
    });
}
