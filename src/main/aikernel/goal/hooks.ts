import { HookRegistry } from '../hooks.js';
import { getTaskTodosForDisplay } from '../todos/task-todos.js';
import { GoalController } from './controller.js';
import { GoalEvaluator } from './evaluator.js';
import { createUserGoalDataBlock } from './prompt-data.js';

let registeredCallback:
    | ((task: any) => Promise<{ operation: 'finish' } | { operation: 'reject'; message: string }>)
    | undefined;

export function registerGoalHooks(): void {
    if (
        registeredCallback &&
        HookRegistry.beforeFinishTurnCallbacks.some((entry: any) =>
            typeof entry === 'function' ? entry === registeredCallback : entry.callback === registeredCallback
        )
    ) {
        return;
    }
    registeredCallback = async (task) => {
        if (task.parent_id !== null || task.internal === true) return { operation: 'finish' };
        if (task.isGoalRuntimeInterrupted()) return { operation: 'finish' };
        const goal = task.goal_state;
        if (!goal || goal.status === 'cleared' || goal.status === 'complete') return { operation: 'finish' };
        if (goal.status !== 'active') return { operation: 'finish' };

        const todos = getTaskTodosForDisplay(task.task_id);
        const unfinishedTodos = todos.filter((todo) => todo.status !== 'completed');
        if (unfinishedTodos.length > 0) {
            return {
                operation: 'reject',
                message: [
                    '<system-reminder>',
                    '当前 goal 仍有未完成 TodoWrite 项。请继续推进这些待办，不要结束本轮。',
                    '',
                    ...createUserGoalDataBlock('Unfinished goal todos:', {
                        goal: {
                            objective: goal.objective,
                            revision: goal.revision
                        },
                        todos: unfinishedTodos.map((todo) => ({
                            title: todo.title,
                            content: todo.content,
                            status: todo.status
                        }))
                    }),
                    '</system-reminder>'
                ].join('\n')
            };
        }

        const evaluatingGoalId = goal.id;
        const evaluatingGoalRevision = goal.revision;
        try {
            const evaluation = await GoalEvaluator.evaluate(task, goal);
            const currentGoal = task.goal_state;
            if (
                !currentGoal ||
                currentGoal.id !== evaluatingGoalId ||
                currentGoal.revision !== evaluatingGoalRevision ||
                currentGoal.status !== 'active'
            ) {
                return { operation: 'finish' };
            }
            const result = GoalController.recordEvaluation(task, evaluation);
            if (result.action === 'continue') {
                return { operation: 'reject', message: result.continuationPrompt };
            }
        } catch (error) {
            const currentGoal = task.goal_state;
            if (
                currentGoal?.id === evaluatingGoalId &&
                currentGoal.revision === evaluatingGoalRevision &&
                currentGoal.status === 'active'
            ) {
                GoalController.recordEvaluatorFailure(task, currentGoal, error);
            }
        }
        return { operation: 'finish' };
    };
    HookRegistry.beforeFinishTurn(registeredCallback, { priority: 300, phase: 'goal_evaluation' });
}
