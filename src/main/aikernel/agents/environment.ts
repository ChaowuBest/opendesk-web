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

import { getHomeDir, getTempDir } from '../../utils/temp.js';
import type { TaskContext } from './common.js';
import type { ExecutionHost, ExecutionNodeSummary } from '../security/harness.js';

export function getTaskExecutionHost(taskCtx: TaskContext): ExecutionHost {
    return taskCtx.getExecutionHost?.() ?? { type: 'local' };
}

export function formatEnvironmentSection(
    workspace: string,
    executionHost: ExecutionHost,
    options: {
        includeHomeTemp?: boolean;
        includeExecutionRule?: boolean;
        availableNodes?: ExecutionNodeSummary[];
    } = {}
): string {
    const nodes = options.availableNodes ?? [];
    const items = formatUnifiedEnvironmentItems(workspace, executionHost, nodes, options);
    return ['# 当前运行环境', ...items.map((item) => ` - ${item}`)].join('\n');
}

function formatUnifiedEnvironmentItems(
    workspace: string,
    executionHost: ExecutionHost,
    nodes: ExecutionNodeSummary[],
    options: { includeHomeTemp?: boolean; includeExecutionRule?: boolean }
): string[] {
    const items: string[] = [];
    items.push(`工作目录：${workspace}`);
    items.push(`操作系统平台：${process.platform}`);

    // 确定当前默认
    const defaultNodeId = executionHost.type === 'node' ? executionHost.nodeId : null;
    const defaultLabel = defaultNodeId
        ? nodes.find((n) => n.nodeId === defaultNodeId)?.displayName ||
          (executionHost.type === 'node' && (executionHost.nodeLabel || executionHost.capabilities?.displayName)) ||
          defaultNodeId
        : 'Local';

    const defaultDesc = defaultNodeId ? `${defaultLabel} (${defaultNodeId})` : `${defaultLabel}（本机）`;
    items.push(`默认执行节点：${defaultDesc}`);

    // 统一列出 Local + 所有 Node
    if (nodes.length > 0) {
        items.push('可用执行节点列表：');
        // Local 条目
        const localMarker = executionHost.type === 'local' ? '（当前默认）' : '';
        items.push(`  * Local${localMarker} — OpenDesk 本机 [${process.platform}]`);

        for (const node of nodes) {
            const isDefault = executionHost.type === 'node' && executionHost.nodeId === node.nodeId;
            const marker = isDefault ? '（当前默认）' : '';
            const label = node.displayName || node.nodeId;
            const ws = node.workspace || '未声明';
            const shells = node.shells.length > 0 ? node.shells.join(', ') : '未声明';
            items.push(
                `  * ${label} (${node.nodeId})${marker} — ${node.platform || '未知'}, 工作区: ${ws}, shells: ${shells}`
            );
        }
    }

    if (options.includeHomeTemp) {
        items.push(
            `用户家目录：${getHomeDir()}`,
            `临时目录：${getTempDir()}（注意：该目录随时可能被系统清理，不要在此存放重要数据）`
        );
    }

    if (options.includeExecutionRule) {
        // 最核心：首先明确告知 agent 默认在哪个节点上执行
        if (defaultNodeId) {
            items.push(`如无特殊说明，所有文件操作和命令执行默认在【${defaultLabel} (${defaultNodeId})】进行。`);
            items.push(
                '本机工具（executeBash/readFile/editFile 等）始终在 Local 上运行',
                '如需在默认节点上执行，使用对应的 node 工具（executeNodeShell/readNodeFile/sendNodeFile/fetchNodeFile 等）',
                '当脚本或资源路径位于 Local/Gateway 侧但需要在 node 上执行时，先用 sendNodeFile 发送到 node 再执行',
                '未指定 nodeId 的 node 工具默认使用上述"默认执行节点"'
            );
        } else {
            items.push('如无特殊说明，所有文件操作和命令执行默认在【本机（Local）】进行。');
        }

        if (nodes.length > 0) {
            items.push(
                '如需在其他节点上执行，通过 nodeId 参数指定目标节点',
                '本机命令执行失败时，应先向用户报告错误原因，不要自行切换到其他节点重试，除非获得明确提示'
            );
        } else if (!defaultNodeId) {
            items.push(
                '本机 shell/file 工具会在 OpenDesk 本地工作目录下运行，除非工具调用显式指定 workingDirectory 或绝对路径'
            );
        }
    }

    return items;
}
