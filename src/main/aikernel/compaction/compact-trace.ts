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

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { getTaskArtifactDirectory } from '../../utils/setting.js';

export interface CompactTraceEntry {
    level?: 'info';
    source: string;
    event: string;
    message: string;
    data?: Record<string, unknown>;
}

export type CompactVariant = 'message_tail' | 'boundary_partial_assistant' | 'boundary_user_partial_assistant';

interface CompactTraceKeepAnchorLike {
    kind?: 'message_start' | 'assistant_round';
    messageId?: string;
    messageIndex?: number;
    roundRef?: {
        roundIndex?: number;
    };
    startPartIndex?: number;
}

interface CompactTraceProjectedItemLike {
    kind?: 'compact_boundary' | 'user_message' | 'assistant_round';
    messageIndex?: number;
}

interface CompactTracePlanLike {
    physicalKeepStartIndex?: number;
    keepAnchor?: CompactTraceKeepAnchorLike;
    projectedItemsToKeep?: CompactTraceProjectedItemLike[];
}

interface CompactTraceActiveContextLike {
    startIndex: number;
    messages: Array<{ role?: string }>;
    leadingPartialAssistant?: {
        message: {
            message_id: string;
        };
        messageIndex: number;
        roundRef: {
            roundIndex: number;
            startPartIndex: number;
        };
    };
}

export interface CompactVariantTraceData {
    compactVariant: CompactVariant;
    physicalKeepStartIndex?: number;
    keepAnchorKind: 'message_start' | 'assistant_round';
    keepAnchorMessageId?: string;
    keepAnchorMessageIndex?: number;
    kept_anchor_round_index?: number;
    kept_anchor_start_part_index?: number;
    recentUserPreserved: boolean;
    preservedVisibleUserCount: number;
}

export interface ActiveContextVariantTraceData {
    compactVariant: CompactVariant;
    startsInsideAssistant: boolean;
    recentUserPreserved: boolean;
    preservedVisibleUserCount: number;
    keepAnchorMessageId?: string;
    keepAnchorMessageIndex?: number;
    kept_anchor_round_index?: number;
    kept_anchor_start_part_index?: number;
}

function getCompactVariant(
    keepAnchorKind: 'message_start' | 'assistant_round',
    recentUserPreserved: boolean
): CompactVariant {
    if (keepAnchorKind !== 'assistant_round') {
        return 'message_tail';
    }
    return recentUserPreserved ? 'boundary_user_partial_assistant' : 'boundary_partial_assistant';
}

export function describeCompactPlanVariant(plan: CompactTracePlanLike | undefined): CompactVariantTraceData {
    const keepAnchorKind = plan?.keepAnchor?.kind === 'assistant_round' ? 'assistant_round' : 'message_start';
    const keepAnchorMessageIndex =
        typeof plan?.keepAnchor?.messageIndex === 'number' ? plan.keepAnchor.messageIndex : undefined;
    let preservedVisibleUserCount =
        keepAnchorKind === 'assistant_round'
            ? (plan?.projectedItemsToKeep?.filter(
                  (item) =>
                      item.kind === 'user_message' &&
                      typeof item.messageIndex === 'number' &&
                      (keepAnchorMessageIndex === undefined || item.messageIndex < keepAnchorMessageIndex)
              ).length ?? 0)
            : 0;

    if (
        preservedVisibleUserCount === 0 &&
        keepAnchorKind === 'assistant_round' &&
        typeof plan?.physicalKeepStartIndex === 'number' &&
        keepAnchorMessageIndex !== undefined &&
        plan.physicalKeepStartIndex < keepAnchorMessageIndex
    ) {
        preservedVisibleUserCount = 1;
    }

    const recentUserPreserved = preservedVisibleUserCount > 0;

    return {
        compactVariant: getCompactVariant(keepAnchorKind, recentUserPreserved),
        physicalKeepStartIndex:
            typeof plan?.physicalKeepStartIndex === 'number' ? plan.physicalKeepStartIndex : undefined,
        keepAnchorKind,
        keepAnchorMessageId: plan?.keepAnchor?.messageId,
        keepAnchorMessageIndex,
        kept_anchor_round_index:
            typeof plan?.keepAnchor?.roundRef?.roundIndex === 'number'
                ? plan.keepAnchor.roundRef.roundIndex
                : undefined,
        kept_anchor_start_part_index:
            typeof plan?.keepAnchor?.startPartIndex === 'number' ? plan.keepAnchor.startPartIndex : undefined,
        recentUserPreserved,
        preservedVisibleUserCount
    };
}

export function describeActiveContextVariant(
    activeContext: CompactTraceActiveContextLike
): ActiveContextVariantTraceData {
    const startsInsideAssistant = activeContext.leadingPartialAssistant !== undefined;
    const keepAnchorMessageIndex = activeContext.leadingPartialAssistant?.messageIndex;
    const keepAnchorLocalIndex =
        startsInsideAssistant && keepAnchorMessageIndex !== undefined
            ? Math.max(0, Math.min(activeContext.messages.length, keepAnchorMessageIndex - activeContext.startIndex))
            : activeContext.messages.length;
    const preservedVisibleUserCount = startsInsideAssistant
        ? activeContext.messages.slice(0, keepAnchorLocalIndex).filter((message) => message.role === 'user').length
        : 0;
    const recentUserPreserved = preservedVisibleUserCount > 0;

    return {
        compactVariant: getCompactVariant(
            startsInsideAssistant ? 'assistant_round' : 'message_start',
            recentUserPreserved
        ),
        startsInsideAssistant,
        recentUserPreserved,
        preservedVisibleUserCount,
        keepAnchorMessageId: activeContext.leadingPartialAssistant?.message.message_id,
        keepAnchorMessageIndex,
        kept_anchor_round_index: activeContext.leadingPartialAssistant?.roundRef.roundIndex,
        kept_anchor_start_part_index: activeContext.leadingPartialAssistant?.roundRef.startPartIndex
    };
}

interface CompactTraceRecord extends CompactTraceEntry {
    ts: string;
    level: 'info';
    taskId: string;
}

function getCompactTracePath(taskId: string): string {
    return path.join(getTaskArtifactDirectory(taskId), 'compact.ndjson');
}

export function appendCompactTrace(taskId: string | undefined, entry: CompactTraceEntry): void {
    if (!taskId) {
        return;
    }

    const record: CompactTraceRecord = {
        ts: new Date().toISOString(),
        level: entry.level ?? 'info',
        taskId,
        source: entry.source,
        event: entry.event,
        message: entry.message,
        ...(entry.data ? { data: entry.data } : {})
    };

    try {
        fs.appendFileSync(getCompactTracePath(taskId), `${JSON.stringify(record)}\n`, {
            encoding: 'utf8'
        });
    } catch (error) {
        logger.warn(
            `[Compact Trace] failed to append trace for task ${taskId}: ` +
                `${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export function logCompactInfo(taskId: string | undefined, entry: CompactTraceEntry): void {
    logger.info(entry.message);
    appendCompactTrace(taskId, {
        ...entry,
        level: 'info'
    });
}
