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
import { createHash, randomBytes } from 'node:crypto';
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

// OpenCode Zen 网关（含 Go 订阅端点 opencode.ai/zen/go/v1）要求每个请求携带
// x-opencode-session 会话头做归属/路由，缺失时返回 400 MissingSessionID。
// 会话 ID 格式与官方客户端一致：ses_ + 64 位十六进制。
const ZEN_HOST_PATTERN = /(^|\.)opencode\.ai$/;
const SESSION_HEADER = 'x-opencode-session';
const CLIENT_HEADER = 'x-opencode-client';

function isZenEndpoint(baseUrl) {
    if (!baseUrl) return false;
    try {
        return ZEN_HOST_PATTERN.test(new URL(baseUrl).hostname);
    } catch {
        return false;
    }
}

// 同一任务的请求派生稳定会话 ID，网关侧保持会话亲和；无任务上下文时随机生成
function createSessionId(taskId) {
    if (taskId) {
        return `ses_${createHash('sha256').update(taskId).digest('hex')}`;
    }
    return `ses_${randomBytes(32).toString('hex')}`;
}

export default definePlugin({
    id: 'opencodego',
    setup(context) {
        const registration = context.hooks.on('chat.headers', (input, output) => {
            if (!isZenEndpoint(input.model?.provider?.baseUrl)) return;
            if (output.headers[SESSION_HEADER]) return;
            output.headers[SESSION_HEADER] = createSessionId(input.taskId);
            output.headers[CLIENT_HEADER] = 'opendesk';
        });
        return {
            async dispose() {
                await registration.dispose();
            }
        };
    }
});
