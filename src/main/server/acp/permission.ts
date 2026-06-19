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

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type {
    PermissionPromptContext,
    PermissionPromptProvider,
    PermissionRequest,
    PermissionTaskInfo,
    PermissionUserResponse
} from '../../aikernel/security/permission.js';
import { t } from '../../../locale/index.js';
import { mapToolKind, toJsonCompatible } from './updates.js';

const ALLOW_ONCE = 'allow_once';
const ALLOW_ALWAYS = 'allow_always';
const REJECT_ONCE = 'reject_once';

function firstRequestPath(requests: PermissionRequest[]): string | undefined {
    return requests.find((request) => request.resourcePath)?.resourcePath;
}

function buildToolTitle(toolName: string, requests: PermissionRequest[]): string {
    const request = requests[0];
    if (!request) return toolName;
    const action = t(`headless.action.${request.action}`, {});
    const resource = t(`headless.resource.${request.resourceType}`, {});
    return `${toolName}: ${action} ${resource}`;
}

function buildRawInput(
    requests: PermissionRequest[],
    prefixOptions: { label: string; pattern: string }[],
    context?: PermissionPromptContext
): Record<string, unknown> {
    return {
        ...(context?.input ?? {}),
        requests: requests.map((request) => ({
            resourceType: request.resourceType,
            action: request.action,
            resourcePath: request.resourcePath
        })),
        prefixOptions
    };
}

export class AcpPermissionPromptProvider implements PermissionPromptProvider {
    constructor(
        private readonly connection: AgentSideConnection,
        private readonly sessionId: string
    ) {}

    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        _taskInfo?: PermissionTaskInfo,
        context?: PermissionPromptContext
    ): Promise<PermissionUserResponse> {
        if (requests.length === 0) {
            return { decision: 'allow', rememberScope: 'none' };
        }

        const selectedPrefixPattern = prefixOptions[0]?.pattern;
        const selectedPrefixLabel = prefixOptions[0]?.label || firstRequestPath(requests) || '*';
        const toolCallId = context?.toolCallId || `${toolName}-${Date.now()}`;
        const path = firstRequestPath(requests);

        try {
            const response = await this.connection.requestPermission({
                sessionId: this.sessionId,
                toolCall: {
                    toolCallId,
                    title: buildToolTitle(toolName, requests),
                    kind: mapToolKind(toolName),
                    status: 'pending',
                    ...(path ? { locations: [{ path }] } : {}),
                    rawInput: toJsonCompatible(buildRawInput(requests, prefixOptions, context))
                },
                options: [
                    {
                        optionId: ALLOW_ONCE,
                        name: t('acp.permission.allow_once'),
                        kind: 'allow_once'
                    },
                    {
                        optionId: ALLOW_ALWAYS,
                        name: t('acp.permission.allow_always', { scope: selectedPrefixLabel }),
                        kind: 'allow_always'
                    },
                    {
                        optionId: REJECT_ONCE,
                        name: t('acp.permission.reject_once'),
                        kind: 'reject_once'
                    }
                ]
            });

            if (response.outcome.outcome === 'cancelled') {
                return { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' };
            }

            if (response.outcome.optionId === ALLOW_ONCE) {
                return { decision: 'allow', rememberScope: 'none' };
            }

            if (response.outcome.optionId === ALLOW_ALWAYS) {
                if (selectedPrefixPattern) {
                    return {
                        decision: 'allow',
                        rememberScope: 'prefix',
                        selectedPrefixPattern
                    };
                }
                return { decision: 'allow', rememberScope: 'none' };
            }
        } catch {
            return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
        }

        return { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' };
    }

    cancelTaskPrompts(_taskIds: string[]): void {
        // ACP requestPermission does not expose an abort handle. The client is
        // expected to answer cancelled when it sends session/cancel.
    }
}
