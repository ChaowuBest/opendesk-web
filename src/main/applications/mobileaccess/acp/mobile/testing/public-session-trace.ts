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
import {
    applyPublicSessionUpdate,
    type PublicSessionState,
    type PublicSessionUpdate
} from '../remote-session-service/public-session.js';
import type { BegunSessionLoad, RemoteSessionService } from '../remote-session-service/service.js';
import type { PublicSessionSyncHandle } from '../remote-session-service/public-session-sync.js';

export interface PublicSessionTraceSnapshot {
    readonly sessionId?: string;
    readonly messageCount: number;
    readonly partCount: number;
    readonly publicBytes: number;
    readonly stateHash?: string;
    readonly feedPhase?: 'buffering' | 'live' | 'stopped';
    readonly lastUpdateType?: PublicSessionUpdate['type'];
    readonly lastCategory?: 'projection' | 'send' | 'connection';
}

function traceState(
    state: PublicSessionState,
    phase: PublicSessionTraceSnapshot['feedPhase'],
    lastUpdateType?: PublicSessionUpdate['type']
): PublicSessionTraceSnapshot {
    const json = JSON.stringify(state);
    return Object.freeze({
        sessionId: state.sessionId,
        messageCount: state.history.messages.length,
        partCount: state.history.messages.reduce(
            (sum, message) => sum + (message.role === 'compact_boundary' ? 0 : message.parts.length),
            0
        ),
        publicBytes: Buffer.byteLength(json, 'utf8'),
        stateHash: createHash('sha256').update(json, 'utf8').digest('hex'),
        feedPhase: phase,
        ...(lastUpdateType === undefined ? {} : { lastUpdateType })
    });
}

export function observePublicSessionTrace<T extends RemoteSessionService>(
    delegate: T,
    emit: (snapshot: PublicSessionTraceSnapshot) => void
): T {
    return {
        ...delegate,
        beginSessionLoad(sessionId, identityFactory): BegunSessionLoad {
            const begun = delegate.beginSessionLoad(sessionId, identityFactory);
            let diagnosticState: PublicSessionState | undefined = structuredClone(begun.snapshot);
            emit(traceState(diagnosticState, begun.sync.phase));
            const sync: PublicSessionSyncHandle = {
                sessionId: begun.sync.sessionId,
                get phase() {
                    return begun.sync.phase;
                },
                installFatalSink: (sink) => begun.sync.installFatalSink(sink),
                activate: (consumer) =>
                    begun.sync.activate(async (update: PublicSessionUpdate) => {
                        if (!diagnosticState) throw new Error('public session trace state was released');
                        diagnosticState = applyPublicSessionUpdate(diagnosticState, update);
                        emit(traceState(diagnosticState, begun.sync.phase, update.type));
                        await consumer(update);
                    }),
                stop(reason) {
                    begun.sync.stop(reason);
                    diagnosticState = undefined;
                    emit(Object.freeze({ messageCount: 0, partCount: 0, publicBytes: 0, feedPhase: 'stopped' }));
                }
            };
            return { ...begun, sync };
        }
    } as T;
}
