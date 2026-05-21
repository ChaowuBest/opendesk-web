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
 * 将 OpenDesk 内部 model 配置转换为 opencode Model 格式。
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
 * 将 OpenDesk 内部 provider 配置转换为 opencode Provider 格式。
 */
function toOpenCodeProvider(p: any, models: any[]): Record<string, unknown> {
    const providerModels: Record<string, unknown> = {};
    const filteredModels = models.filter((m: any) => m.provider_name === p.name);
    for (const m of filteredModels) {
        const modelId = m.alias || m.model_name;
        providerModels[modelId] = toOpenCodeModel(m, p.name);
    }
    return {
        id: p.name,
        name: p.name,
        source: 'config' as const,
        env: [],
        options: { baseURL: p.base_url },
        models: providerModels
    };
}

/**
 * 构造符合 opencode Config 类型的响应。
 */
function buildOpenCodeConfig(data: any): Record<string, unknown> {
    // 构建 provider 配置映射
    const providerConfig: Record<string, unknown> = {};
    for (const p of data.providers || []) {
        providerConfig[p.name] = {
            api: 'openai',
            options: {
                apiKey: p.api_key || '',
                baseURL: p.base_url || ''
            }
        };
    }

    // 确定默认 model 标识（格式: providerID/modelID）
    let defaultModel: string | undefined;
    if (data.default_model) {
        const dm = (data.models || []).find((m: any) => m.alias === data.default_model);
        if (dm) {
            defaultModel = `${dm.provider_name}/${dm.alias}`;
        }
    }

    return {
        model: defaultModel,
        provider: providerConfig
    };
}

/**
 * Config 路由。
 * 对应 opencode 的 /config/* 端点。
 */
export function ConfigRoutes() {
    const app = new Hono();

    // GET /config - 获取配置
    app.get('/', (c) => {
        const setting = Setting.getInstance();
        const data = setting.getData();
        return c.json(buildOpenCodeConfig(data));
    });

    // PATCH /config - 更新配置
    app.patch('/', async (c) => {
        const body = await c.req.json();
        const setting = Setting.getInstance();
        const data = setting.getData();

        // 支持 opencode 格式的 model 字段 (providerID/modelID)
        if (body.model !== undefined) {
            const parts = (body.model as string).split('/');
            if (parts.length >= 2) {
                const providerName = parts[0];
                const modelId = parts.slice(1).join('/');
                const matchedModel = (data.models || []).find(
                    (m: any) => m.provider_name === providerName && (m.alias === modelId || m.model_name === modelId)
                );
                if (matchedModel) {
                    data.default_model = matchedModel.alias;
                }
            } else {
                data.default_model = body.model;
            }
        }

        if (body.default_model !== undefined) {
            data.default_model = body.default_model;
        }

        setting.save();
        return c.json(buildOpenCodeConfig(data));
    });

    // GET /config/providers - 列出 providers 和默认模型
    app.get('/providers', (c) => {
        const setting = Setting.getInstance();
        const data = setting.getData();

        const providers = (data.providers || []).map((p: any) => toOpenCodeProvider(p, data.models || []));

        const defaults: Record<string, string> = {};
        if (data.default_model) {
            const defaultModel = (data.models || []).find((m: any) => m.alias === data.default_model);
            if (defaultModel) {
                defaults[defaultModel.provider_name] = defaultModel.alias;
            }
        }

        return c.json({ providers, default: defaults });
    });

    return app;
}
