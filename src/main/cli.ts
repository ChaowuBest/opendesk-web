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

import { setPlatform, getPlatform } from '../platforms/base.js';
import { CliPlatform } from '../platforms/cli.js';
import { isMainThread } from 'worker_threads';
import {
    useCliTransport,
    useConsoleTransport,
    useDumpLogTransport,
    interceptConsole,
    dropDeprecatedLogs,
    getLogFilename,
    reloadLoggerFileTransport
} from './utils/logger.js';
import { initializeRegistry, initializeRegistryWorker, ApplicationRegistry } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';
import { GlobalState } from './aikernel/states/global.js';
import { FULL_CLEAR } from './tui/components/constants';
import { OpenDeskTUI, CommandLineArgs } from './tui/entry.js';
import { HeadlessRunner } from './tui/headless.js';
import { Setting, getDefaultOpendeskDirectory, setCustomOpendeskDirectory } from './utils/setting';
import { program as prog, Option } from 'commander';
import { listInstalledPlugins, loadPlugins } from './plugins/index.js';
import { ChannelMgrApplication } from './applications/channelmgr/app.js';
import { ChannelMessageRouter } from './applications/channelmgr/router.js';
import { initTelemetry, shutdownTelemetry } from './telemetry/index.js';
import { StartupTrace } from './telemetry/opentelemetry/startup-tracer.js';
import { AgentRegistry } from './aikernel/agents/registry.js';
import { NotificationManager } from './utils/notificationmgr.js';
import { registerPluginsCommand } from './tui/subcommands/plugins.js';
import { registerToolsCommand } from './tui/subcommands/tools.js';
import { registerQuickpassCommand } from './tui/subcommands/quickpass.js';
import { registerServeCommand } from './tui/subcommands/serve.js';
import { setRuntimeLocale, t } from '../locale/index.js';
import type { BaseApplication } from './applications/base.js';

import { registerGoalHooks } from './aikernel/goal/hooks.js';
import { initializeHarnesses } from './aikernel/harnesses/index.js';

import { getCurrentVersion } from './utils/upgrade.js';

import process from 'process';
import path from 'path';
import fs from 'fs';

// 获取日志文件路径用于提示用户
function getLogPathHint(): string {
    try {
        const { getLogDirectory } = require('./utils/setting.js');
        return path.join(getLogDirectory(), getLogFilename());
    } catch {
        return `~/.opendesk/logs/${getLogFilename()}`;
    }
}

// 输出致命错误到 stderr（绕过可能被拦截的 console.error）
function outputFatalError(title: string, details: string): void {
    const logPath = getLogPathHint();
    const separator = '='.repeat(60);
    const message = [
        '',
        separator,
        `[OpenDesk FATAL] ${title}`,
        separator,
        details,
        '',
        '发生不可恢复的错误，程序即将退出。',
        `请查看日志文件获取详细信息: ${logPath}`,
        separator,
        ''
    ].join('\n');
    process.stderr.write(message + '\n');
}

// 防止 stdout/stderr EPIPE 错误逃逸为 uncaughtException
// 当终端管道断开或系统休眠后恢复时，写入操作可能触发 EPIPE
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
});

// 全局异常兜底：直接输出到 stderr，绕过可能被 interceptConsole 拦截的 console.error
process.on('uncaughtException', (err, origin) => {
    const errDetails = err instanceof Error ? err.stack || err.message : String(err);

    // EPIPE 是可恢复的网络/管道断开错误，不应导致应用崩溃
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE') {
        return;
    }

    outputFatalError(`uncaughtException (${origin})`, errDetails);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    const reasonDetails = reason instanceof Error ? reason.stack || reason.message : String(reason);
    outputFatalError('unhandledRejection', `${reasonDetails}\n\nPromise: ${promise}`);
    process.exit(1);
});

