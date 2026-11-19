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

import type { TaskState } from '../states/tasks.js';
import { Setting } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { fetchContextSizeFromAPI, lookupKnownContextSize } from '../../utils/model-context.js';
import { t } from '../../../locale/index.js';

export type TaskModelChangeResult = { status: 'ok' } | { status: 'error'; message: string };

/** Resolve the selected chat model's window consistently across GUI hosts; zero means unknown. */
export async function resolveTaskModelContextSize(modelAlias?: string | null): Promise<number> {
    try {
        const setting = Setting.getInstance();
        const model = modelAlias ? setting.getModelInstance(modelAlias, 'chat') : setting.getDefaultModelInstance();
        if (!model) return 0;
        if (model.context_length && model.context_length > 0) return model.context_length;
        const knownSize = lookupKnownContextSize(model.model_name);
        if (knownSize > 0) return knownSize;
        return await fetchContextSizeFromAPI(model);
    } catch {
        return 0;
    }
}

/** Apply a task model selection without depending on its host's registration or transport. */
export async function setTaskModel(
    task: Pick<TaskState, 'model' | 'reasoningEffort' | 'persistLater' | 'refreshToolsets'>,
    modelAlias: string | undefined,
    reasoningEffort?: TaskState['reasoningEffort']
): Promise<TaskModelChangeResult> {
    if (modelAlias && !Setting.getInstance().getModelInstance(modelAlias, 'chat')) {
        return { status: 'error', message: t('error.model.chat_alias_not_found', { alias: modelAlias }) };
    }
    const previous = task.model;
    task.model = modelAlias || undefined;
    if (reasoningEffort !== undefined) {
        // 空字符串是显式选择模型默认档位，不能丢弃或保留旧的任务覆盖值。
        task.reasoningEffort = reasoningEffort;
    }
    task.persistLater();
    // 模型切换后立即重新过滤工具集：非视觉模型不应继续看到 readImage/askImage 等视觉工具，
    // 否则运行中的 turn 会在后续请求中继续调用已不匹配的工具并报"模型不支持视觉"错误。
    if (previous !== task.model) {
        try {
            await task.refreshToolsets();
        } catch (err) {
            logger.warn(
                `failed to refresh toolsets after model switch: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }
    return { status: 'ok' };
}
