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
import { ServerQuestionBroker, type OpenCodeQuestionReplyBody } from '../question-broker.js';

function questionNotFound(requestID: string) {
    return {
        _tag: 'QuestionNotFoundError',
        requestID,
        message: `Question request not found: ${requestID}`
    };
}

function parseReplyBody(raw: unknown): OpenCodeQuestionReplyBody | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }

    const data = raw as Record<string, unknown>;
    const payload =
        data.body && typeof data.body === 'object' && !Array.isArray(data.body)
            ? (data.body as Record<string, unknown>)
            : data;
    if (!Array.isArray(payload.answers)) {
        return undefined;
    }

    const answers = payload.answers.map((answer) => {
        if (!Array.isArray(answer)) return [];
        return answer.map(String);
    });
    return { answers };
}

export function QuestionRoutes(broker: ServerQuestionBroker = ServerQuestionBroker.getInstance()) {
    const app = new Hono();

    app.get('/question', (c) => {
        return c.json(broker.list());
    });

    app.post('/question/:requestID/reply', async (c) => {
        const requestID = c.req.param('requestID');
        const raw = await c.req.json().catch(() => undefined);
        const body = parseReplyBody(raw);

        if (!body) {
            return c.json({ error: 'Invalid question reply' }, 400);
        }

        const ok = broker.reply(requestID, body);
        if (!ok) {
            return c.json(questionNotFound(requestID), 404);
        }

        return c.json(true);
    });

    app.post('/question/:requestID/reject', (c) => {
        const requestID = c.req.param('requestID');
        const ok = broker.reject(requestID);
        if (!ok) {
            return c.json(questionNotFound(requestID), 404);
        }

        return c.json(true);
    });

    return app;
}
