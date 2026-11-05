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

import { ApplicationRegistry } from '../registry.js';
import { logger } from '../../utils/logger.js';

function embeddingConfigFingerprint(data: any): string {
    const alias = data?.default_embedding_model || '';
    const model = (data?.models || []).find((item: any) => item.alias === alias);
    const provider = (data?.providers || []).find((item: any) => item.name === model?.provider_name);
    return JSON.stringify({
        alias,
        model_type: model?.model_type || 'chat',
        model_name: model?.model_name || '',
        provider_name: model?.provider_name || '',
        custom_headers: model?.custom_headers || {},
        provider_type: provider?.provider_type || 'openai',
        base_url: provider?.base_url || '',
        api_key: provider?.api_key || '',
        no_proxy: !!provider?.no_proxy,
        no_ssl: !!provider?.no_ssl
    });
}

export async function notifyFileMgrEmbeddingConfigChanged(oldSettings: unknown, newSettings: unknown): Promise<void> {
    if (embeddingConfigFingerprint(oldSettings) === embeddingConfigFingerprint(newSettings)) {
        return;
    }
    try {
        await ApplicationRegistry.callWorker('filemgr', 'embeddingConfigChanged');
    } catch (error: any) {
        logger.warn(`[filemgr] failed to sync embedding config change: ${error?.message ?? error}`);
    }
}
