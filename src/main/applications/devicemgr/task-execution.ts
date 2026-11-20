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

import type { TaskState } from '../../aikernel/states/tasks.js';
import { getExecutionNode } from './execution.js';

export function normalizeExecutionNodeId(nodeId?: string | null): string {
    return typeof nodeId === 'string' ? nodeId.trim() : '';
}

export async function applyTaskExecutionNode(task: TaskState, nodeId?: string | null) {
    const normalizedNodeId = normalizeExecutionNodeId(nodeId);
    if (!normalizedNodeId) {
        await task.setExecutionHost({ type: 'local' });
        return { status: 'ok' as const, data: { type: 'local' as const } };
    }
    const node = getExecutionNode(normalizedNodeId);
    if (!node) {
        return { status: 'error' as const, message: `node ${normalizedNodeId} not connected` };
    }
    const label = node.displayName || node.nodeId;
    await task.setExecutionHost({
        type: 'node',
        nodeId: node.nodeId,
        nodeLabel: label,
        capabilities: {
            nodeId: node.nodeId,
            displayName: node.displayName,
            platform: node.platform,
            workspace: node.workspace,
            commands: node.commands,
            shells: node.shells,
            defaultShell: node.defaultShell
        }
    });
    return {
        status: 'ok' as const,
        data: { type: 'node' as const, nodeId: node.nodeId, nodeLabel: label, workspace: node.workspace }
    };
}
