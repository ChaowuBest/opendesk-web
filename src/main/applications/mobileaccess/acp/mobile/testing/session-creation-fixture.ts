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
import {
    RemoteSessionCreateError,
    type CreationCapableRemoteSessionService
} from '../remote-session-service/service.js';
import { hashSessionCreationValue, type SessionCreationFixtureController } from './session-creation-trace.js';

export function createSessionCreationFixtureService<T extends CreationCapableRemoteSessionService>(
    delegate: T,
    controller: SessionCreationFixtureController
): T {
    return {
        ...delegate,
        async resolveDefaultWorkspace() {
            if (controller.plan.defaultMode === 'default_workspace_unavailable') {
                controller.append({ operation: 'default', outcome: 'rejected' });
                throw new RemoteSessionCreateError('default_workspace_unavailable');
            }
            const result = await delegate.resolveDefaultWorkspace();
            controller.append({
                operation: 'default',
                outcome: 'resolved',
                workspaceHash: hashSessionCreationValue(result.workspace)
            });
            return result;
        },
        async createSession(input) {
            const workspaceHash = hashSessionCreationValue(input.workspace);
            if (controller.plan.createMode === 'session_not_created') {
                controller.append({ operation: 'create', outcome: 'not_created', workspaceHash });
                throw new RemoteSessionCreateError('session_not_created');
            }
            const created = await delegate.createSession(input);
            const sessionIdHash = hashSessionCreationValue(created.sessionId);
            if (controller.plan.createMode === 'created_response_lost') {
                controller.append({
                    operation: 'create',
                    outcome: 'response_lost',
                    sessionIdHash,
                    workspaceHash
                });
                throw new Error('injected fixture response loss');
            }
            if (controller.plan.createMode === 'created_then_hold') {
                controller.append({
                    operation: 'create',
                    outcome: 'held',
                    sessionIdHash,
                    workspaceHash
                });
                if ((await controller.waitForRelease()) === 'released') {
                    controller.append({
                        operation: 'create',
                        outcome: 'released',
                        sessionIdHash,
                        workspaceHash
                    });
                }
            } else {
                controller.append({
                    operation: 'create',
                    outcome: 'forwarded',
                    sessionIdHash,
                    workspaceHash
                });
            }
            return created;
        },
        beginSessionLoad(sessionId, identityPlanFactory) {
            const sessionIdHash = hashSessionCreationValue(sessionId);
            if (controller.plan.loadMode === 'load_reject_after_create') {
                controller.append({ operation: 'load', outcome: 'rejected', sessionIdHash });
                throw new PublicSessionProjectionError('session_load_failed', 'injected fixture load rejection');
            }
            controller.append({ operation: 'load', outcome: 'forwarded', sessionIdHash });
            return delegate.beginSessionLoad(sessionId, identityPlanFactory);
        }
    } as T;
}
