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
import { useCliTransport, useConsoleTransport, interceptConsole } from './utils/logger.js';
import { initializeRegistry, initializeRegistryWorker, ApplicationRegistry } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';
import { GlobalState } from './states/global.js';
import { FULL_CLEAR } from './tui/components/constants';
import { OpenDeskTUI, CommandLineArgs } from './tui/entry.js';
import { Setting } from './utils/setting';
import { program as prog } from 'commander';
import { installPlugin, uninstallPlugin, listInstalledPlugins, setPluginEnabled } from './aikernel/plugins/index.js';
import { ChannelMgrApplication } from './applications/channelmgr/app.js';
import { ChannelMessageRouter } from './applications/channelmgr/router.js';
import { ShellAgentDecl } from './aikernel/agents/shellagent.js';

import process from 'process';
import path from 'path';
import fs from 'fs';

function parseCommandLineArgs() {
    prog.name('opendesk');
    prog.argument('[workspace]', 'the workspace to open', v => v, ".");
    prog.option('--model <alias>', 'model alias to use', v => v);
    prog.option('-c, --command <command>', 'the command to execute', v => v);
    prog.option('-v, --version', 'print the version');

    // plugins subcommand - compatible with openclaw CLI style
    const pluginsCmd = prog.command('plugins').description('插件管理');

    pluginsCmd
        .command('install <spec>')
        .description('安装插件 (npm 包名、路径或 .tgz 文件 URL)')
        .action(async (spec: string) => {
            useCliTransport();
            useConsoleTransport();  // Also output logs to console
            console.log(`正在安装插件: ${spec} ...`);
            const result = await installPlugin(spec);
            if (result.success) {
                console.log(`✓ 插件安装成功: ${result.id}`);
            } else {
                console.error(`✗ 插件安装失败: ${result.error}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('uninstall <id>')
        .description('卸载插件')
        .action(async (id: string) => {
            useCliTransport();
            const result = await uninstallPlugin(id);
            if (result.success) {
                console.log(`✓ 插件已卸载: ${id}`);
            } else {
                console.error(`✗ 插件卸载失败: ${result.error}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('list')
        .description('列出已安装的插件')
        .action(() => {
            const records = listInstalledPlugins();
            if (records.length === 0) {
                console.log('暂无已安装的插件');
            } else {
                console.log('已安装的插件:');
                for (const r of records) {
                    const status = r.enabled ? '✓ enabled' : '✗ disabled';
                    console.log(`  ${r.id} (${r.npmSpec}) [${status}] installed: ${r.installedAt}`);
                }
            }
            process.exit(0);
        });

    pluginsCmd
        .command('enable <id>')
        .description('启用插件')
        .action((id: string) => {
            if (setPluginEnabled(id, true)) {
                console.log(`✓ 插件已启用: ${id}`);
            } else {
                console.error(`✗ 未找到插件: ${id}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('disable <id>')
        .description('禁用插件')
        .action((id: string) => {
            if (setPluginEnabled(id, false)) {
                console.log(`✓ 插件已禁用: ${id}`);
            } else {
                console.error(`✗ 未找到插件: ${id}`);
                process.exit(1);
            }
            process.exit(0);
        });

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

    prog.action((workspace, kwargs) => {
        const workspacePath = path.resolve(workspace);
        if (!fs.existsSync(workspacePath)) {
            console.error(`[error] workspace ${workspacePath} does not exist`);
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
            } catch (err) {
                console.error(`[error] invalid model alias '${kwargs.model}': ${err.message}`);
                process.exit(1);
            }
        }

        main({
            workspace: workspacePath,
            command: kwargs.command,
            model: kwargs.model,
        })
    });
    return prog.parse();
}

function main(args: CommandLineArgs) {
    setPlatform(new CliPlatform());
    useCliTransport();
    interceptConsole();

    if (!isMainThread) {
        initializeAppWorkers();
        return;
    } else {
        GlobalState.initialize();
        if (process.stdout.isTTY) {
            process.stdout.write(FULL_CLEAR);
        }

        const tui = new OpenDeskTUI(args);
        tui.start();

        initializeRegistry();
        initializeRegistryWorker();

        // Initialize channelmgr after registry is ready
        ApplicationRegistry.onReady(async () => {
            const channelMgrApp = ApplicationRegistry.getApplication('channelmgr') as ChannelMgrApplication | undefined;
            if (channelMgrApp) {
                const agentDecl = new ShellAgentDecl({ workspace: args.workspace });
                const router = new ChannelMessageRouter(
                    tui.taskManagerState,
                    agentDecl,
                    args.model,
                );
                await channelMgrApp.initializeChannels(router);

                // Sync channel states to the status bar via event callback
                const syncChannelStates = (states: { label: string; status: { online: boolean } }[]) => {
                    tui.inputArea.statusBar.update({
                        channelStates: states.map(s => ({
                            label: s.label,
                            online: s.status.online,
                        })),
                    });
                };
                channelMgrApp.onChannelStateChange(syncChannelStates);
                // Initial sync
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