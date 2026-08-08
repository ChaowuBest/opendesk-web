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

import { Setting, type SettingData } from '../../utils/setting.js';
import iconv from 'iconv-lite';
import { ApplicationRegistry, notifyWorkerSettingUpdate } from '../../applications/registry.js';
import { GlobalState } from '../../aikernel/states/global.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { logger } from '../../utils/logger.js';

type JsonRecord = Record<string, unknown>;
type RefreshableApplication = {
    refresh: () => unknown;
};

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneSettingData(data: SettingData): SettingData {
    return JSON.parse(JSON.stringify(data)) as SettingData;
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function hasOwnProperty(value: JsonRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function firstString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function isRefreshableApplication(value: unknown): value is RefreshableApplication {
    return isRecord(value) && typeof value.refresh === 'function';
}

export function modelAliasFromOpenCodeRef(data: SettingData, modelRef: unknown): string | undefined {
    if (isRecord(modelRef)) {
        const providerName = firstString(modelRef.providerID, modelRef.providerId, modelRef.provider);
        const modelId = firstString(modelRef.modelID, modelRef.modelId, modelRef.model);
        if (providerName && modelId) {
            return modelAliasFromOpenCodeRef(data, `${providerName}/${modelId}`);
        }

        const id = firstString(modelRef.id);
        if (id) {
            return providerName && !id.includes('/')
                ? modelAliasFromOpenCodeRef(data, `${providerName}/${id}`)
                : modelAliasFromOpenCodeRef(data, id);
        }

        return undefined;
    }

    if (typeof modelRef !== 'string') return undefined;

    const normalizedModelRef = modelRef.trim();
    if (!normalizedModelRef) return undefined;

    const parts = normalizedModelRef.split('/');
    if (parts.length >= 2) {
        const providerName = parts[0];
        const modelId = parts.slice(1).join('/');
        const matchedModel = data.models.find(
            (model) => model.provider_name === providerName && (model.alias === modelId || model.model_name === modelId)
        );
        return matchedModel?.alias ?? modelId;
    }

    return normalizedModelRef;
}

function mergeRecordDeep(base: unknown, patch: unknown): unknown {
    if (!isRecord(base) || !isRecord(patch)) return patch;
    const result: JsonRecord = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        result[key] = isRecord(value) && isRecord(result[key]) ? mergeRecordDeep(result[key], value) : value;
    }
    return result;
}

function applyProviderConfigPatch(data: SettingData, providerConfig: unknown): void {
    if (!isRecord(providerConfig)) return;

    for (const [providerName, rawConfig] of Object.entries(providerConfig)) {
        if (!isRecord(rawConfig)) continue;

        const options = isRecord(rawConfig.options) ? rawConfig.options : {};
        const apiKey = options.apiKey ?? options.api_key;
        const baseURL = options.baseURL ?? options.base_url ?? options.baseUrl;
        const noProxy = options.no_proxy ?? options.noProxy;
        const noSSL = options.no_ssl ?? options.noSSL;
        const enabled = rawConfig.enabled ?? options.enabled;

        let provider = data.providers.find((item) => item.name === providerName);
        if (!provider) {
            provider = {
                name: providerName,
                base_url: typeof baseURL === 'string' ? baseURL : '',
                api_key: typeof apiKey === 'string' ? apiKey : '',
                no_proxy: typeof noProxy === 'boolean' ? noProxy : false,
                no_ssl: typeof noSSL === 'boolean' ? noSSL : false,
                ...(typeof enabled === 'boolean' ? { enabled } : {})
            };
            data.providers.push(provider);
            continue;
        }

        if (typeof baseURL === 'string') {
            provider.base_url = baseURL;
        }
        if (typeof apiKey === 'string') {
            provider.api_key = apiKey;
        }
        if (typeof noProxy === 'boolean') {
            provider.no_proxy = noProxy;
        }
        if (typeof noSSL === 'boolean') {
            provider.no_ssl = noSSL;
        }
        if (typeof enabled === 'boolean') {
            provider.enabled = enabled;
        }
    }
}

function applyNativeSettingPatch(data: SettingData, body: JsonRecord): void {
    const directKeys: Array<keyof SettingData> = [
        'locale',
        'default_model',
        'default_intent_parsing_model',
        'default_embedding_model',
        'default_reranker_model',
        'default_vision_model',
        'default_workspace'
    ];

    for (const key of directKeys) {
        if (body[key] !== undefined) {
            (data as unknown as JsonRecord)[key] = body[key];
        }
    }

    if (Array.isArray(body.providers)) {
        data.providers = body.providers as SettingData['providers'];
    }
    if (Array.isArray(body.models)) {
        data.models = body.models as SettingData['models'];
    }
    if (isRecord(body.gui_config)) {
        data.gui_config = mergeRecordDeep(data.gui_config, body.gui_config) as SettingData['gui_config'];
    }
    if (isRecord(body.cli_config)) {
        data.cli_config = mergeRecordDeep(data.cli_config, body.cli_config) as SettingData['cli_config'];
    }
    if (isRecord(body.applications)) {
        data.applications = mergeRecordDeep(data.applications, body.applications) as SettingData['applications'];
    }
    if (hasOwnProperty(body, 'permission')) {
        if (body.permission === null || body.permission === undefined) {
            delete (data as Record<string, unknown>).permission;
        } else {
            data.permission = cloneJsonValue(body.permission);
        }
    }
}

export function isOpenCodeProviderAllowed(data: SettingData, providerName: string): boolean {
    const provider = data.providers.find((item) => item.name === providerName);
    return provider?.enabled !== false;
}

/**
 * 构造符合 opencode Config 类型的响应。
 */
export function buildOpenCodeConfig(data: SettingData): Record<string, unknown> {
    const providerConfig: Record<string, unknown> = {};
    for (const provider of data.providers || []) {
        if (!isOpenCodeProviderAllowed(data, provider.name)) {
            continue;
        }
        providerConfig[provider.name] = {
            api: 'openai',
            options: {
                apiKey: provider.api_key || '',
                baseURL: provider.base_url || '',
                noProxy: provider.no_proxy || false,
                noSSL: provider.no_ssl || false
            }
        };
    }

    let defaultModel: string | undefined;
    if (data.default_model) {
        const model = data.models.find((item) => item.alias === data.default_model && item.model_type !== 'embedding');
        if (model && isOpenCodeProviderAllowed(data, model.provider_name)) {
            defaultModel = `${model.provider_name}/${model.alias}`;
        }
    }

    const config: Record<string, unknown> = {
        model: defaultModel,
        provider: providerConfig
    };
    if (data.permission !== undefined) {
        config.permission = cloneJsonValue(data.permission);
    }
    return config;
}

export function hasOpenCodePermissionPatch(rawBody: unknown): boolean {
    return isRecord(rawBody) && hasOwnProperty(rawBody, 'permission');
}

/**
 * 将 OpenDesk 内部 model 配置转换为 opencode Model 格式。
 */
export function toOpenCodeModel(model: SettingData['models'][number], providerName: string): Record<string, unknown> {
    return {
        id: model.alias || model.model_name,
        providerID: providerName,
        api: {
            id: 'openai',
            url: '',
            npm: ''
        },
        name: model.model_name || model.alias,
        capabilities: {
            temperature: true,
            reasoning: !!model.reasoning_effort,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: {
            context: model.context_length && model.context_length > 0 ? model.context_length : 128000,
            output: 16384
        },
        status: 'active',
        options: {},
        headers: model.custom_headers
            ? Object.fromEntries(
                  Object.entries(model.custom_headers).map(([k, v]) => [
                      k,
                      iconv.encode(v, 'latin1').toString('latin1')
                  ])
              )
            : {},
        release_date: ''
    };
}

/**
 * 将 OpenDesk 内部 provider 配置转换为 opencode Provider 格式。
 */
export function toOpenCodeProvider(
    provider: SettingData['providers'][number],
    models: SettingData['models']
): Record<string, unknown> {
    const providerModels: Record<string, unknown> = {};
    const filteredModels = models.filter(
        (model) => model.provider_name === provider.name && model.model_type !== 'embedding'
    );
    for (const model of filteredModels) {
        const modelId = model.alias || model.model_name;
        providerModels[modelId] = toOpenCodeModel(model, provider.name);
    }
    return {
        id: provider.name,
        name: provider.name,
        source: 'config' as const,
        env: [],
        options: { baseURL: provider.base_url },
        models: providerModels
    };
}

export function buildOpenCodeConfigProviders(data: SettingData): Record<string, unknown> {
    const providers = data.providers
        .filter((provider) => isOpenCodeProviderAllowed(data, provider.name))
        .map((provider) => toOpenCodeProvider(provider, data.models));
    const defaults: Record<string, string> = {};
    if (data.default_model) {
        const defaultModel = data.models.find(
            (model) => model.alias === data.default_model && model.model_type !== 'embedding'
        );
        if (defaultModel && isOpenCodeProviderAllowed(data, defaultModel.provider_name)) {
            defaults[defaultModel.provider_name] = defaultModel.alias;
        }
    }
    return { providers, default: defaults };
}

/**
 * 将 opencode Config.update payload 合并到 OpenDesk 设置。
 *
 * PATCH /config 既可能收到 opencode 风格的 { model, provider }，也可能收到
 * OpenDesk 原生设置字段。返回新对象，调用方必须通过 Setting.setData() 写入，
 * 这样应用级配置变更才能触发 onConfigChanged 与 worker 同步。
 */
export function mergeOpenCodeConfigPatch(current: SettingData, rawBody: unknown): SettingData {
    const data = cloneSettingData(current);
    if (!isRecord(rawBody)) return data;

    applyNativeSettingPatch(data, rawBody);

    const defaultModel = modelAliasFromOpenCodeRef(data, rawBody.model);
    if (defaultModel !== undefined) {
        data.default_model = defaultModel;
    }

    applyProviderConfigPatch(data, rawBody.provider);

    return data;
}

export function isOpenDeskConfigReloadRequest(rawBody: unknown): boolean {
    if (!isRecord(rawBody)) return false;
    if (Object.keys(rawBody).length === 0) return true;

    if (!hasOwnProperty(rawBody, 'config')) return false;
    const config = rawBody.config;
    return isRecord(config) && Object.keys(config).length === 0;
}

export async function reloadOpenDeskConfigFromFile(setting: Setting): Promise<SettingData> {
    const loadedSetting = Setting.load();
    if (!loadedSetting) {
        throw new Error(Setting.getLoadError() || 'Failed to reload setting from disk');
    }

    setting.setData(loadedSetting.getData());
    refreshOpenDeskSkills();
    await refreshOpenDeskTaskContexts();
    return setting.getData();
}

function refreshOpenDeskSkills(): void {
    const skillApp = ApplicationRegistry.getApplication('skillmgr');
    if (isRefreshableApplication(skillApp)) {
        try {
            skillApp.refresh();
        } catch (error) {
            logger.warn(`failed to refresh skills during config reload: ${errorToMessage(error)}`);
        }
    }
}

async function refreshOpenDeskTaskContexts(): Promise<void> {
    let tasks: TaskState[] = [];
    try {
        tasks = GlobalState.getInstance().taskManagerState.tasks || [];
    } catch (error) {
        logger.warn(`failed to get tasks during config reload: ${errorToMessage(error)}`);
        return;
    }

    if (tasks.length === 0) return;

    await Promise.allSettled(
        tasks.map(async (task) => {
            try {
                // 跳过懒加载任务：它们未运行，chat_context 为空，
                // 刷新 system prompt 无意义且会导致数据不一致。
                // 恢复任务时 getTask()->ensureLoaded() 会从磁盘加载完整数据。
                if (!task._fullyLoaded) return;

                const toolsets = await task.buildToolsets();
                task.chat_context.attachToolsets(...toolsets);

                await task.rebuildSystemPrompt();
            } catch (error) {
                logger.warn(`failed to refresh task context during config reload: ${errorToMessage(error)}`);
            }
        })
    );
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function notifyOpenCodeConfigUpdated(data: SettingData): void {
    if (ApplicationRegistry.hasGlobalWorker()) {
        void notifyWorkerSettingUpdate(data).catch((error) => {
            logger.warn(`failed to notify worker setting update: ${errorToMessage(error)}`);
        });
    }
}
