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
import { describeCron, type CronDescribeLabels } from '../../utils/cron.js';

/** describeCron 的多语言文案，词条随当前 locale 动态解析 */
function cronLabels(): CronDescribeLabels {
    return {
        dowNames: Array.from({ length: 7 }, (_, i) => t(`cron.desc.dowNames.${i}`)),
        everyDowTemplate: t('cron.desc.everyDow'),
        dowTemplate: t('cron.desc.dow'),
        monthlyDomTemplate: t('cron.desc.monthlyDom'),
        monthTemplate: t('cron.desc.month'),
        hourTemplate: t('cron.desc.hourOnly'),
        minuteTemplate: t('cron.desc.minuteOnly'),
        everyMinute: t('cron.desc.everyMinute')
    };
}

export function buildTriggerInfo(trigger: any): string {
    if (trigger?.type === 'event') {
        return t('trigger.info.event', { bundle: trigger.bundleName, event: trigger.eventName });
    } else if (trigger?.type === 'scheduled') {
        return t('trigger.info.scheduled');
    } else if (trigger?.type === 'cron') {
        return t('trigger.info.cron', { cron: describeCron(trigger.cronExpression, cronLabels()) });
    }
    return '';
}

export function buildTriggerMessage(todoId: string, todoTitle: string, todoContent: string, trigger: any): string {
    const triggerInfo = buildTriggerInfo(trigger);
    return t('trigger.message.template', { todoId, todoTitle, todoContent, todoTrigger: triggerInfo });
}
