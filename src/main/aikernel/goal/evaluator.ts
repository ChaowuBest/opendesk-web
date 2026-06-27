import { z } from 'zod';
import { LLM } from '../llm.js';
import { AssistantMessage, ToolCallMessagePart, UserMessage } from '../messages.js';
import type { TaskState } from '../states/tasks.js';
import { getTaskTodosForDisplay } from '../todos/task-todos.js';
import type { GoalEvaluation, GoalState } from './state.js';
import { buildGoalContextProjection } from './projection.js';
import { t } from '../../../locale/index.js';

const GoalEvaluationSchema = z.object({
    goalId: z.string(),
    goalRevision: z.number(),
    status: z.enum(['met', 'not_met', 'blocked', 'budget_limited']),
    reason: z.string(),
    evidence: z.array(z.string()),
    nextPrompt: z.string().optional(),
    evaluatedAt: z.string()
});

function recentTranscriptSummary(task: TaskState): string {
    const context = buildGoalContextProjection(task);
    const recent = context.messages.slice(-20);
    return recent
        .map((message) => {
            if (message instanceof UserMessage) {
                return `${message.internal ? '[internal user]' : '[user]'} ${message.getPlainText().slice(0, 1000)}`;
            }
            if (message instanceof AssistantMessage) {
                const parts: string[] = [];
                for (const part of message.content) {
                    if (part.type === 'text') parts.push(part.text.slice(0, 1000));
                    if (part instanceof ToolCallMessagePart) {
                        for (const tc of part.toolcalls.slice(-5)) {
                            parts.push(`[tool ${tc.tool_name} ${tc.status}] ${String(tc.result ?? '').slice(0, 500)}`);
                        }
                    }
                }
                return `[assistant] ${parts.join('\n')}`;
            }
            return '[compact/global context omitted]';
        })
        .join('\n\n');
}

export class GoalEvaluator {
    static async evaluate(task: TaskState, goal: GoalState): Promise<GoalEvaluation> {
        const todos = getTaskTodosForDisplay(task.task_id);
        const changes = task.getTaskChanges();
        const prompt = [
            'You are a read-only goal evaluator for OpenDesk. Return JSON only.',
            '',
            `Goal id: ${goal.id}`,
            `Goal revision: ${goal.revision}`,
            `Objective: ${goal.objective}`,
            `Success criteria: ${goal.successCriteria.length > 0 ? goal.successCriteria.join('; ') : '(none)'}`,
            `Attempts: ${goal.attempts}${goal.maxAttempts !== undefined ? ` / ${goal.maxAttempts}` : ''}`,
            '',
            'Todo summary:',
            JSON.stringify(todos.map((todo) => ({ title: todo.title, status: todo.status }))),
            '',
            'File changes summary:',
            JSON.stringify({
                totalFiles: changes.totalFiles,
                totalAdded: changes.totalAdded,
                totalRemoved: changes.totalRemoved,
                files: changes.files.slice(0, 20).map((file) => file.filePath)
            }),
            '',
            'Recent transcript:',
            recentTranscriptSummary(task),
            '',
            'Decide whether the goal is met. Use blocked only when user input, permission, credentials, or an external state change is required. Use budget_limited only when a configured goal budget prevents continuation. If not_met, include nextPrompt.',
            t('goal.evaluator.language_instruction')
        ].join('\n');

        const result = await LLM.askForObjectWithSchema(new UserMessage(prompt), GoalEvaluationSchema, task.model, {
            reasoningEffort: 'none'
        });
        const parsed = result as GoalEvaluation;
        if (parsed.goalId !== goal.id) parsed.goalId = goal.id;
        if (parsed.goalRevision !== goal.revision) parsed.goalRevision = goal.revision;
        if (!parsed.evaluatedAt) parsed.evaluatedAt = new Date().toISOString();
        if (parsed.status !== 'not_met') {
            delete parsed.nextPrompt;
        }
        return parsed;
    }
}
