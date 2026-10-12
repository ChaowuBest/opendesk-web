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

interface ProviderModelConfig {
    base_url: string;
    api_key: string;
    provider_type?: 'openai' | 'anthropic';
    no_proxy?: boolean;
    no_ssl?: boolean;
}

type ProviderFetch = (config: ProviderModelConfig, url: string, init: RequestInit) => Promise<Response>;

export async function fetchProviderModelNames(config: ProviderModelConfig, fetch: ProviderFetch): Promise<string[]> {
    const baseUrl = config.base_url.trim().replace(/\/+$/, '');
    const url =
        config.provider_type === 'anthropic' && !baseUrl.endsWith('/v1') ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${config.api_key}`,
        'Content-Type': 'application/json'
    };
    if (config.provider_type === 'anthropic') {
        headers['x-api-key'] = config.api_key;
        headers['anthropic-version'] = '2023-06-01';
    }
    const response = await fetch(config, url, { headers, signal: AbortSignal.timeout(8000) });
    // Stable internal error codes are translated by the renderer; never expose response bodies or credentials.
    if (!response.ok) throw new Error(`MODEL_LIST_HTTP_${response.status}`);
    const body = await response.json().catch(() => {
        throw new Error('MODEL_LIST_INVALID');
    });
    const models = body?.data ?? body;
    if (!Array.isArray(models)) throw new Error('MODEL_LIST_INVALID');
    const names = models
        .map((model) => model?.id || model?.name)
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
    return [...new Set(names)].sort();
}
