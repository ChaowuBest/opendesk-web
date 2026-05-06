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

import format from 'string-template';
import { describeCron } from '../../utils/cron.js';

const TODO_HANDLER_TEMPLATE = `
请执行以下全局待办事项：

- 待办事项ID: {todoId}
- 待办事项标题：{todoTitle}
- 待办事项触发方式：{todoTrigger}

待办事项内容
---

{todoContent}

注意事项
---
1. 这条消息是由待办事项管理器自动创建的，你的回复应当专注于完成用户在待办事项中指定的任务;
2. 待办事项的所有信息已经告诉你了，不需要尝试获取待办事项的更多信息，你也**不需要**将待办事项标记为已完成；
3. 如果周期型待办事项无法成功完成，你应当检查过往的执行历史，如果失败次数过多，应当提醒用户取消待办事项；
`;

export function buildTriggerInfo(trigger: any): string {
    if (trigger?.type === 'event') {
        return `[event] 事件驱动任务，由事件 ${trigger.bundleName}:${trigger.eventName} 自动触发 `;
    } else if (trigger?.type === 'scheduled') {
        return `[scheduled] 定时任务，仅执行一次 `;
    } else if (trigger?.type === 'cron') {
        return `[cron] 定时任务, 触发时机为 ${describeCron(trigger.cronExpression)} `;
    }
    return '';
}

export function buildTriggerMessage(todoId: string, todoTitle: string, todoContent: string, trigger: any): string {
    const triggerInfo = buildTriggerInfo(trigger);
    return format(TODO_HANDLER_TEMPLATE, {
        todoId,
        todoTitle,
        todoContent,
        todoTrigger: triggerInfo
    });
}
