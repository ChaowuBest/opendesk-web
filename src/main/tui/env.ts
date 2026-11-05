/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * OPENDESK_* 环境变量的名称常量与 CLI 帮助文档。
 * 新增/修改环境变量时只需在此维护，CLI --help 的展示会自动更新。
 * （各模块读取环境变量的实现仍由各自负责，此处仅作为维护参考。）
 */
export const ENV_CONFIG_DIRECTORY = 'OPENDESK_CONFIG_DIRECTORY';
export const ENV_BUILTIN_PLUGINS_DIRECTORY = 'OPENDESK_BUILTIN_PLUGINS_DIRECTORY';
export const ENV_PLUGINS_DIRECTORY = 'OPENDESK_PLUGINS_DIRECTORY';
export const ENV_PLATFORM = 'OPENDESK_PLATFORM';
export const ENV_DEBUG_FETCH_BODY = 'OPENDESK_DEBUG_FETCH_BODY';
export const ENV_DEFAULT_MODEL_NAME = 'OPENDESK_MODEL_NAME';
export const ENV_DEFAULT_MODEL_CONTEXT_LENGTH = 'OPENDESK_MODEL_CONTEXT_LENGTH';
export const ENV_DEFAULT_PROVIDER_BASE_URL = 'OPENDESK_PROVIDER_BASE_URL';
export const ENV_DEFAULT_PROVIDER_TYPE = 'OPENDESK_PROVIDER_TYPE';
export const ENV_DEFAULT_PROVIDER_API_KEY = 'OPENDESK_PROVIDER_API_KEY';

export interface OpendeskEnvVarDoc {
    name: string;
    description: string;
}

/** 供 CLI --help 展示的 OPENDESK_* 环境变量参考文档（不含平台/调试类内部变量） */
export const OPENDESK_ENV_VAR_DOCS: OpendeskEnvVarDoc[] = [
    { name: ENV_CONFIG_DIRECTORY, description: 'custom config directory (same as --config-directory)' },
    { name: ENV_BUILTIN_PLUGINS_DIRECTORY, description: 'override built-in plugins directory' },
    {
        name: ENV_PLUGINS_DIRECTORY,
        description:
            'comma-separated plugin directories merged into the built-in plugins directory (same as --plugins-directory)'
    },
    { name: ENV_DEFAULT_MODEL_NAME, description: 'override default chat model name' },
    { name: ENV_DEFAULT_MODEL_CONTEXT_LENGTH, description: 'override default model context length (tokens)' },
    { name: ENV_DEFAULT_PROVIDER_BASE_URL, description: 'override provider base URL' },
    { name: ENV_DEFAULT_PROVIDER_TYPE, description: 'override provider type (openai | anthropic)' },
    { name: ENV_DEFAULT_PROVIDER_API_KEY, description: 'override provider API key' }
];
