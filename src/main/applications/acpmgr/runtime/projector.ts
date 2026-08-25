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
    ReasoningMessagePart,
    TextMessagePart,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../aikernel/messages.js';
import type { AcpProjectedToolStatus, AcpProjectedUpdate } from './types.js';

export interface AcpMessageProjectorHost {
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

function mapToolStatus(status: AcpProjectedToolStatus): ToolCall['status'] {
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

export class AcpMessageProjector {
    private assistant?: AssistantMessage;
    private readonly toolCalls = new Map<string, { call: ToolCall; partIndex: number }>();
    private readonly messageParts = new Map<string, number>();
    private readonly thoughtParts = new Map<string, number>();

    constructor(private readonly host: AcpMessageProjectorHost) {}

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

    async apply(update: AcpProjectedUpdate): Promise<void> {
        const assistant = this.requireAssistant();
        switch (update.type) {
            case 'message_delta':
                await this.applyMessageText(update.text, update.messageId, false, false);
                return;
            case 'message_replace':
                await this.applyMessageText(update.text, update.messageId, false, true);
                return;
            case 'thought_delta':
                await this.applyMessageText(update.text, update.messageId, true, false);
                return;
            case 'thought_replace':
                await this.applyMessageText(update.text, update.messageId, true, true);
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

    async ensureOutputPart(): Promise<void> {
        const assistant = this.requireAssistant();
        if (assistant.content.length === 0) {
            assistant.appendText('');
            await this.publishLastPart();
        }
    }

    private async applyToolCall(update: Extract<AcpProjectedUpdate, { type: 'tool_call' }>): Promise<void> {
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

    private async applyMessageText(
        text: string,
        messageId: string | undefined,
        thought: boolean,
        replace: boolean
    ): Promise<void> {
        const assistant = this.requireAssistant();
        if (!messageId) {
            if (thought) assistant.appendReasoningContent(text);
            else assistant.appendText(text);
            await this.publishLastPart();
            return;
        }
        const parts = thought ? this.thoughtParts : this.messageParts;
        let partIndex = parts.get(messageId);
        if (partIndex === undefined) {
            const part = thought ? new ReasoningMessagePart(text, 'reasoning_content') : new TextMessagePart(text);
            assistant.content.push(part);
            partIndex = assistant.content.length - 1;
            parts.set(messageId, partIndex);
        } else {
            const part = assistant.content[partIndex];
            if (thought && part?.type === 'reasoning') {
                part.content = replace ? text : part.content + text;
                part.invalidateRender();
            } else if (!thought && part?.type === 'text') {
                part.text = replace ? text : part.text + text;
                part.invalidateRender();
            }
        }
        await this.host.publishAssistantPart(partIndex);
    }

    private requireAssistant(): AssistantMessage {
        if (!this.assistant) {
            throw new Error('Agent runtime turn has not started');
        }
        return this.assistant;
    }
}
