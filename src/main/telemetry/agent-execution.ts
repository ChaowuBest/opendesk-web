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

export interface TaskTurnInstrumentationExternalContext {
    traceId?: string;
    observationName?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    output?: {
        sessionID?: string;
        mode?: string;
        agent?: string;
        cost?: number;
        event?: string;
    };
}

export function normalizeTurnContext(
    context: TaskTurnInstrumentationExternalContext | undefined
): TaskTurnInstrumentationExternalContext | undefined {
    if (!context) {
        return undefined;
    }
    const traceId = context.traceId?.trim();
    return {
        traceId: traceId || undefined,
        observationName: context.observationName,
        input: context.input,
        metadata: context.metadata ? { ...context.metadata } : undefined,
        output: context.output ? { ...context.output } : undefined
    };
}

export interface TaskTurnInstrumentationOutcome {
    taskID?: string;
    sessionID?: string;
    workspace?: string;
    providerID?: string;
    modelID?: string;
    mode?: string;
    agent?: string;
    cost?: number;
    completedAt?: number;
    failure?: unknown;
    metadata?: Record<string, unknown>;
}

export interface TaskTurnInstrumentationContext {
    taskId: string;
    turnId: string;
    taskName?: string;
    parentTaskId?: string | null;
    userPrompt?: string;
    workspace?: string;
    chatContext: unknown;
    externalContext?: TaskTurnInstrumentationExternalContext;
    model?: unknown;
    recordGenerations: boolean;
    metadata?: Record<string, unknown>;
    getOutcome(): TaskTurnInstrumentationOutcome;
}

export interface ModelRequestInstrumentationContext {
    taskId: string;
    chatContext: unknown;
    messageOptions:
        | {
              toolResultOverrides?: Map<string, string>;
              activeContext?: unknown;
          }
        | undefined;
    assistantMessage: unknown;
    model?: string;
    metadata?: Record<string, unknown>;
    getUsage(): unknown;
}

export interface ToolCallInstrumentationContext {
    taskId?: string;
    toolCall: unknown;
}

export interface AgentExecutionInstrumentation {
    aroundTaskTurn<T>(context: TaskTurnInstrumentationContext, next: () => Promise<T>): Promise<T>;
    aroundModelRequest<T>(
        context: ModelRequestInstrumentationContext,
        next: (headers?: Record<string, string>) => Promise<T>
    ): Promise<T>;
    recordToolCall(context: ToolCallInstrumentationContext): void | Promise<void>;
}

function mergeHeaders(
    current: Record<string, string> | undefined,
    additions: Record<string, string> | undefined
): Record<string, string> | undefined {
    if (!additions) return current;
    return {
        ...current,
        ...additions
    };
}

/**
 * Agent 执行层只感知这一中立注册表。具体协议实现由 telemetry 初始化时安装，
 * 多个实现以 middleware 方式组合，无实现时直接执行原业务逻辑。
 */
export class AgentExecutionInstrumentationRegistry {
    private static instrumentations: readonly AgentExecutionInstrumentation[] = [];

    static install(instrumentations: readonly AgentExecutionInstrumentation[]): void {
        this.instrumentations = [...instrumentations];
    }

    static reset(): void {
        this.instrumentations = [];
    }

    static aroundTaskTurn<T>(context: TaskTurnInstrumentationContext, next: () => Promise<T>): Promise<T> {
        const dispatch = (index: number): Promise<T> => {
            const instrumentation = this.instrumentations[index];
            if (!instrumentation) return next();
            return instrumentation.aroundTaskTurn(context, () => dispatch(index + 1));
        };
        return dispatch(0);
    }

    static aroundModelRequest<T>(
        context: ModelRequestInstrumentationContext,
        next: (headers?: Record<string, string>) => Promise<T>
    ): Promise<T> {
        const dispatch = (index: number, headers?: Record<string, string>): Promise<T> => {
            const instrumentation = this.instrumentations[index];
            if (!instrumentation) return next(headers);
            return instrumentation.aroundModelRequest(context, (additions) =>
                dispatch(index + 1, mergeHeaders(headers, additions))
            );
        };
        return dispatch(0);
    }

    static async recordToolCall(context: ToolCallInstrumentationContext): Promise<void> {
        for (const instrumentation of this.instrumentations) {
            await instrumentation.recordToolCall(context);
        }
    }
}
