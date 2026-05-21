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

import type { Command } from 'commander';
import process from 'process';

export function registerServeCommand(prog: Command): void {
    prog.command('serve')
        .description('启动 headless HTTP API 服务器')
        .option('--mode <mode>', '服务器模式 (opencode, acp)', 'opencode')
        .option('--port <port>', '监听端口', '4096')
        .option('--hostname <hostname>', '监听主机名', '127.0.0.1')
        .option('--cors <origins>', '允许的跨域源（逗号分隔）')
        .option('--password <password>', '启用 HTTP Basic Auth 密码')
        .option('--username <username>', 'HTTP Basic Auth 用户名 (默认 opencode)')
        .action(async (opts: Record<string, string | undefined>) => {
            const mode = opts.mode || 'opencode';

            if (mode === 'acp') {
                console.log('[serve] ACP 模式暂未实现，敬请期待。');
                process.exit(0);
            }

            if (mode !== 'opencode') {
                console.error(`[serve] 不支持的模式: ${mode}，当前支持: opencode, acp`);
                process.exit(1);
            }

            // opencode 模式：启动 HTTP 服务器
            await startOpenCodeServer(opts);
        });
}

async function startOpenCodeServer(opts: Record<string, string | undefined>) {
    const { setPlatform } = await import('../../../platforms/base.js');
    const { CliPlatform } = await import('../../../platforms/cli.js');
    const { useCliTransport, useConsoleTransport } = await import('../../utils/logger.js');
    const { GlobalState } = await import('../../aikernel/states/global.js');
    const { AgentRegistry } = await import('../../aikernel/agents/registry.js');
    const { initializeRegistry, initializeRegistryWorker, ApplicationRegistry } =
        await import('../../applications/registry.js');
    const { listen } = await import('../../server/server.js');

    setPlatform(new CliPlatform());
    useCliTransport();
    useConsoleTransport();

    const port = parseInt(opts.port || '4096', 10);
    const hostname = opts.hostname || '127.0.0.1';
    const cors = opts.cors ? opts.cors.split(',').map((s) => s.trim()) : undefined;
    const password = opts.password || process.env.OPENCODE_SERVER_PASSWORD;
    const username = opts.username || process.env.OPENCODE_SERVER_USERNAME;

    if (!password) {
        console.log(
            '[serve] Warning: 未设置密码，服务器不受保护。可通过 --password 或 OPENCODE_SERVER_PASSWORD 环境变量设置。'
        );
    }

    // 初始化 AI kernel
    console.log('[serve] 正在初始化...');
    GlobalState.initialize();
    AgentRegistry.initBuiltinAgents();

    initializeRegistry();
    initializeRegistryWorker();
    GlobalState.getInstance().taskManagerState.toolsetProvider = {
        listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
    };

    console.log('[serve] AI kernel 初始化完成');

    // 启动 HTTP 服务器
    try {
        const server = await listen({
            port,
            hostname,
            cors,
            password,
            username
        });

        console.log(`[serve] OpenCode 兼容服务器已启动`);
        console.log(`[serve] 监听地址: http://${server.hostname}:${server.port}`);
        console.log(`[serve] 健康检查: http://${server.hostname}:${server.port}/global/health`);
        console.log(`[serve] API 文档: 参考 opencode server specification`);

        if (password) {
            console.log(`[serve] 认证已启用 (HTTP Basic Auth)`);
        }

        // 保持进程运行
        await new Promise(() => {});
        await server.stop();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[serve] 服务器启动失败: ${message}`);
        process.exit(1);
    }
}
