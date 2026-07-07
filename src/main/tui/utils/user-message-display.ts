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

import type { RuntimeMetadata } from '../../aikernel/messages.js';

export interface TuiUserMessageDisplayLike {
    internal?: boolean;
    rawText?: string;
    metadata?: RuntimeMetadata;
}

export function getGoalSupplementDisplayText(message: TuiUserMessageDisplayLike): string | undefined {
    if (
        message.internal === true &&
        message.metadata?.origin?.reason === 'goal_supplement' &&
        typeof message.rawText === 'string'
    ) {
        const text = message.rawText.trim();
        return text.length > 0 ? text : undefined;
    }
    return undefined;
}

export function shouldRenderTuiUserMessage(message: TuiUserMessageDisplayLike): boolean {
    return message.internal !== true || getGoalSupplementDisplayText(message) !== undefined;
}

export function isGoalSupplementRawTextConsumed(rawText: string, pendingText: string): boolean {
    const text = rawText.trim();
    const pending = pendingText.trim();
    if (!text || !pending) return false;

    return (
        pending === text ||
        text.startsWith(`${pending}\n\n`) ||
        text.endsWith(`\n\n${pending}`) ||
        text.includes(`\n\n${pending}\n\n`)
    );
}
