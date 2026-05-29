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

import { Hono } from 'hono';
import { ApplicationRegistry } from '../../applications/registry.js';
import type { McpMgrApplication } from '../../applications/mcpmgr/app.js';
import type { McpServerConfig, McpServerState } from '../../applications/mcpmgr/common.js';

type OpenCodeMcpStatus = { status: 'connected' } | { status: 'disabled' } | { status: 'failed'; error: string };
type OpenCodeMcpStatusMap = Record<string, OpenCodeMcpStatus>;

function getMcpMgrApplication(): McpMgrApplication | undefined {
    const application = ApplicationRegistry.getApplication('mcpmgr');
    if (application && 'getServersFromConfig' in application && 'callWorker' in application) {
        return application as McpMgrApplication;
    }
    return undefined;
}

function getMcpServerByName(mcpApp: McpMgrApplication, name: string): McpServerConfig | undefined {
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

async function getOpenCodeStatusMap(mcpApp: McpMgrApplication): Promise<OpenCodeMcpStatusMap> {
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

function mcpServerNotFound(name: string) {
    return {
        _tag: 'McpServerNotFoundError',
        name,
        message: `MCP server not found: ${name}`
    };
}

async function callMcpWorkerByName(mcpApp: McpMgrApplication, name: string, methodName: string): Promise<void> {
    const server = getMcpServerByName(mcpApp, name);
    if (!server) {
        throw new Error(`MCP server not found: ${name}`);
    }

    const result = await mcpApp.callWorker(methodName, server.id);
    if (result.status !== 'ok') {
        throw new Error(result.message || `MCP server ${methodName} failed`);
    }
    mcpApp.sendEventToSubscribers('serversUpdated');
}

function isMcpServerNotFound(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('MCP server not found: ');
}

export function McpRoutes() {
    const app = new Hono();

    app.get('/mcp', async (c) => {
        const mcpApp = getMcpMgrApplication();
        if (!mcpApp) return c.json({});
        return c.json(await getOpenCodeStatusMap(mcpApp));
    });

    app.post('/mcp/:name/connect', async (c) => {
        const name = c.req.param('name');
        const mcpApp = getMcpMgrApplication();
        if (!mcpApp) return c.json(mcpServerNotFound(name), 404);

        try {
            await callMcpWorkerByName(mcpApp, name, 'connectServer');
            return c.json(true);
        } catch (error) {
            if (isMcpServerNotFound(error)) {
                return c.json(mcpServerNotFound(name), 404);
            }
            const message = error instanceof Error ? error.message : String(error);
            return c.json({ error: message }, 500);
        }
    });

    app.post('/mcp/:name/disconnect', async (c) => {
        const name = c.req.param('name');
        const mcpApp = getMcpMgrApplication();
        if (!mcpApp) return c.json(mcpServerNotFound(name), 404);

        try {
            await callMcpWorkerByName(mcpApp, name, 'disconnectServer');
            return c.json(true);
        } catch (error) {
            if (isMcpServerNotFound(error)) {
                return c.json(mcpServerNotFound(name), 404);
            }
            const message = error instanceof Error ? error.message : String(error);
            return c.json({ error: message }, 500);
        }
    });

    return app;
}
