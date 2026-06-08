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
import type { ExecutionHost } from '../security/harness.js';

export function getTaskExecutionHost(taskCtx: TaskContext): ExecutionHost {
    return taskCtx.getExecutionHost?.() ?? { type: 'local' };
}

export function formatEnvironmentSection(
    workspace: string,
    executionHost: ExecutionHost,
    options: { includeHomeTemp?: boolean; includeExecutionRule?: boolean } = {}
): string {
    const items =
        executionHost.type === 'node'
            ? formatNodeEnvironmentItems(workspace, executionHost, options)
            : formatLocalEnvironmentItems(workspace, options);
    return ['# 当前运行环境', ...items.map((item) => ` - ${item}`)].join('\n');
}

function formatLocalEnvironmentItems(
    workspace: string,
    options: { includeHomeTemp?: boolean; includeExecutionRule?: boolean }
): string[] {
    const items = [`工作目录：${workspace}`, '当前执行宿主：Local', `操作系统平台：${process.platform}`];
    if (options.includeHomeTemp) {
        items.push(
            `用户家目录：${getHomeDir()}`,
            `临时目录：${getTempDir()}（注意：该目录随时可能被系统清理，不要在此存放重要数据）`
        );
    }
    if (options.includeExecutionRule) {
        items.push(
            '本机 shell/file 工具会在 OpenDesk 本地工作目录下运行，除非工具调用显式指定 workingDirectory 或绝对路径'
        );
    }
    return items;
}

function formatNodeEnvironmentItems(
    workspace: string,
    executionHost: Extract<ExecutionHost, { type: 'node' }>,
    options: { includeHomeTemp?: boolean; includeExecutionRule?: boolean }
): string[] {
    const capabilities = executionHost.capabilities;
    const label = executionHost.nodeLabel || capabilities.displayName || executionHost.nodeId;
    const nodeWorkspace = capabilities.workspace || '未声明（未指定 workingDirectory 时由 node 自身默认目录决定）';
    const shells = capabilities.shells.length > 0 ? capabilities.shells.join(', ') : '未声明';
    const items = [
        `OpenDesk 本地工作空间：${workspace}`,
        `当前执行宿主：Node ${label} (${executionHost.nodeId})`,
        `Node 默认工作目录：${nodeWorkspace}`,
        `Node 操作系统平台：${capabilities.platform || '未知'}`,
        `Node 可用 shell：${shells}`,
        `本机 OpenDesk 平台：${process.platform}`
    ];
    if (options.includeHomeTemp) {
        items.push(
            `本机用户家目录：${getHomeDir()}`,
            `本机临时目录：${getTempDir()}（注意：该目录随时可能被系统清理，不要在此存放重要数据）`
        );
    }
    if (options.includeExecutionRule) {
        items.push(
            '本机 shell/file 工具仍在 OpenDesk 本机运行；访问 node 的 shell 和文件系统时使用 devicemgr 的 node 工具。node 工具未显式指定 workingDirectory 或相对路径基准时，使用 Node 默认工作目录'
        );
    }
    return items;
}
