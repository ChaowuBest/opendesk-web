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

import type {
    AgentExecutionInstrumentation,
    ModelRequestInstrumentationContext,
    TaskTurnInstrumentationContext,
    ToolCallInstrumentationContext
} from '../agent-execution.js';
import type { ActiveContextView } from '../../aikernel/compaction/types.js';
import type { AssistantMessage, ChatContext, ToolCall } from '../../aikernel/messages.js';
import {
    finishLlmRequest,
    finishTaskTurn,
    recordGeneration,
    recordTool,
    startLlmRequest,
    startTaskTurn
} from './observations.js';
import {
    buildLlmInput,
    buildTurnInput,
    buildTurnOutput,
    extractAssistantVisibleTextSince,
    findTurnStartIndex,
    snapshotAssistantText
} from './task-format.js';

function errorToMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export class LangfuseAgentExecutionInstrumentation implements AgentExecutionInstrumentation {
    async aroundTaskTurn<T>(context: TaskTurnInstrumentationContext, next: () => Promise<T>): Promise<T> {
        const chatContext = context.chatContext as ChatContext;
        const startMessageIndex = findTurnStartIndex(chatContext);
        const observation = startTaskTurn({
            taskId: context.taskId,
            turnId: context.turnId,
            workspace: context.workspace,
            traceId: context.externalContext?.traceId,
            observationName: context.externalContext?.observationName,
            input: context.externalContext?.input ?? buildTurnInput(chatContext),
            model: context.model,
            recordGenerations: context.recordGenerations,
            metadata: context.metadata
        });
        let thrownError: unknown;
        let didThrow = false;

        try {
            return await next();
        } catch (err) {
            didThrow = true;
            thrownError = err;
            throw err;
        } finally {
            const outcome = context.getOutcome();
            const result = buildTurnOutput(chatContext, {
                startMessageIndex,
                taskID: outcome.taskID,
                sessionID: outcome.sessionID,
                workspace: outcome.workspace,
                providerID: outcome.providerID,
                modelID: outcome.modelID,
                mode: outcome.mode,
                agent: outcome.agent,
                cost: outcome.cost,
                completedAt: outcome.completedAt
            });
            const failure = didThrow ? thrownError : outcome.failure;
            const failureMessage = failure !== undefined ? errorToMessage(failure) : result.error;
            const output = context.externalContext?.output?.event
                ? { event: context.externalContext.output.event, ...result.output }
                : result.output;
            finishTaskTurn(observation, {
                output: failureMessage ? { ...output, error: failureMessage } : output,
                level: failureMessage ? 'ERROR' : 'DEFAULT',
                statusMessage: failureMessage,
                metadata: {
                    ...outcome.metadata,
                    ...(result.usageDetails ? { usageDetails: result.usageDetails } : {})
                }
            });
        }
    }

    async aroundModelRequest<T>(
        context: ModelRequestInstrumentationContext,
        next: (headers?: Record<string, string>) => Promise<T>
    ): Promise<T> {
        const chatContext = context.chatContext as ChatContext;
        const assistantMessage = context.assistantMessage as AssistantMessage;
        const messageOptions = context.messageOptions as
            | {
                  toolResultOverrides?: Map<string, string>;
                  activeContext?: ActiveContextView;
              }
            | undefined;
        const input = buildLlmInput(chatContext, messageOptions);
        const assistantTextStart = snapshotAssistantText(assistantMessage);
        const observation = startLlmRequest(context.taskId, {
            input,
            model: context.model,
            metadata: context.metadata
        });
        const headers = observation
            ? {
                  span_id: observation.doStreamObservationId
              }
            : undefined;

        try {
            const result = await next(headers);
            const output = extractAssistantVisibleTextSince(assistantMessage, assistantTextStart);
            const usage = context.getUsage();
            recordGeneration(observation, {
                input,
                output,
                usage,
                model: context.model
            });
            finishLlmRequest(observation, {
                usage,
                model: context.model,
                output,
                metadata: context.metadata
            });
            return result;
        } catch (err) {
            const message = errorToMessage(err);
            finishLlmRequest(observation, {
                output: message,
                model: context.model,
                level: 'ERROR',
                statusMessage: message,
                metadata: context.metadata
            });
            throw err;
        }
    }

    recordToolCall(context: ToolCallInstrumentationContext): void {
        const toolCall = context.toolCall as ToolCall;
        recordTool(
            {
                task_id: context.taskId,
                turn_id: toolCall.metadata?.execution?.turnId
            },
            toolCall
        );
    }
}
