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
 * Headless mode runner for OpenDesk CLI.
 *
 * 不启动 TUI 交互界面，直接执行 -c 指定的命令。
 * 流式补全仍照常进行，但不实时刷新输出——
 * 等一个逻辑块（思考、文本、工具调用）结束后再一次性打印。
 * 渲染宽度固定 80 列。
 */

import {
    TaskManagerState,
    TaskState,
    type TaskUpdateChunk,
    type TaskUpdateAssistantChunk
} from '../aikernel/states/tasks.js';
import { GlobalState } from '../aikernel/states/global.js';
import { MainAgentDecl } from '../aikernel/agents/main/agent.js';
import type { ModeDecl } from '../aikernel/agents/common.js';
import { ApplicationRegistry } from '../applications/registry.js';
import { logger } from '../utils/logger.js';
import { getTaskArtifactDirectory } from '../utils/setting.js';
import { exportTaskToHtml } from '../utils/export.js';
import { ToolCallMessagePartView } from './components/taskview.js';
import type { CommandLineArgs } from './entry.js';
import {
    UserMessage,
    AssistantMessage,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCallMessagePart,
    ErrorMessagePart
} from '../aikernel/messages.js';
import { HarnessContext } from '../aikernel/security/harness.js';
import type {
    PermissionRequest,
    PermissionUserResponse,
    PermissionPromptProvider
} from '../aikernel/security/permission.js';
import { TaskProfiler } from '../aikernel/profiler.js';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { t } from '../../locale/index.js';

const RENDER_WIDTH = 80;

// Use functions instead of constants to avoid caching translations at module load time
const HEADLESS_ACTION_LABELS = () => ({
    read: t('headless.action.read'),
    write: t('headless.action.write'),
    execute: t('headless.action.execute'),
    access: t('headless.action.access')
});
const HEADLESS_RESOURCE_LABELS = () => ({
    file: t('headless.resource.file'),
    network: t('headless.resource.network'),
    skill: t('headless.resource.skill')
});

/**
 * Headless 模式下的权限确认：无交互能力，直接拒绝 ask 请求并输出日志。
 */
class HeadlessPermissionPromptProvider implements PermissionPromptProvider {
    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        _prefixOptions: { label: string; pattern: string }[]
    ): Promise<PermissionUserResponse> {
        const first = requests[0];
        const action = HEADLESS_ACTION_LABELS()[first.action] || first.action;
        const resType = HEADLESS_RESOURCE_LABELS()[first.resourceType] || first.resourceType;
        const paths = requests.map((r) => r.resourcePath).join(', ');
        process.stdout.write(
            chalk.bold.yellow('[Permission] ') +
                `${toolName}${t('headless.permission.request')}${action}${resType}: ${paths}\n`
        );
        process.stdout.write(chalk.bold.red('[Permission] ') + `${t('headless.permission.denied')}\n`);
        return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
    }
}

export class HeadlessRunner {
    private taskManagerState: TaskManagerState;
    private agentDecl: MainAgentDecl;
    private args: CommandLineArgs;
    private activeMode: ModeDecl;

    /** 已输出过的 part 索引（message_id → Set<partIndex>），避免重复输出 */
    private flushedParts: Map<string, Set<number>> = new Map();

    constructor(args: CommandLineArgs) {
        this.args = args;
        this.taskManagerState = GlobalState.getInstance().taskManagerState;
        this.agentDecl = new MainAgentDecl();

        const modes = this.agentDecl.supportedModes();
        // allowEverything 优先级最高，等同于 unlimited mode
        const cliModeId = args.allowEverything ? 'unlimited' : args.mode?.toLowerCase();
        const defaultId = this.agentDecl.defaultModeId();
        if (cliModeId) {
            const found = modes.find((m) => m.id === cliModeId);
            if (!found) {
                const validIds = modes.map((m) => m.id).join(', ');
                process.stderr.write(chalk.red(`[error] unknown mode '${cliModeId}', valid modes: ${validIds}\n`));
                process.exit(1);
            }
            this.activeMode = found;
        } else {
            this.activeMode = modes.find((m) => m.id === defaultId) ?? modes[0];
        }
    }

