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
    Setting,
    ModelInstance,
    type BuiltinModelFetch,
    type BuiltinModelProvider,
    type Model,
    type ModelType
} from '../../utils/setting.js';
import { accountBackendRegistry } from './backend-registry.js';

export const OPENDESK_BUILTIN_PROVIDER_NAME = 'opendesk';
const MODEL_QUERY_TIMEOUT_MS = 8000;

export interface AccountModelApi {
    baseUrl: string;
    token: string;
}

function modelDescriptor(id: string): Model {
    const separator = id.indexOf('/');
    return {
        alias: id,
        provider_name: separator > 0 ? id.slice(0, separator) : OPENDESK_BUILTIN_PROVIDER_NAME,
        model_name: separator > 0 ? id.slice(separator + 1) : id,
        model_type: 'chat',
        auto_parse_think_tags: false,
        reasoning_effort: ''
    };
}

function parseModelDescriptors(body: unknown): Model[] {
    const value =
        body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).data : body;
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    for (const item of value) {
        const candidate =
            typeof item === 'string'
                ? item
                : item && typeof item === 'object'
                  ? ((item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name)
                  : undefined;
        if (typeof candidate === 'string' && candidate.trim()) ids.add(candidate.trim());
    }
    return [...ids].sort().map(modelDescriptor);
}

/**
 * 内置模型提供方：模型凭据来自 opendesk-account 插件用登录会话换取的 relay 虚拟 key
 * （`sk-od-...`），而非账号登录 token。账号后端通过 `resolveModelApi` 回调注入
 * （host 侧在注册时提供）。
 */
export class AccountBuiltinModelProvider implements BuiltinModelProvider {
    readonly providerName = OPENDESK_BUILTIN_PROVIDER_NAME;

    constructor(private readonly resolveModelApi: () => AccountModelApi | null) {}

    resolveInstance(model: Model, expectedType?: ModelType): ModelInstance | null {
        if (expectedType === 'embedding') return null;
        const api = this.resolveModelApi();
        if (!api) return null;
        return new ModelInstance(
            model.alias,
            api.baseUrl,
            api.token,
            false,
            false,
            '',
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            'openai',
            model.model_type,
            model.provider_name
        );
    }

    async refreshModels(fetchImpl?: BuiltinModelFetch): Promise<Model[]> {
        const api = this.resolveModelApi();
        if (!api) return [];
        const effectiveFetch = fetchImpl ?? (async (input, init) => await globalThis.fetch(input, init));
        try {
            const response = await effectiveFetch(`${api.baseUrl}/models`, {
                headers: {
                    Authorization: `Bearer ${api.token}`,
                    Accept: 'application/json'
                },
                signal: AbortSignal.timeout(MODEL_QUERY_TIMEOUT_MS)
            });
            if (!response.ok) return [];
            return parseModelDescriptors(await response.json());
        } catch {
            return [];
        }
    }
}

let registered = false;

export function registerAccountBuiltinModelProvider(): void {
    if (registered) return;
    registered = true;
    const resolveModelApi = (): AccountModelApi | null => {
        const backend = accountBackendRegistry.getDefault();
        const api = (backend as { getModelApi?: () => AccountModelApi | null } | undefined)?.getModelApi?.();
        return api && api.baseUrl && api.token ? { baseUrl: api.baseUrl, token: api.token } : null;
    };
    Setting.builtinModelProvider = new AccountBuiltinModelProvider(resolveModelApi);
}

/** 当前 default_model 是否仍指向用户模型或本次拉取到的内置模型。 */
function hasUsableDefaultModel(setting: Setting): boolean {
    const current = setting.data.default_model?.trim() ?? '';
    if (!current) return false;
    return (
        setting.data.models.some((model) => model.alias === current) ||
        setting.data.builtin_models.some((model) => model.alias === current)
    );
}

/** 选择要自动设为默认的内置模型：优先账号自带模型，其次首个非 embedding 模型。 */
export function pickBuiltinDefaultModel(models: readonly Model[]): string | null {
    const chatModels = models.filter((model) => model.model_type !== 'embedding');
    const preferred = chatModels.find((model) => model.provider_name === OPENDESK_BUILTIN_PROVIDER_NAME);
    return (preferred ?? chatModels[0])?.alias ?? null;
}

/** 拉取模型目录并持久化到 setting.json。登录/登出/刷新 token 后调用。 */
export async function refreshBuiltinModels(): Promise<void> {
    try {
        const models = (await Setting.builtinModelProvider?.refreshModels()) ?? [];
        const setting = Setting.getInstance();
        setting.data.builtin_models = models;
        // 账号登录后若尚无有效默认模型，自动选中账号自带模型，避免向导跳过模型配置后无模型可用
        if (models.length > 0 && !hasUsableDefaultModel(setting)) {
            const alias = pickBuiltinDefaultModel(models);
            if (alias) setting.data.default_model = alias;
        }
        setting.save();
    } catch {
        // 拉取失败时保持现有模型列表
    }
}
