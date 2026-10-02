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

import { AssistantMessage, type AssistantMessagePart } from '../messages.js';
import type { ActiveContextView, AssistantRound, AssistantRoundKind, VisibleAssistantRound } from './types.js';

function countToolCalls(parts: AssistantMessagePart[]): number {
    return parts.reduce((total, part) => {
        if (part.type !== 'tool_call') {
            return total;
        }
        return total + part.toolcalls.length;
    }, 0);
}

function buildAssistantRound(
    message: AssistantMessage,
    roundIndex: number,
    startPartIndex: number,
    endPartIndexExclusive: number,
    kind: AssistantRoundKind
): AssistantRound {
    const parts = message.content.slice(startPartIndex, endPartIndexExclusive);
    return {
        ref: {
            assistantMessageId: message.message_id,
            roundIndex,
            startPartIndex,
            endPartIndexExclusive
        },
        kind,
        parts,
        toolCallCount: countToolCalls(parts)
    };
}

/**
 * 将单条 AssistantMessage 投影为多个逻辑 round。
 *
 * 切分规则：
 * - 顺序扫描 message.content
 * - 每遇到一个 tool_call part，就结束当前 round
 * - 消息末尾剩余的 reasoning / text / error 形成一个 message_tail round
 * - 当前粒度只到 part 边界，不进入 part 内部
 */
export function buildAssistantRounds(message: AssistantMessage): AssistantRound[] {
    if (message.content.length === 0) {
        return [];
    }

    const rounds: AssistantRound[] = [];
    let startPartIndex = 0;
    const completionStarts = new Set(message.usageCheckpoints?.map((checkpoint) => checkpoint.startPartIndex));

    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
        if (partIndex > startPartIndex && completionStarts.has(partIndex)) {
            rounds.push(buildAssistantRound(message, rounds.length, startPartIndex, partIndex, 'message_tail'));
            startPartIndex = partIndex;
        }
        const part = message.content[partIndex];
        if (part.type !== 'tool_call') {
            continue;
        }

        rounds.push(buildAssistantRound(message, rounds.length, startPartIndex, partIndex + 1, 'tool_call_batch'));
        startPartIndex = partIndex + 1;
    }

    if (startPartIndex < message.content.length) {
        rounds.push(
            buildAssistantRound(message, rounds.length, startPartIndex, message.content.length, 'message_tail')
        );
    }

    return rounds;
}

export function buildVisibleAssistantRounds(activeContext: ActiveContextView): VisibleAssistantRound[] {
    const visibleRounds: VisibleAssistantRound[] = [];

    for (
        let assistantMessageIndex = 0;
        assistantMessageIndex < activeContext.messages.length;
        assistantMessageIndex++
    ) {
        const message = activeContext.messages[assistantMessageIndex];
        if (!(message instanceof AssistantMessage)) {
            continue;
        }

        const messageIndex = activeContext.startIndex + assistantMessageIndex;
        const rounds = buildAssistantRounds(message);

        for (const round of rounds) {
            const leadingPartialAssistant = activeContext.leadingPartialAssistant;
            if (
                leadingPartialAssistant !== undefined &&
                leadingPartialAssistant.message === message &&
                leadingPartialAssistant.messageIndex === messageIndex &&
                round.ref.startPartIndex < leadingPartialAssistant.roundRef.startPartIndex
            ) {
                continue;
            }

            visibleRounds.push({
                message,
                assistantMessageIndex,
                messageIndex,
                round,
                roundRef: round.ref
            });
        }
    }

    return visibleRounds;
}