function parseCommandLineArgs() {
    try {
        process.cwd();
    } catch {
        console.error(
            '[error] Current working directory no longer exists. Please restart opendesk from a valid directory.'
        );
        process.exit(1);
    }

    setPlatform(new CliPlatform());

    prog.name('opendesk');
    prog.option('--workspace <path>', 'the workspace to open', (v) => v, '.');
    prog.option('--model <alias>', 'model alias to use', (v) => v);
    prog.option('-c, --command <command>', 'the command to execute', (v) => v);
    prog.option('--task-name <name>', 'task name to use when executing -c/--command', (v) => v);
    prog.option('--export-html <path>', 'export session as HTML when -c task completes', (v) => v);
    prog.option('--export-json <path>', 'export session as JSON when -c task completes', (v) => v);
    prog.option('--dump-log <path>', 'dump all log output to specified file', (v) => v);
    prog.option('--headless', 'run in headless mode (no TUI, requires -c)');
    prog.option('--resume <task-id>', 'resume/continue a specific task by its ID');
    prog.option('--profile <path>', 'write performance profile to specified JSON file', (v) => v);
    prog.option('--allow-everything', 'no permission check, every operation is allowed');
    prog.option('--mode <mode>', 'agent mode to use (standard, plan, solo, unlimited)', (v) => v);
    prog.option('--language <lang>', 'language to use (auto, zh-CN, en-US)', (v) => v);
    prog.option('--render-interval <ms>', 'render throttle base interval in milliseconds (default: 100)', (v) =>
        parseInt(v, 10)
    );
    prog.option(
        '--config-directory <path>',
        `specify custom config directory (default: ${getDefaultOpendeskDirectory()})`,
        (v) => v
    );
    prog.option('-v, --version', 'print the version');

    registerPluginsCommand(prog);
    registerToolsCommand(prog);
    registerQuickpassCommand(prog);
    registerServeCommand(prog);

    // 让每个应用类注册自己的 CLI 子命令
    for (const AppClass of new CliPlatform().getApplicationClasses()) {
        (AppClass as any).registerCliSubcommands(prog);
    }

    // 注册每个应用的 CLI 参数（自动加前缀，在帮助末尾分组显示）
    // Commander 会将 --skillmgr-mount-skill 转换为驼峰命名
    const appOptionsMap: Map<string, { name: string; description?: string }[]> = new Map();
    for (const AppClass of new CliPlatform().getApplicationClasses()) {
        const bundleName = (AppClass as any).bundleName || (AppClass as any).prototype?.bundleName;
        if (!bundleName) continue;

        const options = (AppClass as typeof BaseApplication).getCliOptions();
        if (options.length === 0) continue;

        const appOpts: { name: string; description?: string }[] = [];
        for (const opt of options) {
            const prefixedName = `${bundleName}-${opt.name}`;
            const optDef = new Option(`--${prefixedName} <value>`, opt.description || '').hideHelp();
            if (opt.boolean) {
                optDef.booleanNegatable(false);
            }
            if (opt.defaultValue !== undefined) {
                optDef.default(opt.defaultValue);
            }
            if (opt.repeated) {
                optDef.argParser((value: string, previous: unknown[] | undefined) => {
                    const parsed = opt.parse ? opt.parse(value) : value;
                    return [...(Array.isArray(previous) ? previous : []), parsed];
                });
            } else if (opt.parse) {
                optDef.argParser(opt.parse as any);
            }
            prog.addOption(optDef);
            appOpts.push({ name: prefixedName, description: opt.description });
        }
        if (appOpts.length > 0) {
            appOptionsMap.set(bundleName, appOpts);
        }
    }

    // 自定义帮助输出格式：在末尾按应用分组显示应用级参数
    prog.addHelpText('after', () => {
        if (appOptionsMap.size === 0) return '';
        const lines: string[] = [''];
        for (const [bundleName, opts] of appOptionsMap) {
            lines.push(`Options of ${bundleName}:`);
            for (const { name, description } of opts) {
                lines.push(`  --${name.padEnd(30)} ${description || ''}`);
            }
            lines.push('');
        }
        return lines.join('\n');
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

    prog.action(async (kwargs: Record<string, string | undefined>) => {
        if (kwargs.version) {
            const version = await getCurrentVersion();
            console.log(version ?? 'unknown');
            process.exit(0);
        }

        if (kwargs.configDirectory) {
            setCustomOpendeskDirectory(kwargs.configDirectory);
            reloadLoggerFileTransport();
        }

        // 收集每个应用的 CLI 参数（从 kwargs 中匹配前缀）
        // Commander 会将 --bundle-name-opt 转换为 camelCase，我们直接匹配带有 bundleName 前缀的 key
        const appCliOptions: Record<string, Record<string, string | boolean | string[] | undefined>> = {};
        for (const AppClass of new CliPlatform().getApplicationClasses()) {
            const bundleName = (AppClass as any).bundleName || (AppClass as any).prototype?.bundleName;
            if (!bundleName) continue;

            const options = (AppClass as typeof BaseApplication).getCliOptions();
            if (options.length === 0) continue;

            // 构建前缀列表（原始名和可能的 camelCase 变体）
            const prefixVariants = [`${bundleName}-`, `${bundleName}`];
            // 同时考虑 Commander 的 camelCase 转换：bundle-name-opt -> bundleNameOpt
            const camelPrefix = bundleName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() + '-';

            const appOpts: Record<string, string | boolean | string[] | undefined> = {};
            for (const key of Object.keys(kwargs)) {
                if (kwargs[key] === undefined) continue;

                // 尝试匹配各个前缀变体
                let matchedOptName: string | null = null;
                for (const prefix of prefixVariants) {
                    if (key.startsWith(prefix)) {
                        matchedOptName = key.slice(prefix.length);
                        break;
                    }
                }
                if (!matchedOptName) {
                    // 尝试 camelCase 前缀变体
                    if (key.startsWith(camelPrefix)) {
                        matchedOptName = key.slice(camelPrefix.length);
                    } else {
                        continue;
                    }
                }

                // 检查是否匹配已知的选项名（支持原始名和 camelCase）
                for (const opt of options) {
                    const optNameVariants = [opt.name, opt.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
                    if (optNameVariants.includes(matchedOptName)) {
                        appOpts[opt.name] = kwargs[key] as string | boolean | string[];
                        break;
                    }
                }
            }
            if (Object.keys(appOpts).length > 0) {
                appCliOptions[bundleName] = appOpts;
            }
        }

        const workspacePath = path.resolve(kwargs.workspace ?? '.');
        if (!fs.existsSync(workspacePath)) {
            console.error(`[error] workspace ${workspacePath} does not exist`);
            process.exit(1);
        }

        if ((kwargs.exportHtml || kwargs.exportJson) && !kwargs.command) {
            console.error('[error] --export-html and --export-json can only be used with -c/--command');
            process.exit(1);
        }

        if (kwargs.taskName !== undefined && !kwargs.command) {
            console.error(`[error] ${t('cli.task_name.requires_command')}`);
            process.exit(1);
        }

        if (kwargs.headless && !kwargs.command) {
            console.error('[error] --headless requires -c/--command');
            process.exit(1);
        }

        if (kwargs.model) {
            const setting = Setting.getInstance();
            // 检查设置加载错误并提示用户
            const loadError = Setting.getLoadError();
            if (loadError) {
                console.error(`[warning] ${loadError}`);
                Setting.clearLoadError();
            }
            const modelInstance = setting.getModelInstance(kwargs.model, 'chat');
            if (!modelInstance) {
                console.error(`[error] ${t('error.model.chat_alias_not_found', { alias: kwargs.model })}`);
                process.exit(1);
            }
        }

        if (kwargs.profile && !kwargs.command) {
            console.error('[error] --profile can only be used with -c/--command');
            process.exit(1);
        }

        await main({
            workspace: workspacePath,
            command: kwargs.command,
            taskName: kwargs.taskName?.trim() ? kwargs.taskName.trim() : undefined,
            model: kwargs.model,
            exportHtml: kwargs.exportHtml,
            exportJson: kwargs.exportJson,
            dumpLog: kwargs.dumpLog,
            headless: !!kwargs.headless,
            profile: kwargs.profile,
            allowEverything: !!kwargs.allowEverything,
            // --allow-everything 等价于 --mode unlimited
            mode: kwargs.allowEverything ? 'unlimited' : kwargs.mode,
            language: kwargs.language,
            renderInterval: kwargs.renderInterval,
            resume: kwargs.resume,
            appCliOptions
        });
    });

    return prog.parse();
}

async function main(args: CommandLineArgs) {
    // Worker 线程不需要遥测和启动追踪，其 LLM 请求通过 IPC 转发到主进程
    if (!isMainThread) {
        initializeAppWorkers();
        return;
    }

    // 初始化遥测系统（尽早初始化，在任何 LLM 请求之前）
    await initTelemetry();
    const startupTrace = new StartupTrace('startup.cli');

    const t1 = startupTrace.createPhase('startup.cli.temp_dir');
    const { initTempDir } = await import('./utils/temp.js');
    initTempDir();
    t1.end();

    const t2 = startupTrace.createPhase('startup.cli.platform');
    (getPlatform() as CliPlatform).setWorkspace(args.workspace);
    useCliTransport();
    if (args.dumpLog) {
        useDumpLogTransport(path.resolve(args.dumpLog));
    }
    interceptConsole();
    t2.end();

    // Apply language setting from command line (runtime only, does not modify setting)
    if (args.language) {
        setRuntimeLocale(args.language);
    }

    // 在 registry 初始化之前处理 app CLI 参数（如 --skillmgr-mount-skill）
    // 因为 ApplicationRegistry.getApplication() 需要 registry 已初始化
    if (args.appCliOptions) {
        for (const [bundleName, options] of Object.entries(args.appCliOptions)) {
            // 如果是 skillmgr 的 mount-skill，在 registry 初始化前直接添加到 SkillRegistry
            if (bundleName === 'skillmgr' && options['mount-skill']) {
                const dirs = Array.isArray(options['mount-skill']) ? options['mount-skill'] : [options['mount-skill']];
                const { skillRegistry } = await import('./applications/skillmgr/utils/skill-registry.js');
                for (const dir of dirs) {
                    if (typeof dir === 'string') {
                        skillRegistry.addMountedDir(dir);
                    }
                }
            }
        }
    }

    if (args.headless && args.command) {
        const t3a = startupTrace.createPhase('startup.cli.global_state.init');
        GlobalState.initialize();
        t3a.end();

        const t3b = startupTrace.createPhase('startup.cli.global_state.builtin_agents');
        AgentRegistry.initBuiltinAgents();
        t3b.end();

        const t3c = startupTrace.createPhase('startup.cli.global_state.goal_hooks');
        registerGoalHooks();
        t3c.end();

        const t3d = startupTrace.createPhase('startup.cli.global_state.harnesses');
        initializeHarnesses();
        t3d.end();

        const t4 = startupTrace.createPhase('startup.cli.registry');
        initializeRegistry();
        initializeRegistryWorker();
        await ApplicationRegistry.loadAvailableAgents();
        GlobalState.getInstance().taskManagerState.toolsetProvider = {
            listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
        };
        t4.end();

        const runner = new HeadlessRunner(args);
        await runner.setupLazyHarnessInit();
        ApplicationRegistry.onReady(() => {
            runner.execute(args.command!);
            startupTrace.end();
        });
    } else {
        const t3 = startupTrace.createPhase('startup.cli.global_state');
        GlobalState.initialize();
        AgentRegistry.initBuiltinAgents();
        registerGoalHooks();
        initializeHarnesses();
        t3.end();

        // 在 TUI 接管 stdin 之前检测终端配色方案（OSC 11 查询需要直接读写 stdin/stdout）
        const t4 = startupTrace.createPhase('startup.cli.terminal_theme');
        const { detectTerminalColorScheme } = await import('./tui/theme.js');
        await detectTerminalColorScheme();
        t4.end();

        if (process.stdout.isTTY) {
            process.stdout.write(FULL_CLEAR);
        }

        const t5 = startupTrace.createPhase('startup.cli.registry');
        initializeRegistry();
        initializeRegistryWorker();
        await ApplicationRegistry.loadAvailableAgents();
        GlobalState.getInstance().taskManagerState.toolsetProvider = {
            listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
        };
        t5.end();

        const t6 = startupTrace.createPhase('startup.cli.tui_start');
        const tui = new OpenDeskTUI(args);
        tui.start();
        t6.end();

        // 为从磁盘恢复的旧任务设置延迟 harness 初始化
        await tui.taskManagerState.setupLazyHarnessInit(
            tui.activeMode,
            args.workspace,
            () => tui.permissionPromptProvider
        );

        // Initialize channelmgr after registry is ready
        ApplicationRegistry.onReady(async () => {
            const channelMgrApp = ApplicationRegistry.getApplication('channelmgr') as ChannelMgrApplication | undefined;
            if (channelMgrApp) {
                const router = new ChannelMessageRouter(tui.taskManagerState, args.workspace, args.model);

                const CHANNEL_NAMES: Record<string, string> = {
                    feishu: '飞书',
                    'openclaw-weixin': '微信',
                    whatsapp: 'WhatsApp',
                    zalouser: 'Zalo',
                    telegram: 'Telegram',
                    discord: 'Discord',
                    slack: 'Slack',
                    signal: 'Signal'
                };

                router.onTaskResolved = (task, message) => {
                    const channelName = CHANNEL_NAMES[message.channelId] || message.channelId;
                    const senderLabel = message.senderName || '新联系人';
                    const preview =
                        (message.text || '').length > 60
                            ? (message.text || '').slice(0, 57) + '...'
                            : message.text || '';

                    tui.switchToTask(task);

                    NotificationManager.getInstance().info(
                        channelName,
                        `${senderLabel} 的${channelName}消息`,
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
                if (args.resume) {
                    // -c 模式下 resume：找不到任务直接报错退出
                    const result = tui.taskManagerState.getTaskLoadResult(args.resume);
                    const task = result.task;
                    if (!task) {
                        process.stderr.write(`[error] ${t('cli.resume.not_found.detail', { taskId: args.resume })}\n`);
                        process.exit(1);
                        return;
                    }
                    if (result.corrupted) {
                        tui.taskManagerState.removeCorruptedTaskEntry(args.resume);
                        process.stderr.write(`[error] ${t('task.corrupted.detail', { taskId: args.resume })}\n`);
                        process.exit(1);
                        return;
                    }
                    tui.resumeTask(args.resume, args.command!);
                } else {
                    tui.executeCommand(args.command!);
                }
            });
        } else if (args.resume) {
            ApplicationRegistry.onReady(() => {
                tui.resumeTask(args.resume);
            });
        }

        // 所有 onReady 回调注册完毕后，追加最后一个回调来结束 root trace
        ApplicationRegistry.onReady(() => {
            startupTrace.end();
        });
    }

    // 启动完成后异步清理过期日志，不阻塞主流程
    dropDeprecatedLogs().catch(() => {});
}

// 遥测 SDK 在进程退出时关闭，刷新待发送的 span
let _telemetryShutdownDone = false;

async function doGracefulTelemetryShutdown(): Promise<void> {
    if (_telemetryShutdownDone) return;
    _telemetryShutdownDone = true;
    await shutdownTelemetry();
}

process.on('beforeExit', () => {
    doGracefulTelemetryShutdown();
});

// SIGTERM / SIGINT 下也需要刷新 span（beforeExit 不会在强制终止时触发）
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        doGracefulTelemetryShutdown().then(() => process.exit(0));
    });
}

parseCommandLineArgs();