    /**
     * 为从磁盘恢复的旧任务设置延迟 harness 初始化。
     * 应在 execute() 之前调用，确保 getTaskLoadResult() 能触发 lazy harness init。
     */
    async setupLazyHarnessInit(): Promise<void> {
        await this.taskManagerState.setupLazyHarnessInit(
            this.activeMode,
            this.args.workspace,
            () => new HeadlessPermissionPromptProvider(),
            (mode, task) => this.agentDecl.createSystemPrompt(mode, task)
        );
    }

    async execute(command: string): Promise<void> {
        const startTime = Date.now();

        process.stdout.write(
            chalk.dim(
                `[${t('headless.mode.label')}] ${this.activeMode.icon} ${this.activeMode.name} - ${this.activeMode.description}`
            ) + '\n'
        );

        let task: TaskState;
        if (this.args.resume) {
            const result = this.taskManagerState.getTaskLoadResult(this.args.resume);
            const existingTask = result.task;
            if (!existingTask) {
                process.stderr.write(
                    chalk.red(`[error] ${t('cli.resume.not_found.detail', { taskId: this.args.resume })}\n`)
                );
                process.exit(1);
                return; // for type checker
            }
            if (result.corrupted) {
                this.taskManagerState.removeCorruptedTaskEntry(this.args.resume);
                process.stderr.write(
                    chalk.red(`[error] ${t('task.corrupted.detail', { taskId: this.args.resume })}\n`)
                );
                process.exit(1);
                return;
            }
            task = existingTask;
        } else {
            task = this.taskManagerState.createTask(this.args.model, { taskName: this.args.taskName });
        }

        if (this.args.profile) {
            task.profiler = new TaskProfiler(task.task_id);
        }

        // 初始化 harness（resume 的任务也需要重新初始化，因为 harnessContext 不落盘）
        try {
            task.harnessContext = await HarnessContext.createForMode(this.args.workspace, this.activeMode);
            task.harnessContext.permissionPrompt = new HeadlessPermissionPromptProvider();
            task.activeModeId = this.activeMode.id;
            task.disabledTools = this.activeMode.disabledTools;
            await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
        } catch (err) {
            logger.warn(`Failed to init headless task harness: ${err}`);
        }

        const refreshedLazyPrompt = await this.taskManagerState.refreshLazyTaskSystemPrompt(task, (mode, taskState) =>
            this.agentDecl.createSystemPrompt(mode, taskState)
        );
        if (!this.args.resume || !refreshedLazyPrompt) {
            const systemPrompt = await this.agentDecl.createSystemPrompt(this.activeMode, task);
            await task.setSystemPrompt(systemPrompt);
        }
        if (this.args.resume) {
            // resume 时需要先解析工具引用，再打印历史对话
            await task.ensureToolsResolved();
            this.printHistory(task);
        }

        // 打印用户输入
        this.printUserMessage(command);

        await task.submitUserMessage(command);

        /**
         * 收集 chunk 更新。我们不在 chunk 回调里直接输出——
         * 而是追踪 part 状态变化，在"块"结束时批量输出。
         *
         * "块结束"的判据：
         * - reasoning part: 下一个 chunk 不再是 reasoning（或 message 结束）
         * - text part: 下一个 chunk 不再是 text（或 message 结束）
         * - tool_call part: 工具调用创建时输出一次，所有工具完成后再输出一次
         * - error part: 立即输出
         *
         * 为简化逻辑，我们采用"上一个 part 与当前 part 不同时 flush 上一个"的策略。
         */
        let lastChunk: TaskUpdateAssistantChunk | undefined;

        await task.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
            if (chunkUpdate.type === 'user') {
                // 内部消息（如 hook reject），不输出
                if (chunkUpdate.internal) return;
                this.printUserMessage(chunkUpdate.last_part?.text ?? '');
                return;
            }

            // replace/retry chunk 仅用于交互式前端状态更新，headless 输出忽略
            if (
                chunkUpdate.type === 'user_replace' ||
                chunkUpdate.type === 'assistant_replace' ||
                chunkUpdate.type === 'retry'
            ) {
                return;
            }

            const chunk = chunkUpdate as TaskUpdateAssistantChunk;
            if (!chunk.last_part) {
                // last_part 可能不存在（如流式更新异常），跳过处理
                return;
            }
            const partType = chunk.last_part.type;
            if (typeof partType !== 'string') {
                logger.warn(`headless skipped assistant chunk with invalid part type: message=${chunk.message_id}`);
                return;
            }
            const partIndex = chunk.last_part_index;

            // 当 part 类型或索引发生变化，说明上一个 part 已完成，flush 它
            if (lastChunk && lastChunk.last_part) {
                const prevType = lastChunk.last_part.type;
                const prevIndex = lastChunk.last_part_index;
                const prevMsgId = lastChunk.message_id;

                const changed = chunk.message_id !== prevMsgId || partIndex !== prevIndex || partType !== prevType;

                if (changed) {
                    this.flushPart(prevMsgId, prevIndex, lastChunk.last_part, task);
                }
            }

            // error 类型立即输出
            if (partType === 'error') {
                this.flushPart(chunk.message_id, partIndex, chunk.last_part, task);
            }

            // tool_call: 当所有工具都已完成时输出
            if (partType === 'tool_call') {
                const tcPart = chunk.last_part as ToolCallMessagePart;
                const toolcalls = Array.isArray(tcPart.toolcalls) ? tcPart.toolcalls : [];
                const allDone = toolcalls.every((tc) => !tc || (tc.status !== 'pending' && tc.status !== 'running'));
                if (allDone) {
                    this.flushPart(chunk.message_id, partIndex, chunk.last_part, task);
                }
            }

            lastChunk = chunk;
        });

        // flush 最后一个 part
        if (lastChunk) {
            this.flushPart(lastChunk.message_id, lastChunk.last_part_index, lastChunk.last_part, task);
        }

        // ── 统计信息 ──
        const elapsed = Date.now() - startTime;
        const lastMsg = task.chat_context.lastMessage();
        let totalTokens = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        if (lastMsg instanceof AssistantMessage && lastMsg.usage) {
            totalTokens = lastMsg.usage.total_tokens;
            promptTokens = lastMsg.usage.prompt_tokens;
            completionTokens = lastMsg.usage.completion_tokens;
        }

        process.stdout.write('\n');
        process.stdout.write(chalk.dim('─'.repeat(RENDER_WIDTH)) + '\n');
        process.stdout.write(chalk.bold(t('headless.task.complete')) + '\n');
        process.stdout.write(chalk.dim(`  ${t('headless.execution.time')}${this.formatDuration(elapsed)}`) + '\n');
        process.stdout.write(
            chalk.dim(
                `  ${t('headless.token.usage')}${totalTokens} (prompt: ${promptTokens}, completion: ${completionTokens})`
            ) + '\n'
        );
        process.stdout.write(chalk.dim('─'.repeat(RENDER_WIDTH)) + '\n');

        // ── before-exit hooks (export 等) ──
        if (this.args.exportHtml) {
            const htmlPath = path.resolve(this.args.workspace, this.args.exportHtml);
            try {
                await exportTaskToHtml(task, htmlPath);
                logger.info(`Session exported to HTML: ${htmlPath}`);
            } catch (err) {
                logger.error(`Failed to export HTML: ${err}`);
            }
        }
        if (this.args.exportJson) {
            const jsonPath = path.resolve(this.args.workspace, this.args.exportJson);
            try {
                const dir = path.dirname(jsonPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(jsonPath, JSON.stringify(task.toJSON(), null, 4), {
                    encoding: 'utf8'
                });
                logger.info(`Task exported to JSON: ${jsonPath}`);
            } catch (err) {
                logger.error(`Failed to export JSON: ${err}`);
            }
        }

        if (this.args.profile && task.profiler) {
            const profilePath = path.resolve(this.args.workspace, this.args.profile);
            try {
                const report = task.profiler.finish();
                TaskProfiler.writeReport(report, profilePath);
                logger.info(`Profile written to: ${profilePath}`);
                process.stdout.write(chalk.dim(`  Profile: ${profilePath}`) + '\n');
            } catch (err) {
                logger.error(`Failed to write profile: ${err}`);
            }
        }

        // ── resume 提示 ──
        process.stdout.write(t('cli.resume.hint') + '\n');
        process.stdout.write(`  opendesk --resume ${task.task_id}\n`);

        // 退出
        try {
            await this.taskManagerState.flushAllPendingSaves();
        } catch {
            /* best-effort flush */
        }
        const worker = ApplicationRegistry.globalWorker;
        if (worker) {
            await worker.terminate();
        }
        process.exit(0);
    }

    private printUserMessage(text: string): void {
        if (!text.trim()) return;
        process.stdout.write(chalk.bold.cyan(`[${t('headless.user')}] `) + text + '\n');
    }

    /**
     * 打印任务的历史对话（resume 时使用）。
     * 遍历 chat_context 中的所有消息，跳过内部消息，复用已有的格式化逻辑。
     */
    private printHistory(task: TaskState): void {
        for (const msg of task.chat_context.messages) {
            if (msg instanceof UserMessage) {
                if (msg.internal) continue;
                this.printUserMessage(msg.getPlainText());
            } else if (msg instanceof AssistantMessage) {
                for (let i = 0; i < msg.content.length; i++) {
                    this.flushPart(msg.message_id, i, msg.content[i], task);
                }
            }
        }
    }

    /**
     * 将指定 part 渲染并输出到 stdout，确保同一个 part 只输出一次。
     * 非工具调用的 part 使用纯文本前缀输出，工具调用保留卡片渲染。
     */
    private flushPart(
        messageId: string,
        partIndex: number,
        part: AssistantMessage['content'][number],
        task: TaskState
    ): void {
        let flushed = this.flushedParts.get(messageId);
        if (!flushed) {
            flushed = new Set();
            this.flushedParts.set(messageId, flushed);
        }
        if (flushed.has(partIndex)) return;
        flushed.add(partIndex);

        if (!part || typeof part.type !== 'string') {
            logger.warn(`headless skipped invalid assistant part: message=${messageId}, index=${partIndex}`);
            return;
        }

        switch (part.type) {
            case 'reasoning': {
                const content = (part as ReasoningMessagePart).content?.trim();
                if (!content) break;
                process.stdout.write(chalk.dim(`[${t('headless.thinking')}] ` + content) + '\n');
                break;
            }
            case 'text': {
                const text = (part as TextMessagePart).text?.trim();
                if (!text) break;
                process.stdout.write(chalk.bold.green(`[${t('headless.assistant')}] `) + text + '\n');
                break;
            }
            case 'tool_call': {
                const tcPart = part as ToolCallMessagePart;
                const toolcalls = Array.isArray(tcPart.toolcalls) ? tcPart.toolcalls : [];
                for (const tc of toolcalls) {
                    if (!tc) continue;
                    if (!tc.tool && tc.tool_name) {
                        const tool = task.chat_context.getTool(tc.tool_name);
                        if (tool && typeof tc.setTool === 'function') tc.setTool(tool);
                    }
                }
                const view = new ToolCallMessagePartView();
                view.setToolcalls(toolcalls);
                const lines = view.render(RENDER_WIDTH);
                if (lines.length > 0) {
                    for (const line of lines) {
                        process.stdout.write(line + '\n');
                    }
                }
                break;
            }
            case 'error': {
                const errPart = part as ErrorMessagePart;
                const title = typeof errPart.title === 'string' ? errPart.title : t('headless.error');
                const message = typeof errPart.message === 'string' ? errPart.message : '';
                process.stdout.write(chalk.bold.red(`[${t('headless.error')}] `) + title + ': ' + message + '\n');
                break;
            }
        }
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        }
        return `${seconds}.${String(ms % 1000)
            .padStart(3, '0')
            .slice(0, 1)}s`;
    }
}
