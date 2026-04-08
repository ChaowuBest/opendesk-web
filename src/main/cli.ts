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

import { setPlatform } from '../platforms/base';
import { CliPlatform } from '../platforms/cli.js';
import { isMainThread } from 'worker_threads';
import { useCliTransport, useConsoleTransport, useDumpLogTransport, interceptConsole } from './utils/logger.js';
import { initializeRegistry, initializeRegistryWorker, ApplicationRegistry } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';
import { GlobalState } from './aikernel/states/global.js';
import { FULL_CLEAR } from './tui/components/constants';
import { OpenDeskTUI, CommandLineArgs } from './tui/entry.js';
import { HeadlessRunner } from './tui/headless.js';
import { Setting } from './utils/setting';
import { program as prog } from 'commander';
import { listInstalledPlugins, loadPlugins } from './aikernel/plugins/index.js';
import { ChannelMgrApplication } from './applications/channelmgr/app.js';
import { ChannelMessageRouter } from './applications/channelmgr/router.js';
import { ShellAgentDecl } from './aikernel/agents/shellagent.js';
import { NotificationManager } from './utils/notificationmgr.js';
import { registerPluginsCommand } from './tui/subcommands/plugins.js';
import { registerToolsCommand } from './tui/subcommands/tools.js';

import { getCurrentVersion } from './utils/upgrade.js';

import process from 'process';
import path from 'path';
import fs from 'fs';

