import { HookRegistry } from '../hooks.js';
import { GoalController } from './controller.js';
import { GoalEvaluator } from './evaluator.js';
import { GoalStates, type GoalEvaluationRecord, type GoalState } from './state.js';
import { createUserGoalDataBlock } from './prompt-data.js';
import type { TaskUpdateGoalEvalChunk } from '../states/tasks.js';
import { t } from '../../../locale/index.js';

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
        ...(record.anchorMessageId ? { anchorMessageId: record.anchorMessageId } : {}),
        ...(typeof record.anchorMessageIndex === 'number' ? { anchorMessageIndex: record.anchorMessageIndex } : {}),
        phase: record.phase,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        ...(record.status ? { status: record.status } : {}),
        ...(record.message !== undefined ? { message: record.message } : {}),
        ...(record.evidence ? { evidence: record.evidence } : {}),
        ...(record.evaluatedAt ? { evaluatedAt: record.evaluatedAt } : {})
    };
}

function getEvaluationAnchor(task: any): Pick<GoalEvaluationRecord, 'anchorMessageId' | 'anchorMessageIndex'> {
    const messages = Array.isArray(task.chat_context?.messages) ? task.chat_context.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'assistant' && typeof message.message_id === 'string' && message.message_id.length > 0) {
            return {
                anchorMessageId: message.message_id,
                anchorMessageIndex: index
            };
        }
    }
    return {};
}

function hasPendingSupplements(goal: Pick<GoalState, 'pendingSupplements'> | undefined): boolean {
    return goal?.pendingSupplements.some((item) => !item.consumedAt) === true;
}

function supplementSupersededEvaluationMessage(): string {
    return t('goal.eval.superseded_by_supplement');
}

