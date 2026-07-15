import { HookRegistry } from '../hooks.js';
import { GoalController } from './controller.js';
import { GoalEvaluator } from './evaluator.js';
import { GoalStates, type GoalEvaluationDisplayStatus, type GoalEvaluationRecord, type GoalState } from './state.js';
import { buildGoalRevisionNoticePrompt } from './prompts.js';
import type { TaskStatus, TaskUpdateGoalEvalChunk } from '../states/tasks.js';
import { t } from '../../../locale/index.js';

let registeredCallback:
    | ((task: any) => Promise<{ operation: 'finish' } | { operation: 'reject'; message: string }>)
    | undefined;

function chunkFromEvaluationRecord(
    taskId: string,
    taskStatus: TaskStatus,
    record: GoalEvaluationRecord
): TaskUpdateGoalEvalChunk {
    return {
        type: 'goal_eval',
        task_id: taskId,
        task_status: taskStatus,
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

function publishGoalEvaluationRecord(task: any, record: GoalEvaluationRecord): TaskUpdateGoalEvalChunk {
    const chunk = chunkFromEvaluationRecord(task.task_id, task.task_status, record);
    task.publishGoalEvalUpdate(chunk);
    return chunk;
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

function getGoalEditDisplayAnchor(
    task: any,
    goal: Pick<GoalState, 'id' | 'revision'>
): Pick<GoalEvaluationRecord, 'anchorMessageId' | 'anchorMessageIndex'> {
    const messages = Array.isArray(task.chat_context?.messages) ? task.chat_context.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (
            message?.role === 'user' &&
            typeof message.message_id === 'string' &&
            message.message_id.length > 0 &&
            message.metadata?.origin?.reason === 'goal_edit_display' &&
            message.metadata?.execution?.controllerId === goal.id &&
            message.metadata?.execution?.controllerRevision === goal.revision
        ) {
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

function finishGoalEvaluation(
    task: any,
    goal: GoalState,
    input: {
        evaluationId: string;
        status: GoalEvaluationDisplayStatus;
        message?: string;
        evidence?: string[];
        evaluatedAt?: string;
        anchor?: Pick<GoalEvaluationRecord, 'anchorMessageId' | 'anchorMessageIndex'>;
    }
): TaskUpdateGoalEvalChunk {
    const endRecord = GoalStates.recordEvaluationEnd(goal, {
        evaluationId: input.evaluationId,
        status: input.status,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.evaluatedAt ? { evaluatedAt: input.evaluatedAt } : {}),
        ...(input.anchor ? { anchor: input.anchor } : {})
    });
    task.persistLater();
    const chunk = chunkFromEvaluationRecord(task.task_id, task.task_status, endRecord);
    task.publishGoalEvalUpdate(chunk);
    return chunk;
}

function supplementSupersededEvaluationMessage(): string {
    return t('goal.eval.superseded_by_supplement');
}

function editSupersededEvaluationMessage(): string {
    return t('goal.eval.superseded_by_edit');
}

function clearCancelledEvaluationMessage(): string {
    return t('goal.eval.cancelled_by_clear');
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
        publishGoalEvaluationRecord(task, startRecord);

        try {
            const evaluation = await GoalEvaluator.evaluate(task, goal);
            evaluation.evaluationId = evaluationId;
            evaluation.evaluatedAt = evaluation.evaluatedAt || new Date().toISOString();
            const currentGoal = task.goal_state;

            // 分三类处理评估过期。使用 evaluation.goalRevision（evaluator 实际读取的值）
            // 而非 evaluatingGoalRevision（hook 在 await 前的 snapshot），
            // 避免 edit 发生在 snapshot 和 evaluator 调用之间时误判过期。
            if (!currentGoal || currentGoal.id !== evaluatingGoalId) {
                // goal 已被 replace，旧评估没有可落状态，不能发布孤立的 end chunk。
                return { operation: 'finish' };
            }
            if (currentGoal.revision !== evaluation.goalRevision) {
                // 编辑过期：丢弃旧评估，通知系统按新目标继续
                const evaluatedAt = new Date().toISOString();
                finishGoalEvaluation(task, currentGoal, {
                    evaluationId,
                    status: 'superseded',
                    message: editSupersededEvaluationMessage(),
                    evaluatedAt,
                    anchor: getGoalEditDisplayAnchor(task, currentGoal)
                });
                const message = buildGoalRevisionNoticePrompt(editSupersededEvaluationMessage(), {
                    revision: currentGoal.revision,
                    objective: currentGoal.objective
                });
                return { operation: 'reject', message };
            }
            if (currentGoal.status !== 'active') {
                // goal 被 pause/blocked/complete/cleared → 静默丢弃，但需通知 UI 评估结束
                const evaluatedAt = new Date().toISOString();
                finishGoalEvaluation(task, currentGoal, {
                    evaluationId,
                    status: currentGoal.status === 'cleared' ? 'cancelled' : 'error',
                    message:
                        currentGoal.status === 'cleared'
                            ? clearCancelledEvaluationMessage()
                            : t('goal.eval.superseded_by_status_change'),
                    evaluatedAt
                });
                return { operation: 'finish' };
            }
            if (hasPendingSupplements(currentGoal)) {
                const message = supplementSupersededEvaluationMessage();
                finishGoalEvaluation(task, currentGoal, {
                    evaluationId,
                    status: 'not_met',
                    message,
                    evaluatedAt: evaluation.evaluatedAt
                });
                return {
                    operation: 'reject',
                    message
                };
            }
            const result = GoalController.recordEvaluation(task, evaluation);
            const chunk = result.evaluationRecord
                ? chunkFromEvaluationRecord(task.task_id, task.task_status, result.evaluationRecord)
                : undefined;
            if (chunk) task.publishGoalEvalUpdate(chunk);
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
                const editMessage = buildGoalRevisionNoticePrompt(editSupersededEvaluationMessage(), {
                    revision: currentGoal.revision,
                    objective: currentGoal.objective
                });
                finishGoalEvaluation(task, currentGoal, {
                    evaluationId,
                    status: 'superseded',
                    message: editSupersededEvaluationMessage(),
                    evaluatedAt,
                    anchor: getGoalEditDisplayAnchor(task, currentGoal)
                });
                return { operation: 'reject', message: editMessage };
            }

            if (
                currentGoal?.id === evaluatingGoalId &&
                currentGoal.revision === evaluatingGoalRevision &&
                currentGoal.status === 'active'
            ) {
                if (hasPendingSupplements(currentGoal)) {
                    const supersededMessage = supplementSupersededEvaluationMessage();
                    finishGoalEvaluation(task, currentGoal, {
                        evaluationId,
                        status: 'not_met',
                        message: supersededMessage,
                        evaluatedAt
                    });
                    return {
                        operation: 'reject',
                        message: supersededMessage
                    };
                }
                const result = GoalController.recordEvaluatorFailure(
                    task,
                    currentGoal,
                    error,
                    evaluationId,
                    evaluatedAt
                );
                if (result.evaluationRecord) {
                    publishGoalEvaluationRecord(task, result.evaluationRecord);
                }
            } else if (currentGoal?.id === evaluatingGoalId && currentGoal.revision === evaluatingGoalRevision) {
                finishGoalEvaluation(task, currentGoal, {
                    evaluationId,
                    status: 'error',
                    message,
                    evidence,
                    evaluatedAt
                });
                return { operation: 'finish' };
            }
        }
        return { operation: 'finish' };
    };
    HookRegistry.beforeFinishTurn(registeredCallback, { priority: 900, phase: 'goal_evaluation' });
}
