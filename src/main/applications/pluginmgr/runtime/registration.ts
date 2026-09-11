/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type { PluginRegistration } from '../../../../../packages/plugin-sdk/src/index.js';

/** 插件注册凭据：dispose 幂等，供 PluginHost 在停用/出错时回滚已注册的贡献。 */
export class HostRegistration implements PluginRegistration {
    private disposed = false;

    constructor(private readonly disposeCallback: () => void | Promise<void>) {}

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        await this.disposeCallback();
    }
}
