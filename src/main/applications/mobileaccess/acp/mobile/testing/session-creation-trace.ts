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

import { createHash } from 'node:crypto';

export interface SessionCreationFaultPlan {
    defaultMode: 'normal' | 'default_workspace_unavailable';
    createMode: 'normal' | 'session_not_created' | 'created_response_lost' | 'created_then_hold';
    loadMode: 'normal' | 'load_reject_after_create';
}

export type SessionCreationTraceEvent =
    | {
          connectionId: string;
          ordinal: number;
          operation: 'default';
          outcome: 'resolved' | 'rejected';
          workspaceHash?: string;
      }
    | {
          connectionId: string;
          ordinal: number;
          operation: 'create';
          outcome: 'forwarded' | 'not_created' | 'response_lost' | 'held' | 'released';
          sessionIdHash?: string;
          workspaceHash?: string;
      }
    | {
          connectionId: string;
          ordinal: number;
          operation: 'load';
          outcome: 'forwarded' | 'rejected';
          sessionIdHash: string;
      };

type SessionCreationTraceEventInput = SessionCreationTraceEvent extends infer T
    ? T extends SessionCreationTraceEvent
        ? Omit<T, 'connectionId' | 'ordinal'>
        : never
    : never;

const TRACE_LIMIT = 200;

const normalPlan = (): Readonly<SessionCreationFaultPlan> =>
    Object.freeze({
        defaultMode: 'normal',
        createMode: 'normal',
        loadMode: 'normal'
    });

export function hashSessionCreationValue(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class SessionCreationFixtureController {
    private currentPlan: Readonly<SessionCreationFaultPlan> = normalPlan();
    private trace: SessionCreationTraceEvent[] = [];
    private ordinal = 0;
    private held?: { resolve(result: 'released' | 'reset'): void };

    constructor(readonly connectionId: string) {}

    get plan(): Readonly<SessionCreationFaultPlan> {
        return this.currentPlan;
    }

    setPlan(plan: SessionCreationFaultPlan): void {
        if (this.held) throw new Error('the session creation fixture has a held creation');
        this.currentPlan = Object.freeze({ ...plan });
    }

    append(event: SessionCreationTraceEventInput): void {
        const entry = Object.freeze({
            connectionId: this.connectionId,
            ordinal: ++this.ordinal,
            ...event
        }) as SessionCreationTraceEvent;
        this.trace.push(entry);
        if (this.trace.length > TRACE_LIMIT) this.trace.shift();
    }

    waitForRelease(): Promise<'released' | 'reset'> {
        if (this.held) throw new Error('the session creation fixture has a held creation');
        return new Promise((resolve) => {
            this.held = { resolve };
        });
    }

    releaseHeld(): boolean {
        const held = this.held;
        if (!held) return false;
        this.held = undefined;
        held.resolve('released');
        return true;
    }

    snapshot(): readonly SessionCreationTraceEvent[] {
        return Object.freeze(this.trace.map((event) => Object.freeze({ ...event })));
    }

    reset(): void {
        const held = this.held;
        this.held = undefined;
        held?.resolve('reset');
        this.currentPlan = normalPlan();
        this.trace = [];
        this.ordinal = 0;
    }
}
