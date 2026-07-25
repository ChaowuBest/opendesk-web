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
 * 职责：从宿主 Task 提取 Workflow Authoring 使用的真实用户输入边界。
 */

import { UserMessage } from '../../../aikernel/messages.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';

export interface WorkflowAuthoringContext {
    userInputs: string[];
}

export function createWorkflowAuthoringContext(hostTask: TaskState): WorkflowAuthoringContext {
    const userInputs: string[] = [];
    const messages = hostTask.chat_context?.messages ?? [];
    for (const message of messages) {
        if (!(message instanceof UserMessage) || message.internal === true) {
            continue;
        }
        const userInput = message.rawText ?? message.getPlainText();
        if (userInput.trim()) {
            userInputs.push(userInput);
        }
    }
    if (userInputs.length > 0) {
        return { userInputs };
    }
    throw new Error('当前 Task 中没有可用于创建 Workflow 的用户原始输入。');
}
