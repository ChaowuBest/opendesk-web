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

/**
 * 将 OpenDesk 内部 model 配置转换为 opencode Model 格式（字典值）。
 */
function toOpenCodeModel(m: any, providerName: string): Record<string, unknown> {
    return {
        id: m.alias || m.model_name,
        providerID: providerName,
        api: {
            id: 'openai',
            url: '',
            npm: ''
        },
        name: m.model_name || m.alias,
        capabilities: {
            temperature: true,
            reasoning: !!m.reasoning_effort,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128000, output: 16384 },
        status: 'active',
        options: {},
        headers: {},
        release_date: ''
    };
}

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

        // opencode Provider.models 是字典，不是数组
        const providers = (data.providers || []).map((p: any) => {
            const providerModels: Record<string, unknown> = {};
            const filteredModels = (data.models || []).filter((m: any) => m.provider_name === p.name);
            for (const m of filteredModels) {
                const modelId = m.alias || m.model_name;
                providerModels[modelId] = toOpenCodeModel(m, p.name);
            }
            return {
                id: p.name,
                name: p.name,
                source: 'config',
                env: [],
                options: { baseURL: p.base_url },
                models: providerModels
            };
        });

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
