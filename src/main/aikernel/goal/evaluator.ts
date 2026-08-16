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

import { z } from 'zod';
import { LLM } from '../llm.js';
import { UserMessage } from '../messages.js';
import type { TaskState } from '../states/tasks.js';
import { getTaskTodosForDisplay } from '../todos/task-todos.js';
import { buildGoalEvaluatorPrompt } from './prompts.js';
import type { GoalEvaluation, GoalState } from './state.js';
import { t } from '../../../locale/index.js';

const GoalEvaluationSchema = z.object({
    goalId: z.string(),
    goalRevision: z.number(),
    status: z.enum(['met', 'not_met', 'blocked']),
    reason: z.string(),
    evidence: z.array(z.string()),
    nextPrompt: z.string().optional()
});

export class GoalEvaluator {
    static async evaluate(task: TaskState, goal: GoalState): Promise<GoalEvaluation> {
        const goalSnapshot = {
            id: goal.id,
            revision: goal.revision,
            objective: goal.objective,
            successCriteria: [...goal.successCriteria],
            attempts: goal.attempts
        };
        const todos = getTaskTodosForDisplay(task.task_id);
        const changes = task.getTaskChanges();
        const prompt = buildGoalEvaluatorPrompt({
            goal: goalSnapshot,
            todos: todos.map((todo) => ({ title: todo.title, status: todo.status })),
            changes: {
                totalFiles: changes.totalFiles,
                totalAdded: changes.totalAdded,
                totalRemoved: changes.totalRemoved,
                files: changes.files.slice(0, 20).map((file) => file.filePath)
            },
            transcriptMessages: task.chat_context.messages,
            languageInstruction: t('goal.evaluator.language_instruction')
        });

        const result = await LLM.askForObjectWithSchema(
            new UserMessage(prompt),
            GoalEvaluationSchema,
            task.model,
            task.createUsageTelemetryRequestOptions({
                // 使用模型支持的最低推理档位，而非硬编码 'none' 强制关闭思考
                reasoningEffort: LLM.getMinimalReasoningEffort(task.model)
            })
        );
        const parsed: GoalEvaluation = {
            ...(result as Omit<GoalEvaluation, 'evaluatedAt'>),
            goalId: goalSnapshot.id,
            goalRevision: goalSnapshot.revision,
            evaluatedAt: new Date().toISOString()
        };
        if (parsed.status !== 'not_met') {
            delete parsed.nextPrompt;
        }
        return parsed;
    }
}
