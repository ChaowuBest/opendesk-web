import { HookRegistry } from '../hooks.js';
import { GoalController } from './controller.js';
import { GoalEvaluator } from './evaluator.js';
import type { TaskUpdateGoalEvalChunk } from '../states/tasks.js';

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

        const evaluatingGoalId = goal.id;
        const evaluatingGoalRevision = goal.revision;

        // 通知 UI 评估开始
        const startChunk: TaskUpdateGoalEvalChunk = {
            type: 'goal_eval',
            task_id: task.task_id,
            phase: 'start'
        };
        task.publishChunkUpdate(startChunk, 'goal_eval');

        try {
            const evaluation = await GoalEvaluator.evaluate(task, goal);
            const currentGoal = task.goal_state;

            // 通知 UI 评估结束（含结果）
            const endChunk: TaskUpdateGoalEvalChunk = {
                type: 'goal_eval',
                task_id: task.task_id,
                phase: 'end',
                status: evaluation.status,
                message: evaluation.reason,
                evidence: evaluation.evidence
            };
            task.publishChunkUpdate(endChunk, 'goal_eval');

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
            // 通知 UI 评估出错
            const errorChunk: TaskUpdateGoalEvalChunk = {
                type: 'goal_eval',
                task_id: task.task_id,
                phase: 'end',
                status: 'error',
                message: error instanceof Error ? error.message : String(error)
            };
            task.publishChunkUpdate(errorChunk, 'goal_eval');

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
    HookRegistry.beforeFinishTurn(registeredCallback, { priority: 900, phase: 'goal_evaluation' });
}
