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

import {
    AssistantMessage,
    ChatContext,
    ImageMessagePart,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../messages.js';
import type { AgentRuntimeToolStatus, AgentRuntimeUpdate } from './common.js';

export interface AgentRuntimeTurnHost {
    chatContext: ChatContext;
    publishUserMessage(): Promise<void>;
    publishAssistantPart(partIndex: number): Promise<void>;
}

function stringifyProtocolValue(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function mapToolStatus(status: AgentRuntimeToolStatus): ToolCall['status'] {
    switch (status) {
        case 'in_progress':
            return 'running';
        case 'completed':
            return 'success';
        case 'failed':
        case 'cancelled':
            return 'error';
        default:
            return 'pending';
    }
}

export class AgentRuntimeTurnController {
    private assistant?: AssistantMessage;
    private readonly toolCalls = new Map<string, { call: ToolCall; partIndex: number }>();

    constructor(private readonly host: AgentRuntimeTurnHost) {}

    async start(prompt: string, imageDataUris: string[] = []): Promise<void> {
        if (this.assistant) {
            throw new Error('Agent runtime turn has already started');
        }
        const userMessage = new UserMessage(prompt);
        for (const dataUri of imageDataUris) {
            userMessage.content.push(new ImageMessagePart(dataUri));
        }
        this.host.chatContext.appendMessage(userMessage);
        await this.host.publishUserMessage();
        this.assistant = new AssistantMessage([], { allowThinkTagParsing: false });
        this.host.chatContext.appendMessage(this.assistant);
    }

    async apply(update: AgentRuntimeUpdate): Promise<void> {
        const assistant = this.requireAssistant();
        switch (update.type) {
            case 'message_delta':
                assistant.appendText(update.text);
                await this.publishLastPart();
                return;
            case 'thought_delta':
                assistant.appendReasoningContent(update.text);
                await this.publishLastPart();
                return;
            case 'tool_call':
                await this.applyToolCall(update);
                return;
            case 'error':
                assistant.appendError(update.title, update.message);
                await this.publishLastPart();
                return;
            case 'plan':
            case 'metadata':
                return;
        }
    }

    finish(): void {
        const assistant = this.requireAssistant();
        assistant.finalizeReasoningTiming();
        for (const part of assistant.content) {
            if (part.type === 'text' || part.type === 'reasoning') {
                part.freezeRender();
            }
        }
    }

    private async applyToolCall(update: Extract<AgentRuntimeUpdate, { type: 'tool_call' }>): Promise<void> {
        const assistant = this.requireAssistant();
        let tracked = this.toolCalls.get(update.toolCallId);
        if (!tracked) {
            const call = new ToolCall(
                this.toolCalls.size,
                update.toolCallId,
                update.title,
                stringifyProtocolValue(update.rawInput)
            );
            call.args_object = update.rawInput ?? {};
            const part = new ToolCallMessagePart();
            part.push(call);
            assistant.content.push(part);
            tracked = { call, partIndex: assistant.content.length - 1 };
            this.toolCalls.set(update.toolCallId, tracked);
        }

        tracked.call.tool_name = update.title || tracked.call.tool_name;
        tracked.call.status = mapToolStatus(update.status);
        if (update.rawInput !== undefined) {
            tracked.call.args_object = update.rawInput;
            tracked.call.args_string = stringifyProtocolValue(update.rawInput);
        }
        if (update.rawOutput !== undefined) {
            tracked.call.result = stringifyProtocolValue(update.rawOutput);
            if (update.rawOutput && typeof update.rawOutput === 'object') {
                tracked.call.result_object = update.rawOutput as object;
            }
        }
        tracked.call.rendered = undefined;
        const part = assistant.content[tracked.partIndex];
        if (part?.type === 'tool_call') {
            part.rendered = undefined;
        }
        await this.host.publishAssistantPart(tracked.partIndex);
    }

    private async publishLastPart(): Promise<void> {
        const assistant = this.requireAssistant();
        await this.host.publishAssistantPart(assistant.content.length - 1);
    }

    private requireAssistant(): AssistantMessage {
        if (!this.assistant) {
            throw new Error('Agent runtime turn has not started');
        }
        return this.assistant;
    }
}