function editSupersededEvaluationMessage(): string {
    return t('goal.eval.superseded_by_edit');
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
        const evaluationAnchor = getEvaluationAnchor(task);

        // 通知 UI 评估开始
        const startRecord = GoalStates.recordEvaluationStart(goal, evaluationId, startedAt, evaluationAnchor);
        task.persistLater();
        task.publishChunkUpdate(chunkFromEvaluationRecord(task.task_id, startRecord), 'goal_eval');

        try {
            const evaluation = await GoalEvaluator.evaluate(task, goal);
            evaluation.evaluationId = evaluationId;
            evaluation.evaluatedAt = evaluation.evaluatedAt || new Date().toISOString();
            const currentGoal = task.goal_state;

            // 分三类处理评估过期。使用 evaluation.goalRevision（evaluator 实际读取的值）
            // 而非 evaluatingGoalRevision（hook 在 await 前的 snapshot），
            // 避免 edit 发生在 snapshot 和 evaluator 调用之间时误判过期。
            if (!currentGoal || currentGoal.id !== evaluatingGoalId) {
                // goal 已被 clear 或 replace → 静默丢弃，但需通知 UI 评估结束
                const evaluatedAt = new Date().toISOString();
                const endChunk: TaskUpdateGoalEvalChunk = {
                    type: 'goal_eval',
                    task_id: task.task_id,
                    goalId: evaluatingGoalId,
                    goalRevision: evaluatingGoalRevision,
                    evaluationId,
                    ...evaluationAnchor,
                    phase: 'end',
                    status: 'error',
                    message: t('goal.eval.superseded_by_status_change'),
                    startedAt,
                    evaluatedAt,
                    updatedAt: evaluatedAt
                };
                task.publishChunkUpdate(endChunk, 'goal_eval');
                return { operation: 'finish' };
            }
            if (currentGoal.revision !== evaluation.goalRevision) {
                // 编辑过期：丢弃旧评估，通知系统按新目标继续
                task.clearPendingGoalEditReminders();
                const evaluatedAt = new Date().toISOString();
                const endChunk: TaskUpdateGoalEvalChunk = {
                    type: 'goal_eval',
                    task_id: task.task_id,
                    goalId: currentGoal.id,
                    goalRevision: currentGoal.revision,
                    evaluationId,
                    ...evaluationAnchor,
                    phase: 'end',
                    status: 'superseded',
                    message: editSupersededEvaluationMessage(),
                    startedAt,
                    evaluatedAt,
                    updatedAt: evaluatedAt
                };
                task.publishChunkUpdate(endChunk, 'goal_eval');
                const message = [
                    '<system-reminder>',
                    editSupersededEvaluationMessage(),
                    '',
                    ...createUserGoalDataBlock('Goal data:', {
                        revision: currentGoal.revision,
                        objective: currentGoal.objective
                    }),
                    '</system-reminder>'
                ].join('\n');
                return { operation: 'reject', message };
            }
            if (currentGoal.status !== 'active') {
                // goal 被 pause/blocked/complete/cleared → 静默丢弃，但需通知 UI 评估结束
                const evaluatedAt = new Date().toISOString();
                const endChunk: TaskUpdateGoalEvalChunk = {
                    type: 'goal_eval',
                    task_id: task.task_id,
                    goalId: evaluatingGoalId,
                    goalRevision: evaluatingGoalRevision,
                    evaluationId,
                    ...evaluationAnchor,
                    phase: 'end',
                    status: 'error',
                    message: t('goal.eval.superseded_by_status_change'),
                    startedAt,
                    evaluatedAt,
                    updatedAt: evaluatedAt
                };
                task.publishChunkUpdate(endChunk, 'goal_eval');
                return { operation: 'finish' };
            }
            if (hasPendingSupplements(currentGoal)) {
                const message = supplementSupersededEvaluationMessage();
                const endRecord = GoalStates.recordEvaluationEnd(currentGoal, {
                    evaluationId,
                    status: 'not_met',
                    message,
                    evaluatedAt: evaluation.evaluatedAt
                });
                task.persistLater();
                task.publishChunkUpdate(chunkFromEvaluationRecord(task.task_id, endRecord), 'goal_eval');
                return {
                    operation: 'reject',
                    message
                };
            }
            const result = GoalController.recordEvaluation(task, evaluation);
            const endRecord = currentGoal.evaluationHistory?.find((item) => item.evaluationId === evaluationId);
            const chunk: TaskUpdateGoalEvalChunk = endRecord
                ? chunkFromEvaluationRecord(task.task_id, endRecord)
                : {
                      type: 'goal_eval',
                      task_id: task.task_id,
                      goalId: evaluatingGoalId,
                      goalRevision: evaluatingGoalRevision,
                      evaluationId,
                      ...evaluationAnchor,
                      phase: 'end',
                      status: evaluation.status,
                      message: evaluation.reason,
                      evidence: evaluation.evidence,
                      startedAt,
                      evaluatedAt: evaluation.evaluatedAt,
                      updatedAt: evaluation.evaluatedAt
                  };
            if (result.action === 'continue' && result.continuationPrompt) {
                chunk.nextPrompt = result.continuationPrompt;
            }
            task.publishChunkUpdate(chunk, 'goal_eval');
            if (result.action === 'continue') {
                return { operation: 'reject', message: result.continuationPrompt };
            }
        } catch (error) {
            const evaluatedAt = new Date().toISOString();
            const message = error instanceof Error ? error.message : String(error);
            const evidence = ['Evaluator failed before producing a valid structured result'];
            const currentGoal = task.goal_state;

            // 在 catch 块中也处理编辑过期：evaluator 抛异常 + 编辑同时发生
            if (
                currentGoal &&
                currentGoal.id === evaluatingGoalId &&
                currentGoal.revision !== evaluatingGoalRevision &&
                currentGoal.status === 'active'
            ) {
                task.clearPendingGoalEditReminders();
                const editMessage = [
                    '<system-reminder>',
                    editSupersededEvaluationMessage(),
                    '',
                    ...createUserGoalDataBlock('Goal data:', {
                        revision: currentGoal.revision,
                        objective: currentGoal.objective
                    }),
                    '</system-reminder>'
                ].join('\n');
                // 不 publish 错误 chunk，直接返回 reject 触发重试
                return { operation: 'reject', message: editMessage };
            }

            if (
                currentGoal?.id === evaluatingGoalId &&
                currentGoal.revision === evaluatingGoalRevision &&
                currentGoal.status === 'active'
            ) {
                if (hasPendingSupplements(currentGoal)) {
                    const supersededMessage = supplementSupersededEvaluationMessage();
                    const endRecord = GoalStates.recordEvaluationEnd(currentGoal, {
                        evaluationId,
                        status: 'not_met',
                        message: supersededMessage,
                        evaluatedAt
                    });
                    task.persistLater();
                    task.publishChunkUpdate(chunkFromEvaluationRecord(task.task_id, endRecord), 'goal_eval');
                    return {
                        operation: 'reject',
                        message: supersededMessage
                    };
                }
                GoalController.recordEvaluatorFailure(task, currentGoal, error, evaluationId, evaluatedAt);
            }
            // 通知 UI 评估出错
            const errorChunk: TaskUpdateGoalEvalChunk = {
                type: 'goal_eval',
                task_id: task.task_id,
                goalId: evaluatingGoalId,
                goalRevision: evaluatingGoalRevision,
                evaluationId,
                ...evaluationAnchor,
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
