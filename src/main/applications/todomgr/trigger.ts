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

/**
 * 统一的触发器任务处理逻辑。
 * TUI 和 Electron GUI 共享此模块来创建和分发由待办事项触发器产生的任务。
 */

import { t } from './locale/index.js';
import { describeLegacyRecurrence, describeTodoRecurrence } from '../../../common/utils/recurrence-description.js';
import { formatDateTimeInTimezone, getSystemTimezone } from '../../../common/utils/timezone.js';

export function buildTriggerInfo(trigger: any): string {
    if (trigger?.type === 'event') {
        return t('trigger.info.event', { bundle: trigger.bundleName, event: trigger.eventName });
    } else if (trigger?.type === 'scheduled') {
        if (!trigger.triggerAt) return t('trigger.info.scheduled');
        const timezone = trigger.timezone ?? getSystemTimezone();
        const time = formatDateTimeInTimezone(trigger.triggerAt, timezone);
        return `${t('trigger.info.scheduled').trimEnd()} ${time} (${timezone})`;
    } else if (trigger?.type === 'cron') {
        const timezone = trigger.timezone ?? 'UTC';
        return t('trigger.info.cron', {
            cron: trigger.recurrence
                ? describeTodoRecurrence(trigger.recurrence, t, timezone)
                : describeLegacyRecurrence(trigger.cronExpression, t, timezone)
        });
    }
    return '';
}

export function buildTriggerMessage(todoId: string, todoTitle: string, todoContent: string, trigger: any): string {
    const triggerInfo = buildTriggerInfo(trigger);
    return t('trigger.message.template', { todoId, todoTitle, todoContent, todoTrigger: triggerInfo });
}
