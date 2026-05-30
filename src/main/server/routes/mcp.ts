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
import {
    callMcpWorkerByName,
    getMcpMgrApplication,
    getOpenCodeStatusMap,
    isMcpServerNotFound,
    mcpServerNotFound
} from '../mcp.js';
import { getRequestWorkspace } from '../workspace.js';

export function McpRoutes() {
    const app = new Hono();

    app.get('/mcp', async (c) => {
        const mcpApp = getMcpMgrApplication();
        if (!mcpApp) return c.json({});
        return c.json(await getOpenCodeStatusMap(mcpApp, getRequestWorkspace(c)));
    });

    app.post('/mcp/:name/connect', async (c) => {
        const name = c.req.param('name');
        const mcpApp = getMcpMgrApplication();
        if (!mcpApp) return c.json(mcpServerNotFound(name), 404);

        try {
            await callMcpWorkerByName(mcpApp, name, 'connectServer', getRequestWorkspace(c));
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
