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

import { Hono } from 'hono';
import { Setting } from '../../utils/setting.js';
import { toOpenCodeProvider } from '../config-compat.js';

/**
 * Provider 路由。
 * 对应 opencode 的 /provider/* 端点。
 */
export function ProviderRoutes() {
    const app = new Hono();

    // GET /provider - 列出所有 providers
    app.get('/', (c) => {
        const setting = Setting.getInstance();
        const data = setting.getData();

        const providers = (data.providers || []).map((provider) => toOpenCodeProvider(provider, data.models || []));

        const defaults: Record<string, string> = {};
        if (data.default_model) {
            const defaultModel = (data.models || []).find((m: any) => m.alias === data.default_model);
            if (defaultModel) {
                defaults[defaultModel.provider_name] = defaultModel.alias;
            }
        }

        // 判断连接状态 - 有 api_key 即视为已连接
        const connected = (data.providers || []).filter((p: any) => p.api_key).map((p: any) => p.name);

        return c.json({
            all: providers,
            default: defaults,
            connected
        });
    });

    // GET /provider/auth - 获取认证方法（{ [providerID]: AuthMethod[] }）
    app.get('/auth', (c) => {
        const setting = Setting.getInstance();
        const data = setting.getData();
        const result: Record<string, unknown[]> = {};
        for (const p of data.providers || []) {
            result[p.name] = [
                {
                    type: 'api_key',
                    description: 'API Key authentication'
                }
            ];
        }
        return c.json(result);
    });

    return app;
}
