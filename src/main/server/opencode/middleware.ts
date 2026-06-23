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

import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';

/**
 * HTTP Basic Auth 中间件。
 * 行为与 opencode 一致：当设置了 password 时启用认证。
 * 支持 Authorization header 和 ?auth_token query param。
 */
export function AuthMiddleware(password?: string, username?: string): MiddlewareHandler {
    return async (c, next) => {
        if (c.req.method === 'OPTIONS') return next();
        if (!password) return next();

        const effectiveUsername = username ?? 'opencode';

        const authToken = c.req.query('auth_token');
        if (authToken) {
            c.req.raw.headers.set('authorization', `Basic ${authToken}`);
        }

        const authorization = c.req.header('authorization');
        if (!authorization || !authorization.startsWith('Basic ')) {
            c.header('WWW-Authenticate', 'Basic realm="opendesk"');
            return c.json({ error: 'Unauthorized' }, 401);
        }

        const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
        const [user, pass] = decoded.split(':');
        if (user !== effectiveUsername || pass !== password) {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        return next();
    };
}

export const LoggerMiddleware: MiddlewareHandler = honoLogger((str) => {
    console.log(`[server] ${str}`);
});

export function CorsMiddleware(origins?: string[]): MiddlewareHandler {
    const allowOrigins = origins && origins.length > 0 ? origins : ['*'];
    return cors({
        origin: allowOrigins,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: [
            'Content-Type',
            'Authorization',
            'cookie',
            'x-tracerId',
            'x-trace-id',
            'x-opencode-directory',
            'x-opencode-sync'
        ],
        exposeHeaders: ['x-opencode-sync', 'x-next-cursor', 'link'],
        credentials: true
    });
}
