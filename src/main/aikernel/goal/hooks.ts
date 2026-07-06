import { HookRegistry } from '../hooks.js';
import { GoalController } from './controller.js';
import { GoalEvaluator } from './evaluator.js';
import { GoalStates, type GoalEvaluationRecord } from './state.js';
import type { TaskUpdateGoalEvalChunk } from '../states/tasks.js';

let registeredCallback:
    | ((task: any) => Promise<{ operation: 'finish' } | { operation: 'reject'; message: string }>)
    | undefined;

function chunkFromEvaluationRecord(taskId: string, record: GoalEvaluationRecord): TaskUpdateGoalEvalChunk {
    return {
        type: 'goal_eval',
        task_id: taskId,
        goalId: record.goalId,
        goalRevision: record.goalRevision,
        evaluationId: record.evaluationId,
        phase: record.phase,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        ...(record.status ? { status: record.status } : {}),
        ...(record.message !== undefined ? { message: record.message } : {}),
        ...(record.evidence ? { evidence: record.evidence } : {}),
        ...(record.evaluatedAt ? { evaluatedAt: record.evaluatedAt } : {})
    };
}

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
        const evaluationId = crypto.randomUUID();
        const startedAt = new Date().toISOString();

        // 通知 UI 评估开始
        const startRecord = GoalStates.recordEvaluationStart(goal, evaluationId, startedAt);
        task.persistLater();
        task.publishChunkUpdate(chunkFromEvaluationRecord(task.task_id, startRecord), 'goal_eval');

        try {
            const evaluation = await GoalEvaluator.evaluate(task, goal);
            evaluation.evaluationId = evaluationId;
            evaluation.evaluatedAt = evaluation.evaluatedAt || new Date().toISOString();
            const currentGoal = task.goal_state;

            if (
                !currentGoal ||
                currentGoal.id !== evaluatingGoalId ||
                currentGoal.revision !== evaluatingGoalRevision ||
                currentGoal.status !== 'active'
            ) {
                task.publishChunkUpdate(
                    {
                        type: 'goal_eval',
                        task_id: task.task_id,
                        goalId: evaluatingGoalId,
                        goalRevision: evaluatingGoalRevision,
                        evaluationId,
                        phase: 'end',
                        status: evaluation.status,
                        message: evaluation.reason,
                        evidence: evaluation.evidence,
                        startedAt,
                        evaluatedAt: evaluation.evaluatedAt,
                        updatedAt: evaluation.evaluatedAt
                    },
                    'goal_eval'
                );
                return { operation: 'finish' };
            }
            const result = GoalController.recordEvaluation(task, evaluation);
            const endRecord = currentGoal.evaluationHistory?.find((item) => item.evaluationId === evaluationId);
            task.publishChunkUpdate(
                endRecord
                    ? chunkFromEvaluationRecord(task.task_id, endRecord)
                    : {
                          type: 'goal_eval',
                          task_id: task.task_id,
                          goalId: evaluatingGoalId,
                          goalRevision: evaluatingGoalRevision,
                          evaluationId,
                          phase: 'end',
                          status: evaluation.status,
                          message: evaluation.reason,
                          evidence: evaluation.evidence,
                          startedAt,
                          evaluatedAt: evaluation.evaluatedAt,
                          updatedAt: evaluation.evaluatedAt
                      },
                'goal_eval'
            );
            if (result.action === 'continue') {
                return { operation: 'reject', message: result.continuationPrompt };
            }
        } catch (error) {
            const evaluatedAt = new Date().toISOString();
            const message = error instanceof Error ? error.message : String(error);
            const evidence = ['Evaluator failed before producing a valid structured result'];
            const currentGoal = task.goal_state;
            if (
                currentGoal?.id === evaluatingGoalId &&
                currentGoal.revision === evaluatingGoalRevision &&
                currentGoal.status === 'active'
            ) {
                GoalController.recordEvaluatorFailure(task, currentGoal, error, evaluationId, evaluatedAt);
            }
            // 通知 UI 评估出错
            const errorChunk: TaskUpdateGoalEvalChunk = {
                type: 'goal_eval',
                task_id: task.task_id,
                goalId: evaluatingGoalId,
                goalRevision: evaluatingGoalRevision,
                evaluationId,
                phase: 'end',
                status: 'error',
                message,
                evidence,
                startedAt,
                evaluatedAt,
                updatedAt: evaluatedAt
            };
            task.publishChunkUpdate(errorChunk, 'goal_eval');
        }
        return { operation: 'finish' };
    };
    HookRegistry.beforeFinishTurn(registeredCallback, { priority: 900, phase: 'goal_evaluation' });
}
