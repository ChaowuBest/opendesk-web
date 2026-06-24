import { HookRegistry } from '../hooks.js';
import { getTaskTodosForDisplay } from '../todos/task-todos.js';
import { GoalController } from './controller.js';
import { GoalEvaluator } from './evaluator.js';

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
        if (todos.some((todo) => todo.status !== 'completed')) {
            return { operation: 'finish' };
        }

        try {
            const evaluation = await GoalEvaluator.evaluate(task, goal);
            const currentGoal = task.goal_state;
            if (
                !currentGoal ||
                currentGoal.id !== goal.id ||
                currentGoal.revision !== goal.revision ||
                currentGoal.status !== 'active'
            ) {
                return { operation: 'finish' };
            }
            const result = GoalController.recordEvaluation(task, evaluation);
            if (result.action === 'continue') {
                return { operation: 'reject', message: result.continuationPrompt };
            }
        } catch (error) {
            GoalController.recordEvaluatorFailure(task, goal, error);
        }
        return { operation: 'finish' };
    };
    HookRegistry.beforeFinishTurn(registeredCallback, { priority: 300, phase: 'goal_evaluation' });
}
