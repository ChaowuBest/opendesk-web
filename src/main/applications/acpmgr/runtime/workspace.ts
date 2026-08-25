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

import crypto from 'node:crypto';
import path from 'node:path';
import type { AcpAgentProfile } from '../common.js';
import { t } from '../../../../locale/index.js';

export interface ResolvedAcpWorkspace {
    executionLocation: 'agent' | 'client';
    sessionCwd: string;
    localWorkspace: string;
    remoteWorkspace?: string;
    legacy: boolean;
}

function isOutsideRoot(relativePath: string): boolean {
    return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

export function resolveAcpWorkspace(profile: AcpAgentProfile, taskWorkspace: string): ResolvedAcpWorkspace {
    const localWorkspace = taskWorkspace;
    const execution = profile.execution;
    if (execution.location === 'client') {
        const sessionCwd = path.resolve(
            execution.workspace.strategy === 'fixed' ? execution.workspace.path : taskWorkspace
        );
        return { executionLocation: 'client', sessionCwd, localWorkspace, legacy: false };
    }

    if (execution.workspace.strategy === 'legacy') {
        return {
            executionLocation: 'agent',
            sessionCwd: taskWorkspace,
            localWorkspace,
            remoteWorkspace: taskWorkspace,
            legacy: true
        };
    }

    if (execution.workspace.strategy === 'fixed') {
        return {
            executionLocation: 'agent',
            sessionCwd: execution.workspace.path,
            localWorkspace,
            remoteWorkspace: execution.workspace.path,
            legacy: false
        };
    }

    const localRoot = path.resolve(execution.workspace.localRoot);
    const resolvedTaskWorkspace = path.resolve(taskWorkspace);
    const relativePath = path.relative(localRoot, resolvedTaskWorkspace);
    if (isOutsideRoot(relativePath)) {
        throw new Error(t('acpmgr.error.workspaceOutsideMapping'));
    }
    const remotePath = execution.workspace.platform === 'windows' ? path.win32 : path.posix;
    const segments = relativePath ? relativePath.split(path.sep) : [];
    const remoteWorkspace = remotePath.join(execution.workspace.remoteRoot, ...segments);
    return {
        executionLocation: 'agent',
        sessionCwd: remoteWorkspace,
        localWorkspace,
        remoteWorkspace,
        legacy: false
    };
}

export function createAcpExecutionFingerprint(profile: AcpAgentProfile, workspace: ResolvedAcpWorkspace): string {
    const bindings = [...profile.session.mcpBindings]
        .map(({ serverId, location }) => ({ serverId, location }))
        .sort((left, right) =>
            `${left.location}:${left.serverId}`.localeCompare(`${right.location}:${right.serverId}`)
        );
    return crypto
        .createHash('sha256')
        .update(
            JSON.stringify({
                profileId: profile.id,
                transport: profile.transport.type,
                execution: profile.execution,
                executionLocation: workspace.executionLocation,
                sessionCwd: workspace.sessionCwd,
                mcpBindings: bindings
            })
        )
        .digest('hex');
}
