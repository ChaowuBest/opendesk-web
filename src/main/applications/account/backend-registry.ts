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

import type { PluginAccountBackend, PluginAccountKind } from '../../../../packages/plugin-sdk/src/index.js';

interface BackendEntry {
    ownerId: string;
    backend: PluginAccountBackend;
}

export class AccountBackendRegistry {
    private backendEntry: BackendEntry | undefined;
    private readonly changeListeners = new Set<() => void>();

    /** 订阅后端集合变化（注册/注销），用于宿主向 renderer 推送会话状态。 */
    onBackendsChanged(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    }

    register(ownerId: string, backend: PluginAccountBackend): () => void {
        if (!backend.id.trim() || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(backend.id)) {
            throw new Error(`account:backend_invalid_id:${backend.id}`);
        }
        if (backend.kinds.length === 0 || backend.kinds.some((kind) => kind !== 'personal' && kind !== 'enterprise')) {
            throw new Error(`account:backend_invalid_kinds:${backend.id}`);
        }
        const methods = [
            backend.initialize,
            backend.getSession,
            backend.getUserInfo,
            backend.getLoginMethods,
            backend.createLoginFlow,
            backend.updateDisplayName,
            backend.refreshToken,
            backend.logout
        ];
        if (methods.some((method) => typeof method !== 'function')) {
            throw new Error(`account:backend_invalid_implementation:${backend.id}`);
        }
        // 可选能力：声明了就必须是函数，避免宿主在调用点才发现类型错误。
        if (backend.getCredential !== undefined && typeof backend.getCredential !== 'function') {
            throw new Error(`account:backend_invalid_implementation:${backend.id}`);
        }
        if (this.backendEntry) throw new Error(`account:backend_already_registered:${this.backendEntry.backend.id}`);
        const entry = { ownerId, backend };
        this.backendEntry = entry;
        this.notifyChange();
        return () => {
            if (this.backendEntry !== entry) return;
            this.backendEntry = undefined;
            this.notifyChange();
        };
    }

    /**
     * 当前宿主只允许一个账号后端；按账号类型确认该后端是否支持目标场景。
     */
    resolve(kind: PluginAccountKind): PluginAccountBackend | undefined {
        const backend = this.backendEntry?.backend;
        return backend?.kinds.includes(kind) ? backend : undefined;
    }

    /** 未指定账号类型（会话恢复等场景）时使用当前唯一后端。 */
    getDefault(): PluginAccountBackend | undefined {
        return this.backendEntry?.backend;
    }

    get(id: string): PluginAccountBackend | undefined {
        return this.backendEntry?.backend.id === id ? this.backendEntry.backend : undefined;
    }

    private notifyChange(): void {
        for (const listener of [...this.changeListeners]) {
            try {
                listener();
            } catch {
                // 监听器异常不影响注册流程
            }
        }
    }
}

export const accountBackendRegistry = new AccountBackendRegistry();
