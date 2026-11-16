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
    useDumpLogTransport,
    interceptConsole,
    dropDeprecatedLogs,
    getLogFilename,
    reloadLoggerFileTransport
} from './utils/logger.js';
import { initializeRegistry, initializeRegistryWorker, ApplicationRegistry } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';
import { GlobalState } from './aikernel/states/global.js';
import { initializeTrash, startTrashPreviewCleanupScheduler } from './utils/trash.js';
import { FULL_CLEAR } from './tui/components/constants';
import { OpenDeskTUI, CommandLineArgs } from './tui/entry.js';
import { HeadlessRunner } from './tui/headless.js';
import { Setting, getDefaultOpendeskDirectory, setCustomOpendeskDirectory, isOpendeskDebugMode } from './utils/setting';
import {
    isRecoverableMainProcessError,
    logRecoverableMainProcessError,
    shouldDowngradeRecoverableError
} from './utils/recoverable-errors.js';
import { program as prog, Option } from 'commander';
import {
    PluginToolsetProvider,
    combineToolsetProviders,
    findUnusablePluginDirectories,
    initializePluginHost,
    setRuntimePluginsDirectories,
    syncPluginSkillServers
} from './applications/pluginmgr/index.js';
import { ChannelMgrApplication } from './applications/channelmgr/app.js';
import { ChannelMessageRouter } from './applications/channelmgr/router.js';
import { initTelemetry, shutdownTelemetry } from './telemetry/index.js';
import { startReporter } from './utils/reporter.js';
import { AgentRegistry } from './aikernel/agents/registry.js';
import { NotificationManager } from './utils/notificationmgr.js';
import { registerToolsCommand } from './tui/subcommands/tools.js';
import { registerQuickpassCommand } from './tui/subcommands/quickpass.js';
import { registerServeCommand } from './tui/subcommands/serve.js';
import { registerAccountCommand } from './tui/subcommands/account.js';
import { setRuntimeLocale, t } from '../locale/index.js';
import type { BaseApplication } from './applications/base.js';

import { registerGoalHooks } from './aikernel/goal/hooks.js';
import { initializeHarnesses } from './aikernel/harnesses/index.js';
import { OPENDESK_ENV_VAR_DOCS } from './tui/env.js';

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

// 可恢复错误只提示不退出：此时 logger 可能尚未初始化，直接写 stderr
function warnToStderr(message: string): void {
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

    // 与桌面主进程共用同一套可恢复判定（EPIPE、窗口/renderer 销毁竞态等）。
    // 判据散落在两个入口就一定会漂移，崩溃行为会随运行模式不同
    const recoverableReason = isRecoverableMainProcessError(err);
    if (recoverableReason !== null && shouldDowngradeRecoverableError(recoverableReason, isOpendeskDebugMode())) {
        logRecoverableMainProcessError(warnToStderr, recoverableReason, `(${origin}) ${errDetails}`);
        return;
    }

    outputFatalError(`uncaughtException (${origin})`, errDetails);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    const reasonDetails = reason instanceof Error ? reason.stack || reason.message : String(reason);

    const recoverableReason = isRecoverableMainProcessError(reason);
    if (recoverableReason !== null && shouldDowngradeRecoverableError(recoverableReason, isOpendeskDebugMode())) {
        logRecoverableMainProcessError(warnToStderr, recoverableReason, `unhandledRejection: ${reasonDetails}`);
        return;
    }

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
    prog.option(
        '--language <lang>',
        'language to use (auto, zh-CN, en-US, or any language provided by locale pack plugins)',
        (v) => v
    );
    prog.option('--render-interval <ms>', 'render throttle base interval in milliseconds (default: 100)', (v) =>
        parseInt(v, 10)
    );
    prog.option(
        '--config-directory <path>',
        `specify custom config directory (default: ${getDefaultOpendeskDirectory()})`,
        (v) => v
    );
    prog.option('--plugins-directory <paths>', t('cli.plugins_directory.description'), (v) => v);
    prog.option('-v, --version', 'print the version');

    // 附加插件目录要在任何 action 之前生效：子命令（plugins list 等）不会触发根命令的
    // action，用 preAction 钩子统一处理，避免每个子命令重复读取该选项。
    prog.hook('preAction', (thisCommand) => {
        const { pluginsDirectory } = thisCommand.opts() as { pluginsDirectory?: string };
        if (pluginsDirectory) {
            // 非法路径只告警，不影响启动
            setRuntimePluginsDirectories(pluginsDirectory);
            for (const missing of findUnusablePluginDirectories(pluginsDirectory)) {
                console.error(`[warn] ${t('cli.plugins_directory.invalid', { path: missing })}`);
            }
        }
    });

    registerToolsCommand(prog);
    registerQuickpassCommand(prog);
    registerServeCommand(prog);
    registerAccountCommand(prog);

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
            // commander v14 已无 booleanNegatable API；`--<name> <value>` 形式本身不可被
            // --no- 前缀否定（Option.negate 恒为 false），无需额外处理
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

    // 在 --help 末尾展示 OPENDESK_ 环境变量参考（仅英文，与 commander 帮助风格一致）。
    // 文档列表由 src/main/tui/env.ts 中的 OPENDESK_ENV_VAR_DOCS 自动生成，无需在此维护。
    prog.addHelpText('after', () => {
        const lines: string[] = ['', 'Environment variables (OPENDESK_*):'];
        for (const { name, description } of OPENDESK_ENV_VAR_DOCS) {
            lines.push(`  ${name.padEnd(38)} ${description}`);
        }
        lines.push('');
        return lines.join('\n');
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
            // --render-interval 的解析函数已 parseInt，运行时实际为 number
            renderInterval: kwargs.renderInterval as unknown as number | undefined,
            resume: kwargs.resume,
            appCliOptions
        });
    });

    return prog.parse();
}

