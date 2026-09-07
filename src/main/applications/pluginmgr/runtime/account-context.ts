/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type {
    PluginAccountBackend,
    PluginCapability,
    PluginContext,
    PluginRegistration
} from '../../../../../packages/plugin-sdk/src/index.js';
import { accountBackendRegistry } from '../../account/backend-registry.js';
import { AccountTokenStore } from '../../account/token-store.js';
import { getPlatform } from '../../../../platforms/base.js';
import { HostRegistration } from './registration.js';

export interface AccountsContextOptions {
    pluginId: string;
    addCapability: (capability: PluginCapability) => void;
    track: (registration: PluginRegistration) => PluginRegistration;
}

/**
 * 组装 `account` capability 提供给插件的上下文：
 * 网络与外链经由宿主平台，凭据存储按插件 id 隔离，后端注册进全局 registry。
 */
export function createAccountsContext(options: AccountsContextOptions): PluginContext['accounts'] {
    const secrets = new AccountTokenStore(options.pluginId);
    const requireAccountCapability = (): void => options.addCapability('account');
    return {
        network: {
            fetch: (input, init) => {
                requireAccountCapability();
                return getPlatform().fetch(input, init);
            }
        },
        auth: {
            openExternal: async (url) => {
                requireAccountCapability();
                const parsed = new URL(url);
                if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                    throw new Error(`account:auth_invalid_external_url:${parsed.protocol}`);
                }
                await getPlatform().openExternal(parsed.toString());
            }
        },
        secrets: {
            load: () => {
                requireAccountCapability();
                return secrets.load();
            },
            save: (value) => {
                requireAccountCapability();
                secrets.save(value);
            },
            clear: () => {
                requireAccountCapability();
                secrets.clear();
            }
        },
        registerBackend: (backend: PluginAccountBackend) => {
            requireAccountCapability();
            const dispose = accountBackendRegistry.register(options.pluginId, backend);
            return options.track(new HostRegistration(dispose));
        }
    };
}
