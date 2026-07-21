/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：从宿主 Task 提取 Workflow Authoring 使用的真实用户输入边界。
 */

import { UserMessage } from '../../../aikernel/messages.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { t } from '../../../../locale/index.js';

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
    throw new Error(t('workflow.error.authoringOriginalRequestMissing'));
}
