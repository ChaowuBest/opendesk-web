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

import { PublicSessionProjectionError } from '../remote-session-service/public-session.js';
import type { RemoteSessionService } from '../remote-session-service/service.js';
import { RecoveryTrace } from './recovery-trace.js';

export type RecoveryHeldOperation = 'prompt' | 'interactionAnswer' | 'stop' | 'sessionNew' | 'configuration';

export class RecoveryFixtureController {
    readonly trace = new RecoveryTrace();
    private failList = false;
    private failLoad = false;

    armListFailure(): void {
        this.failList = true;
    }

    armLoadFailure(): void {
        this.failLoad = true;
    }

    consumeListFailure(): boolean {
        const value = this.failList;
        this.failList = false;
        return value;
    }

    consumeLoadFailure(): boolean {
        const value = this.failLoad;
        this.failLoad = false;
        return value;
    }

    reset(): void {
        this.failList = false;
        this.failLoad = false;
        this.trace.reset();
    }
}

export function createRecoveryFixtureService<T extends RemoteSessionService>(
    delegate: T,
    controller: RecoveryFixtureController,
    connectionId: string
): T {
    return {
        ...delegate,
        async listSessions(query) {
            controller.trace.append(connectionId, 'list', 'requested');
            if (controller.consumeListFailure()) {
                controller.trace.append(connectionId, 'list', 'failed');
                throw new Error('injected fixture list failure');
            }
            const result = await delegate.listSessions(query);
            controller.trace.append(connectionId, 'list', 'completed');
            return result;
        },
        beginSessionLoad(sessionId, identityPlanFactory) {
            controller.trace.append(connectionId, 'load', 'requested');
            if (controller.consumeLoadFailure()) {
                controller.trace.append(connectionId, 'load', 'failed');
                throw new PublicSessionProjectionError('session_load_failed', 'injected fixture load failure');
            }
            const result = delegate.beginSessionLoad(sessionId, identityPlanFactory);
            controller.trace.append(connectionId, 'load', 'completed');
            return result;
        }
    } as T;
}
