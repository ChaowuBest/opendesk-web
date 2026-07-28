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

export type TelemetryAttributeValue = string | number | boolean;

export interface TelemetryOperationSink {
    setAttribute(name: string, value: TelemetryAttributeValue): void;
    markError(message: string): void;
}

export class TelemetryOperation {
    private readonly attributes = new Map<string, TelemetryAttributeValue>();
    private readonly sinks = new Set<TelemetryOperationSink>();
    private errorMessage?: string;

    constructor(
        readonly name: string,
        attributes: Record<string, TelemetryAttributeValue> = {}
    ) {
        for (const [name, value] of Object.entries(attributes)) {
            this.attributes.set(name, value);
        }
    }

    setAttribute(name: string, value: TelemetryAttributeValue): void {
        this.attributes.set(name, value);
        for (const sink of this.sinks) {
            sink.setAttribute(name, value);
        }
    }

    setAttributes(attributes: Record<string, TelemetryAttributeValue>): void {
        for (const [name, value] of Object.entries(attributes)) {
            this.setAttribute(name, value);
        }
    }

    markError(message: string): void {
        this.errorMessage = message;
        for (const sink of this.sinks) {
            sink.markError(message);
        }
    }

    attach(sink: TelemetryOperationSink): () => void {
        this.sinks.add(sink);
        for (const [name, value] of this.attributes) {
            sink.setAttribute(name, value);
        }
        if (this.errorMessage !== undefined) {
            sink.markError(this.errorMessage);
        }
        return () => {
            this.sinks.delete(sink);
        };
    }
}

export interface OperationInstrumentation {
    aroundOperation?<T>(operation: TelemetryOperation, next: () => Promise<T>): Promise<T>;
    traceStream?<T>(operation: TelemetryOperation, source: AsyncIterable<T>): AsyncIterable<T>;
}

/**
 * 通用技术操作插桩注册表。调用方只描述操作名称、属性与生命周期，
 * provider、span、上下文传播及协议导出均由 telemetry 实现负责。
 */
export class TelemetryOperationRegistry {
    private static instrumentations: readonly OperationInstrumentation[] = [];

    static install(instrumentations: readonly OperationInstrumentation[]): void {
        this.instrumentations = [...instrumentations];
    }

    static reset(): void {
        this.instrumentations = [];
    }

    static aroundOperation<T>(operation: TelemetryOperation, next: () => Promise<T>): Promise<T> {
        const dispatch = (index: number): Promise<T> => {
            const instrumentation = this.instrumentations[index];
            if (!instrumentation) return next();
            if (!instrumentation.aroundOperation) return dispatch(index + 1);
            return instrumentation.aroundOperation(operation, () => dispatch(index + 1));
        };
        return dispatch(0);
    }

    static traceStream<T>(operation: TelemetryOperation, source: AsyncIterable<T>): AsyncIterable<T> {
        const dispatch = (index: number, current: AsyncIterable<T>): AsyncIterable<T> => {
            const instrumentation = this.instrumentations[index];
            if (!instrumentation) return current;
            const next = dispatch(index + 1, current);
            return instrumentation.traceStream ? instrumentation.traceStream(operation, next) : next;
        };
        return dispatch(0, source);
    }
}
