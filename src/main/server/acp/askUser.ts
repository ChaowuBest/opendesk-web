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

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type {
    AskUserProvider,
    AskUserRequest,
    AskUserResponse,
    AskUserQuestion
} from '../../aikernel/interaction/tools.js';
import { logger } from '../../utils/logger.js';

// ─── Elicitation 方案（优先） ─────────────────────────────────────────────────

/**
 * 将 askUser 的问题列表映射为 ACP elicitation form 的 JSON Schema。
 */
function buildElicitationSchema(questions: AskUserQuestion[]): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const key = `q${i}`;
        required.push(key);

        if (q.multiple) {
            properties[key] = {
                type: 'array',
                title: q.header,
                description: q.question,
                items: {
                    anyOf: q.options.map((o) => ({
                        const: o.label,
                        title: o.label
                    }))
                }
            };
        } else {
            properties[key] = {
                type: 'string',
                title: q.header,
                description: q.question,
                oneOf: q.options.map((o) => ({
                    const: o.label,
                    title: o.label
                }))
            };
        }
    }

    return {
        type: 'object',
        properties,
        required
    };
}

function extractElicitationAnswers(
    content: Record<string, unknown> | null | undefined,
    questions: AskUserQuestion[]
): Record<number, string[]> {
    const answers: Record<number, string[]> = {};
    if (!content) return answers;

    for (let i = 0; i < questions.length; i++) {
        const key = `q${i}`;
        const value = content[key];
        if (value == null) continue;

        if (Array.isArray(value)) {
            answers[i] = value.map(String);
        } else {
            answers[i] = [String(value)];
        }
    }

    return answers;
}

async function tryElicitation(
    connection: AgentSideConnection,
    sessionId: string,
    request: AskUserRequest
): Promise<AskUserResponse> {
    const questions = request.questions;
    const message = questions.length === 1 ? questions[0].question : `${request.taskName || 'Agent'} 需要你的输入`;

    const response = await connection.unstable_createElicitation({
        mode: 'form',
        sessionId,
        message,
        requestedSchema: buildElicitationSchema(questions) as any
    });

    if (response.action === 'accept') {
        return { answers: extractElicitationAnswers(response.content, questions) };
    }

    return { cancelled: true, answers: {} };
}

// ─── requestPermission 方案（fallback） ──────────────────────────────────────

function buildPermissionToolCall(requestId: string, question: AskUserQuestion) {
    return {
        toolCallId: `ask-${requestId}`,
        title: `Ask: ${question.header}`,
        kind: 'other' as const,
        status: 'pending' as const,
        rawInput: {
            question: question.question,
            header: question.header,
            options: question.options
        }
    };
}

/**
 * 通过 requestPermission 逐个问题向用户提问。
 * requestPermission 是 ACP 稳定 API，所有客户端都支持。
 *
 * 限制：
 * - 不支持多选（permission 只能单选），多选问题降级为单选
 * - 选项显示为 permission options，客户端可能用 Allow/Deny 样式展示
 */
async function promptViaPermission(
    connection: AgentSideConnection,
    sessionId: string,
    request: AskUserRequest
): Promise<AskUserResponse> {
    const answers: Record<number, string[]> = {};

    for (let i = 0; i < request.questions.length; i++) {
        const q = request.questions[i];

        const response = await connection.requestPermission({
            sessionId,
            toolCall: buildPermissionToolCall(`${request.requestId}-${i}`, q),
            options: q.options.map((o) => ({
                optionId: o.label,
                name: o.label,
                kind: 'allow_once' as const
            }))
        });

        if (response.outcome.outcome === 'cancelled') {
            return { cancelled: true, answers: {} };
        }

        if (response.outcome.outcome === 'selected') {
            answers[i] = [response.outcome.optionId];
        }
    }

    return { answers };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * ACP 环境下的 AskUserProvider 实现。
 *
 * 采用双重策略：
 * 1. 优先使用 unstable_createElicitation（语义最匹配，支持多选/form）
 * 2. 失败时 fallback 到 requestPermission（ACP 稳定 API，所有客户端都支持）
 */
export class AcpAskUserProvider implements AskUserProvider {
    constructor(
        private readonly connection: AgentSideConnection,
        private readonly sessionId: string
    ) {}

    async prompt(request: AskUserRequest): Promise<AskUserResponse> {
        if (request.questions.length === 0) {
            return { answers: {} };
        }

        // 策略1：尝试 unstable_createElicitation
        try {
            return await tryElicitation(this.connection, this.sessionId, request);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.debug(
                `AcpAskUserProvider: elicitation not supported (${reason}), falling back to requestPermission`
            );
        }

        // 策略2：fallback 到 requestPermission
        try {
            return await promptViaPermission(this.connection, this.sessionId, request);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.warn(`AcpAskUserProvider: requestPermission fallback also failed: ${reason}`);
            return { cancelled: true, answers: {} };
        }
    }
}
