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

import type { TaskState } from '../../../aikernel/states/tasks.js';
import { AssistantMessage, UserMessage } from '../../../aikernel/messages.js';
import { getGoalTokenUsage } from '../../../aikernel/goal/controller.js';
import { GoalStates, type GoalFinalSnapshot, type GoalState } from '../../../aikernel/goal/state.js';
import { getGoalElapsedMs } from '../../../../common/goal/format.js';
import type { GoalPanelData } from '../goalpanel.js';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function getGoalTerminalTimestamp(goal: GoalState): number | undefined {
    const timestamp =
        goal.status === 'complete' ? goal.completedAt : goal.status === 'cleared' ? goal.clearedAt : undefined;
    if (!timestamp) return undefined;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function getTerminalGoalPanelData(task: TaskState): GoalPanelData | undefined {
    const goalState = task.goal_state ?? null;
    if (!goalState || !GoalStates.isTerminal(goalState.status)) return undefined;
    return {
        goalState,
        totalTokens: getGoalTokenUsage(task),
        elapsedMs: getGoalElapsedMs(goalState)
    };
}

export function goalStateFromFinalSnapshot(snapshot: GoalFinalSnapshot): GoalState {
    return {
        version: 1,
        id: snapshot.goalId,
        taskId: snapshot.taskId,
        objective: snapshot.objective,
        successCriteria: [],
        status: snapshot.status,
        revision: snapshot.goalRevision,
        attempts: 0,
        ...(snapshot.lastEvaluation ? { lastEvaluation: snapshot.lastEvaluation } : {}),
        evaluationHistory: [],
        pendingSupplements: [],
        editHistory: [],
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.finalizedAt,
        ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
        ...(snapshot.clearedAt ? { clearedAt: snapshot.clearedAt } : {})
    };
}

export function getGoalPanelDataFromFinalSnapshot(snapshot: GoalFinalSnapshot): GoalPanelData {
    return {
        goalState: goalStateFromFinalSnapshot(snapshot),
        totalTokens: snapshot.totalTokens,
        elapsedMs: snapshot.elapsedMs,
        evaluating: false
    };
}

export function getGoalSnapshotTimestamp(snapshot: GoalFinalSnapshot): number | undefined {
    const parsed = Date.parse(snapshot.finalizedAt);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function getMessageTimestamp(message: unknown): number | undefined {
    if (!(message instanceof UserMessage) && !(message instanceof AssistantMessage)) return undefined;
    if (message instanceof AssistantMessage) {
        // assistant 消息的时间语义统一在 execution 元数据上（turn 结束优先）；
        // 老任务的 legacy timestamp 已在反序列化边界（AssistantMessage.assign）迁移为 finishAt
        const execution = message.metadata?.execution;
        if (typeof execution?.finishAt === 'number') return execution.finishAt;
        if (typeof execution?.startAt === 'number') return execution.startAt;
        return undefined;
    }
    const timestamp = message.timestamp;
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
}

export function shouldInsertGoalSnapshotBeforeMessage(message: unknown, terminalAt?: number): boolean {
    if (terminalAt === undefined || !(message instanceof UserMessage) || message.internal === true) return false;
    return message.timestamp > terminalAt;
}

export function shouldInsertFinalSnapshotAfterMessage(
    message: unknown,
    messageIndex: number,
    nextMessage: unknown,
    snapshot: GoalFinalSnapshot
): boolean {
    if (snapshot.anchorMessageId && isRecord(message) && message.message_id === snapshot.anchorMessageId) {
        return true;
    }
    if (typeof snapshot.anchorMessageIndex === 'number' && snapshot.anchorMessageIndex === messageIndex) {
        return true;
    }
    if (snapshot.anchorMessageId || typeof snapshot.anchorMessageIndex === 'number') return false;

    const finalizedAt = getGoalSnapshotTimestamp(snapshot);
    const messageAt = getMessageTimestamp(message);
    if (finalizedAt === undefined || messageAt === undefined || messageAt > finalizedAt) return false;
    const nextAt = getMessageTimestamp(nextMessage);
    return nextAt === undefined || nextAt > finalizedAt;
}
