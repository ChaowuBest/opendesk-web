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
import { ServerPermissionBroker, type OpenCodePermissionReplyBody } from '../permission-broker.js';

function permissionNotFound(requestID: string) {
    return {
        _tag: 'PermissionNotFoundError',
        requestID,
        message: `Permission request not found: ${requestID}`
    };
}

function parseReplyBody(raw: unknown): OpenCodePermissionReplyBody | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }

    const data = raw as Record<string, unknown>;
    const payload =
        data.body && typeof data.body === 'object' && !Array.isArray(data.body)
            ? (data.body as Record<string, unknown>)
            : data;
    const reply = payload.reply;
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
        return undefined;
    }

    const result: OpenCodePermissionReplyBody = { reply };
    if (typeof payload.message === 'string') {
        result.message = payload.message;
    }
    return result;
}

export function PermissionRoutes(broker: ServerPermissionBroker = ServerPermissionBroker.getInstance()) {
    const app = new Hono();

    app.get('/permission', (c) => {
        return c.json(broker.list());
    });

    app.post('/permission/:requestID/reply', async (c) => {
        const requestID = c.req.param('requestID');
        const raw = await c.req.json().catch(() => undefined);
        const body = parseReplyBody(raw);

        if (!body) {
            return c.json({ error: 'Invalid permission reply' }, 400);
        }

        const ok = broker.reply(requestID, body);
        if (!ok) {
            return c.json(permissionNotFound(requestID), 404);
        }

        return c.json(true);
    });

    return app;
}
