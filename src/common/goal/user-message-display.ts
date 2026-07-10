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

export interface GoalUserMessageDisplayLike {
    internal?: boolean;
    rawText?: string;
    metadata?: {
        origin?: {
            reason?: string;
        };
        execution?: {
            supplementIds?: unknown;
        };
    };
}

export function getGoalSupplementDisplayText(message: GoalUserMessageDisplayLike): string | undefined {
    if (
        message.internal === true &&
        (message.metadata?.origin?.reason === 'goal_supplement' ||
            message.metadata?.origin?.reason === 'goal_blocked_resume_display') &&
        typeof message.rawText === 'string'
    ) {
        const text = message.rawText.trim();
        return text.length > 0 ? text : undefined;
    }
    return undefined;
}

export function getGoalSupplementIds(message: GoalUserMessageDisplayLike): string[] {
    if (message.internal !== true || message.metadata?.origin?.reason !== 'goal_supplement') {
        return [];
    }
    const ids = message.metadata.execution?.supplementIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

export function shouldRenderGoalUserMessage(message: GoalUserMessageDisplayLike): boolean {
    return message.internal !== true || getGoalSupplementDisplayText(message) !== undefined;
}
