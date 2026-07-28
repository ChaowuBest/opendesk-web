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

import type {
    AgentExecutionInstrumentation,
    ModelRequestInstrumentationContext,
    TaskTurnInstrumentationContext,
    ToolCallInstrumentationContext
} from '../agent-execution.js';
import { withSpan } from './tracing.js';

export class OpenTelemetryAgentExecutionInstrumentation implements AgentExecutionInstrumentation {
    aroundTaskTurn<T>(context: TaskTurnInstrumentationContext, next: () => Promise<T>): Promise<T> {
        return withSpan('task.turn', async () => next(), {
            'task.id': context.taskId,
            'task.name': context.taskName ?? '',
            'task.parent_id': context.parentTaskId ?? '',
            ...(context.userPrompt !== undefined ? { 'task.user_prompt': context.userPrompt } : {})
        });
    }

    aroundModelRequest<T>(
        _context: ModelRequestInstrumentationContext,
        next: (headers?: Record<string, string>) => Promise<T>
    ): Promise<T> {
        return next();
    }

    recordToolCall(_context: ToolCallInstrumentationContext): void {}
}
