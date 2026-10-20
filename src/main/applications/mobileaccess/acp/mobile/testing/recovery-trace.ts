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

export type RecoveryTraceOperation =
    | 'connection'
    | 'initialize'
    | 'list'
    | 'load'
    | 'prompt'
    | 'interactionAnswer'
    | 'stop'
    | 'sessionNew'
    | 'configuration'
    | 'control';

export interface RecoveryTraceEvent {
    readonly ordinal: number;
    readonly connection: string;
    readonly operation: RecoveryTraceOperation;
    readonly stage: string;
}

export interface RecoveryTraceSnapshot {
    readonly activeConnection?: string;
    readonly connections: number;
    readonly counters: Readonly<Record<RecoveryTraceOperation, number>>;
    readonly events: readonly RecoveryTraceEvent[];
}

const TRACE_LIMIT = 300;

export class RecoveryTrace {
    private readonly labels = new Map<string, string>();
    private readonly counts = new Map<RecoveryTraceOperation, number>();
    private events: RecoveryTraceEvent[] = [];
    private ordinal = 0;
    private activeConnectionId?: string;

    open(connectionId: string): string {
        const label = this.label(connectionId);
        this.activeConnectionId = connectionId;
        this.append(connectionId, 'connection', 'opened');
        return label;
    }

    close(connectionId: string): void {
        this.append(connectionId, 'connection', 'closed');
        if (this.activeConnectionId === connectionId) this.activeConnectionId = undefined;
    }

    append(connectionId: string, operation: RecoveryTraceOperation, stage: string): void {
        this.counts.set(operation, (this.counts.get(operation) ?? 0) + 1);
        this.events.push(
            Object.freeze({
                ordinal: ++this.ordinal,
                connection: this.label(connectionId),
                operation,
                stage
            })
        );
        if (this.events.length > TRACE_LIMIT) this.events.shift();
    }

    snapshot(): RecoveryTraceSnapshot {
        const operations: RecoveryTraceOperation[] = [
            'connection',
            'initialize',
            'list',
            'load',
            'prompt',
            'interactionAnswer',
            'stop',
            'sessionNew',
            'configuration',
            'control'
        ];
        return Object.freeze({
            ...(this.activeConnectionId ? { activeConnection: this.label(this.activeConnectionId) } : {}),
            connections: this.labels.size,
            counters: Object.freeze(
                Object.fromEntries(
                    operations.map((operation) => [operation, this.counts.get(operation) ?? 0])
                ) as Record<RecoveryTraceOperation, number>
            ),
            events: Object.freeze(this.events.map((event) => Object.freeze({ ...event })))
        });
    }

    reset(): void {
        this.counts.clear();
        this.events = [];
        this.ordinal = 0;
    }

    private label(connectionId: string): string {
        let label = this.labels.get(connectionId);
        if (!label) {
            label = `C${this.labels.size + 1}`;
            this.labels.set(connectionId, label);
        }
        return label;
    }
}
