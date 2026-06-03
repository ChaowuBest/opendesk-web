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

import crypto from 'crypto';
import type { AskUserProvider, AskUserRequest, AskUserResponse } from '../aikernel/interaction/tools.js';
import { EventBus } from './event-bus.js';

export type OpenCodeQuestionAnswer = string[];

export interface OpenCodeQuestionRequest {
    id: string;
    sessionID: string;
    questions: Array<{
        question: string;
        header: string;
        options: Array<{
            label: string;
            description: string;
        }>;
        multiple?: boolean;
        custom?: boolean;
    }>;
    tool?: {
        messageID: string;
        callID: string;
    };
}

export interface OpenCodeQuestionReplyBody {
    answers: OpenCodeQuestionAnswer[];
}

interface PendingQuestion {
    info: OpenCodeQuestionRequest;
    directory?: string;
    resolve: (response: AskUserResponse) => void;
}

let _questionCounter = 0;

function ascendingQuestionId(): string {
    const seq = (++_questionCounter).toString(36).padStart(4, '0');
    return `que_${Date.now().toString(36)}_${seq}_${crypto.randomBytes(3).toString('hex')}`;
}

function toExternalSessionId(taskId: string): string {
    if (taskId.startsWith('task_')) {
        return taskId.replace('task_', 'ses_');
    }
    return taskId;
}

function toAskUserAnswers(answers: OpenCodeQuestionAnswer[]): Record<number, string[]> {
    const result: Record<number, string[]> = {};
    answers.forEach((answer, index) => {
        result[index] = Array.isArray(answer) ? answer.map(String) : [];
    });
    return result;
}

export class ServerQuestionBroker implements AskUserProvider {
    private static instance: ServerQuestionBroker | null = null;
    private pending = new Map<string, PendingQuestion>();

    static getInstance(): ServerQuestionBroker {
        if (!ServerQuestionBroker.instance) {
            ServerQuestionBroker.instance = new ServerQuestionBroker();
        }
        return ServerQuestionBroker.instance;
    }

    list(): OpenCodeQuestionRequest[] {
        return Array.from(this.pending.values()).map((entry) => entry.info);
    }

    async prompt(request: AskUserRequest): Promise<AskUserResponse> {
        const id = ascendingQuestionId();
        const directory = request.workspace;
        const info: OpenCodeQuestionRequest = {
            id,
            sessionID: toExternalSessionId(request.taskId),
            questions: request.questions.map((question) => ({
                question: question.question,
                header: question.header,
                options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description
                })),
                multiple: question.multiple,
                custom: true
            }))
        };

        return await new Promise<AskUserResponse>((resolve) => {
            this.pending.set(id, { info, directory, resolve });
            EventBus.publish({
                type: 'question.asked',
                directory,
                properties: info as unknown as Record<string, unknown>
            });
        });
    }

    reply(requestID: string, body: OpenCodeQuestionReplyBody): boolean {
        const pending = this.pending.get(requestID);
        if (!pending) return false;

        this.pending.delete(requestID);
        const answers = body.answers.map((answer) => (Array.isArray(answer) ? answer.map(String) : []));
        EventBus.publish({
            type: 'question.replied',
            directory: pending.directory,
            properties: {
                sessionID: pending.info.sessionID,
                requestID,
                answers
            }
        });
        pending.resolve({
            answers: toAskUserAnswers(answers)
        });
        return true;
    }

    reject(requestID: string): boolean {
        const pending = this.pending.get(requestID);
        if (!pending) return false;

        this.pending.delete(requestID);
        EventBus.publish({
            type: 'question.rejected',
            directory: pending.directory,
            properties: {
                sessionID: pending.info.sessionID,
                requestID
            }
        });
        pending.resolve({ cancelled: true, answers: {} });
        return true;
    }

    dispose(): void {
        for (const pending of this.pending.values()) {
            pending.resolve({ cancelled: true, answers: {} });
        }
        this.pending.clear();
    }
}
