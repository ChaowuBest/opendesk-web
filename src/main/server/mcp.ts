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

import { ApplicationRegistry } from '../applications/registry.js';
import type { McpMgrApplication } from '../applications/mcpmgr/app.js';
import type { McpServerConfig, McpServerState } from '../applications/mcpmgr/common.js';

export type OpenCodeMcpStatus = { status: 'connected' } | { status: 'disabled' } | { status: 'failed'; error: string };
export type OpenCodeMcpStatusMap = Record<string, OpenCodeMcpStatus>;

export function getMcpMgrApplication(): McpMgrApplication | undefined {
    const application = ApplicationRegistry.getApplication('mcpmgr');
    if (application && 'getServersFromConfig' in application && 'callWorker' in application) {
        return application as McpMgrApplication;
    }
    return undefined;
}

export function getMcpServerByName(mcpApp: McpMgrApplication, name: string): McpServerConfig | undefined {
    return mcpApp.getServersFromConfig().find((server) => server.name === name || server.id === name);
}

function toOpenCodeStatus(server: Partial<McpServerState> & McpServerConfig): OpenCodeMcpStatus {
    if (server.status === 'connected') {
        return { status: 'connected' };
    }
    if (server.status === 'error') {
        return { status: 'failed', error: server.error || 'MCP server failed' };
    }
    return { status: 'disabled' };
}

async function ensureMcpWorkspaceForApp(mcpApp: McpMgrApplication, workspace: string): Promise<void> {
    try {
        await mcpApp.callWorker('ensureWorkspace', workspace);
    } catch {
        // Older workers do not have this compatibility method. Status fallback below remains valid.
    }
}

export async function ensureMcpWorkspace(workspace: string): Promise<void> {
    const mcpApp = getMcpMgrApplication();
    if (!mcpApp) return;
    await ensureMcpWorkspaceForApp(mcpApp, workspace);
}

export async function getOpenCodeStatusMap(
    mcpApp: McpMgrApplication,
    workspace?: string
): Promise<OpenCodeMcpStatusMap> {
    if (workspace) {
        await ensureMcpWorkspaceForApp(mcpApp, workspace);
    }

    let servers: (Partial<McpServerState> & McpServerConfig)[];
    try {
        const result = await mcpApp.callWorker('getServers');
        if (result.status === 'ok' && Array.isArray(result.data)) {
            servers = result.data as (Partial<McpServerState> & McpServerConfig)[];
        } else {
            servers = mcpApp.getServersFromConfig();
        }
    } catch {
        servers = mcpApp.getServersFromConfig();
    }

    const statusMap: OpenCodeMcpStatusMap = {};
    for (const server of servers) {
        statusMap[server.name || server.id] = toOpenCodeStatus(server);
    }
    return statusMap;
}

export function mcpServerNotFound(name: string) {
    return {
        _tag: 'McpServerNotFoundError',
        name,
        message: `MCP server not found: ${name}`
    };
}

export async function callMcpWorkerByName(
    mcpApp: McpMgrApplication,
    name: string,
    methodName: string,
    workspace?: string
): Promise<void> {
    const server = getMcpServerByName(mcpApp, name);
    if (!server) {
        throw new Error(`MCP server not found: ${name}`);
    }

    const args = methodName === 'connectServer' && workspace ? [server.id, workspace] : [server.id];
    const result = await mcpApp.callWorker(methodName, ...args);
    if (result.status !== 'ok') {
        throw new Error(result.message || `MCP server ${methodName} failed`);
    }
    mcpApp.sendEventToSubscribers('serversUpdated');
}

export function isMcpServerNotFound(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('MCP server not found: ');
}
