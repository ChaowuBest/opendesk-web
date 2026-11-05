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

/**
 * 插件目录测试插件：只做可观测的最小接线，方便验证附加插件目录是否真的生效。
 *
 * - tool `ping`：回显调用参数与插件自身的加载位置（模型侧名称 `test-plugin-ping`）
 * - command `status`：`/test-plugin.status`、`opendesk plugins run test-plugin.status`
 * - hook `chat.headers`：给每次模型请求加 `x-test-plugin: enabled` 头
 *
 * 清单里的 `enabled` / `system` 没有声明，因此可以在插件中心正常启停。
 */

import os from 'node:os';
import { definePlugin, tool } from '@bitclub.ai/opendesk-plugin-sdk';

const STARTED_AT = new Date().toISOString();

export default definePlugin({
    id: 'test-plugin',
    setup(ctx) {
        ctx.tools.register(
            tool({
                name: 'ping',
                description:
                    '测试插件回显：返回 pong、传入的 message 以及插件自身的加载位置，用于确认附加插件目录已生效。',
                args: {
                    message: tool.schema.string().optional().describe('要回显的文本，可省略')
                },
                async execute(args) {
                    return {
                        output: [
                            `pong${args.message ? `: ${args.message}` : ''}`,
                            `pluginId: ${ctx.pluginId}`,
                            `pluginDir: ${ctx.pluginDir}`,
                            `configDir: ${ctx.configDir}`,
                            `dataDir: ${ctx.dataDir}`,
                            `pid: ${process.pid}`,
                            `host: ${os.platform()} ${os.arch()}`,
                            `activatedAt: ${STARTED_AT}`
                        ].join('\n')
                    };
                }
            })
        );

        ctx.commands.register({
            name: 'status',
            description: '打印测试插件的加载状态',
            execute(_args, context) {
                return {
                    title: 'test-plugin',
                    output: [
                        `pluginDir: ${ctx.pluginDir}`,
                        `workspace: ${context.workspace ?? '<none>'}`,
                        `activatedAt: ${STARTED_AT}`
                    ].join('\n')
                };
            }
        });

        ctx.hooks.on('chat.headers', (_input, output) => {
            output.headers['x-test-plugin'] = 'enabled';
        });
    }
});