async function main(args: CommandLineArgs) {
    // Worker 线程不需要遥测，其 LLM 请求通过 IPC 转发到主进程
    if (!isMainThread) {
        initializeAppWorkers();
        return;
    }

    const { initTempDir } = await import('./utils/temp.js');
    initTempDir();

    // 启动时上报设备心跳，之后每 5 小时上报一次（fire-and-forget，不阻塞主流程）
    startReporter('cli');

    (getPlatform() as CliPlatform).setWorkspace(args.workspace);
    useCliTransport();
    if (args.dumpLog) {
        useDumpLogTransport(path.resolve(args.dumpLog));
    }
    interceptConsole();

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
        GlobalState.initialize();
        initializeRegistry();
        // 统一回收站：确保 trash/ 根目录存在，并清理超过 7 天无交互任务的回收站
        initializeTrash(() => {
            const state = GlobalState.getInstance().taskManagerState;
            const tasks = state.getTaskList();
            return new Map(tasks.map((task) => [task.task_id, task.updated_at] as const));
        });
        startTrashPreviewCleanupScheduler();
        await initializePluginHost();
        AgentRegistry.initBuiltinAgents();
        registerGoalHooks();
        initializeHarnesses();

        initializeRegistryWorker();
        await ApplicationRegistry.ensureFullyLoaded();
        // 插件 bootstrap 早于全局 worker 启动，技能内部 MCP server 的首次同步在此补齐
        await syncPluginSkillServers();
        GlobalState.getInstance().taskManagerState.toolsetProvider = combineToolsetProviders(
            {
                listAvailableToolsets: (taskState) => ApplicationRegistry.listAvailableToolsets(taskState)
            },
            new PluginToolsetProvider()
        );

        const runner = new HeadlessRunner(args);
        await runner.setupLazyHarnessInit();
        await initTelemetry();
        ApplicationRegistry.onReady(() => {
            runner.execute(args.command!);
        });
    } else {
        GlobalState.initialize();
        initializeRegistry();
        await initializePluginHost();
        AgentRegistry.initBuiltinAgents();
        registerGoalHooks();
        initializeHarnesses();

        // 统一回收站：确保 trash/ 根目录存在，并清理超过 7 天无交互任务的回收站
        initializeTrash(() => {
            const state = GlobalState.getInstance().taskManagerState;
            const tasks = state.getTaskList();
            return new Map(tasks.map((task) => [task.task_id, task.updated_at] as const));
        });
        startTrashPreviewCleanupScheduler();

        // 在 TUI 接管 stdin 之前检测终端配色方案（OSC 11 查询需要直接读写 stdin/stdout）
        const { detectTerminalColorScheme } = await import('./tui/theme.js');
        await detectTerminalColorScheme();

        if (process.stdout.isTTY) {
            process.stdout.write(FULL_CLEAR);
        }

        initializeRegistryWorker();
        await ApplicationRegistry.ensureFullyLoaded();
        // 插件 bootstrap 早于全局 worker 启动，技能内部 MCP server 的首次同步在此补齐
        await syncPluginSkillServers();
        GlobalState.getInstance().taskManagerState.toolsetProvider = combineToolsetProviders(
            {
                listAvailableToolsets: (taskState) => ApplicationRegistry.listAvailableToolsets(taskState)
            },
            new PluginToolsetProvider()
        );

        const tui = new OpenDeskTUI(args);
        tui.start();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await initTelemetry();

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
                    weixin: '微信',
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
            // 闭包内无法沿用外层的类型收窄，先取出已确认存在的 resume 任务 ID
            const resumeTaskId = args.resume;
            ApplicationRegistry.onReady(() => {
                tui.resumeTask(resumeTaskId);
            });
        }
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