function parseCommandLineArgs() {
    prog.name('opendesk');
    prog.argument('[workspace]', 'the workspace to open', (v) => v, '.');
    prog.option('--model <alias>', 'model alias to use', (v) => v);
    prog.option('-c, --command <command>', 'the command to execute', (v) => v);
    prog.option('--export-html <path>', 'export session as HTML when -c task completes', (v) => v);
    prog.option('--export-json <path>', 'export session as JSON when -c task completes', (v) => v);
    prog.option('--dump-log <path>', 'dump all log output to specified file', (v) => v);
    prog.option('--headless', 'run in headless mode (no TUI, requires -c)');
    prog.option('--profile <path>', 'write performance profile to specified JSON file', (v) => v);
    prog.option('-v, --version', 'print the version');

    registerPluginsCommand(prog);
    registerToolsCommand(prog);

    // 让每个应用类注册自己的 CLI 子命令
    for (const AppClass of new CliPlatform().getApplicationClasses()) {
        (AppClass as any).registerCliSubcommands(prog);
    }

    // channels subcommand
    const channelsCmd = prog.command('channels').description('消息插件管理');

    channelsCmd
        .command('list')
        .description('列出已安装的消息插件')
        .action(() => {
            const records = listInstalledPlugins();
            if (records.length === 0) {
                console.log('暂无已安装的消息插件');
            } else {
                console.log('已安装的消息插件 (启动时自动加载):');
                for (const r of records) {
                    const status = r.enabled ? '✓ 已启用' : '✗ 已禁用';
                    console.log(`  ${r.id} [${status}]`);
                }
            }
            process.exit(0);
        });

    channelsCmd
        .command('info')
        .description('加载并检查所有已启用的消息插件')
        .action(async () => {
            useCliTransport();
            useConsoleTransport();
            const records = listInstalledPlugins();
            const enabledRecords = records.filter((r) => r.enabled);
            if (enabledRecords.length === 0) {
                console.log('暂无已启用的消息插件');
                process.exit(0);
            }
            console.log(`正在加载 ${enabledRecords.length} 个已启用的插件...\n`);
            const result = await loadPlugins();
            if (result.entries.length > 0) {
                console.log('已成功加载的插件:');
                for (const entry of result.entries) {
                    const cp = entry.channelPlugin;
                    const channelInfo = cp ? ` (渠道: ${cp.meta.label})` : '';
                    console.log(`  ✓ ${entry.id}${channelInfo}`);
                }
            }
            if (result.errors.length > 0) {
                console.log('\n加载失败的插件:');
                for (const err of result.errors) {
                    console.error(`  ✗ ${err.id}: ${err.error}`);
                }
            }
            console.log(`\n总计: ${result.entries.length} 成功, ${result.errors.length} 失败`);
            process.exit(result.errors.length > 0 ? 1 : 0);
        });

    prog.action(async (workspace: string, kwargs: Record<string, string | undefined>) => {
        if (kwargs.version) {
            const version = await getCurrentVersion();
            console.log(version ?? 'unknown');
            process.exit(0);
        }

        const workspacePath = path.resolve(workspace);
        if (!fs.existsSync(workspacePath)) {
            console.error(`[error] workspace ${workspacePath} does not exist`);
            process.exit(1);
        }

        if ((kwargs.exportHtml || kwargs.exportJson) && !kwargs.command) {
            console.error('[error] --export-html and --export-json can only be used with -c/--command');
            process.exit(1);
        }

        if (kwargs.headless && !kwargs.command) {
            console.error('[error] --headless requires -c/--command');
            process.exit(1);
        }

        if (kwargs.model) {
            try {
                const setting = Setting.getInstance();
                const modelInstance = setting.getModelInstance(kwargs.model);
                if (!modelInstance) {
                    console.error(`[error] model alias '${kwargs.model}' not found`);
                    process.exit(1);
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[error] invalid model alias '${kwargs.model}': ${message}`);
                process.exit(1);
            }
        }

        if (kwargs.profile && !kwargs.command) {
            console.error('[error] --profile can only be used with -c/--command');
            process.exit(1);
        }

        main({
            workspace: workspacePath,
            command: kwargs.command,
            model: kwargs.model,
            exportHtml: kwargs.exportHtml,
            exportJson: kwargs.exportJson,
            dumpLog: kwargs.dumpLog,
            headless: !!kwargs.headless,
            profile: kwargs.profile
        });
    });

    return prog.parse();
}

async function main(args: CommandLineArgs) {
    setPlatform(new CliPlatform());
    useCliTransport();
    if (args.dumpLog) {
        useDumpLogTransport(path.resolve(args.dumpLog));
    }
    interceptConsole();

    if (!isMainThread) {
        initializeAppWorkers();
        return;
    } else if (args.headless && args.command) {
        GlobalState.initialize();

        initializeRegistry();
        initializeRegistryWorker();
        GlobalState.getInstance().taskManagerState.toolsetProvider = {
            listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
        };

        const runner = new HeadlessRunner(args);
        ApplicationRegistry.onReady(() => {
            runner.execute(args.command!);
        });
    } else {
        GlobalState.initialize();

        // 在 TUI 接管 stdin 之前检测终端配色方案（OSC 11 查询需要直接读写 stdin/stdout）
        const { detectTerminalColorScheme } = await import('./tui/theme.js');
        await detectTerminalColorScheme();

        if (process.stdout.isTTY) {
            process.stdout.write(FULL_CLEAR);
        }

        const tui = new OpenDeskTUI(args);
        tui.start();

        initializeRegistry();
        initializeRegistryWorker();
        GlobalState.getInstance().taskManagerState.toolsetProvider = {
            listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
        };

        // Initialize channelmgr after registry is ready
        ApplicationRegistry.onReady(async () => {
            const channelMgrApp = ApplicationRegistry.getApplication('channelmgr') as ChannelMgrApplication | undefined;
            if (channelMgrApp) {
                const agentDecl = new ShellAgentDecl({ workspace: args.workspace });
                const router = new ChannelMessageRouter(tui.taskManagerState, agentDecl, args.model);

                router.onTaskResolved = (task, message) => {
                    const senderLabel = message.senderName || message.senderId;
                    const channelLabel = message.channelId;
                    const preview =
                        (message.text || '').length > 40
                            ? (message.text || '').slice(0, 37) + '...'
                            : message.text || '';

                    tui.switchToTask(task);

                    NotificationManager.getInstance().info(
                        channelLabel,
                        `来自 ${senderLabel} 的新消息`,
                        preview || '(无文本内容)'
                    );
                };

                await channelMgrApp.initializeChannels(router, args.workspace);

                const syncChannelStates = (states: { label: string; status: { online: boolean } }[]) => {
                    tui.inputArea.statusBar.update({
                        channelStates: states.map((s) => ({
                            label: s.label,
                            online: s.status.online
                        }))
                    });
                };
                channelMgrApp.onChannelStateChange(syncChannelStates);
                syncChannelStates(channelMgrApp.getChannelStates());
            }
        });

        if (args.command) {
            ApplicationRegistry.onReady(() => {
                tui.executeCommand(args.command!);
            });
        }
    }
}

parseCommandLineArgs();
