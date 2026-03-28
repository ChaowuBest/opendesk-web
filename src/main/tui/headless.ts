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

import { TaskManagerState, TaskState, type TaskUpdateChunk, type TaskUpdateAssistantChunk } from '../aikernel/states/tasks.js';
import { GlobalState } from '../aikernel/states/global.js';
import { ShellAgentDecl } from '../aikernel/agents/shellagent.js';
import { ApplicationRegistry } from '../applications/registry.js';
import { logger } from '../utils/logger.js';
import { exportTaskToHtml } from '../utils/export.js';
import { MemoryRegistry } from '../aikernel/memory/registry.js';
import {
    ToolCallMessagePartView,
} from './components/taskview.js';
import type { CommandLineArgs } from './entry.js';
import {
    AssistantMessage,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCallMessagePart,
    ErrorMessagePart,
} from '../aikernel/messages.js';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

const RENDER_WIDTH = 80;

export class HeadlessRunner {

    private taskManagerState: TaskManagerState;
    private agentDecl: ShellAgentDecl;
    private args: CommandLineArgs;

    /** 已输出过的 part 索引（message_id → Set<partIndex>），避免重复输出 */
    private flushedParts: Map<string, Set<number>> = new Map();

    constructor(args: CommandLineArgs) {
        this.args = args;
        this.taskManagerState = GlobalState.getInstance().taskManagerState;
        this.agentDecl = new ShellAgentDecl({ workspace: args.workspace });
        MemoryRegistry.getInstance(args.workspace);
    }

    async execute(command: string): Promise<void> {
        const startTime = Date.now();

        const task = this.taskManagerState.createTask(this.args.model);
        const systemPrompt = await this.agentDecl.createSystemPrompt();
        await task.setSystemPrompt(systemPrompt);

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

            const chunk = chunkUpdate as TaskUpdateAssistantChunk;
            const partType = chunk.last_part.type;
            const partIndex = chunk.last_part_index;

            // 当 part 类型或索引发生变化，说明上一个 part 已完成，flush 它
            if (lastChunk) {
                const prevType = lastChunk.last_part.type;
                const prevIndex = lastChunk.last_part_index;
                const prevMsgId = lastChunk.message_id;

                const changed = chunk.message_id !== prevMsgId
                    || partIndex !== prevIndex
                    || partType !== prevType;

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
                const allDone = tcPart.toolcalls.every(tc => tc.status !== 'pending' && tc.status !== 'running');
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
        process.stdout.write(chalk.bold('任务完成') + '\n');
        process.stdout.write(chalk.dim(`  执行时间: ${this.formatDuration(elapsed)}`) + '\n');
        process.stdout.write(chalk.dim(`  Token 消耗: ${totalTokens} (prompt: ${promptTokens}, completion: ${completionTokens})`) + '\n');
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
                fs.writeFileSync(jsonPath, JSON.stringify(task.toJSON(), null, 4), { encoding: 'utf8' });
                logger.info(`Task exported to JSON: ${jsonPath}`);
            } catch (err) {
                logger.error(`Failed to export JSON: ${err}`);
            }
        }

        // 退出
        const worker = ApplicationRegistry.globalWorker;
        if (worker) {
            await worker.terminate();
        }
        process.exit(0);
    }

    private printUserMessage(text: string): void {
        if (!text.trim()) return;
        process.stdout.write(chalk.bold.cyan('[用户] ') + text + '\n');
    }

    /**
     * 将指定 part 渲染并输出到 stdout，确保同一个 part 只输出一次。
     * 非工具调用的 part 使用纯文本前缀输出，工具调用保留卡片渲染。
     */
    private flushPart(
        messageId: string,
        partIndex: number,
        part: AssistantMessage['content'][number],
        task: TaskState,
    ): void {
        let flushed = this.flushedParts.get(messageId);
        if (!flushed) {
            flushed = new Set();
            this.flushedParts.set(messageId, flushed);
        }
        if (flushed.has(partIndex)) return;
        flushed.add(partIndex);

        switch (part.type) {
            case 'reasoning': {
                const content = (part as ReasoningMessagePart).content.trim();
                if (!content) break;
                process.stdout.write(chalk.dim('[思考] ' + content) + '\n');
                break;
            }
            case 'text': {
                const text = (part as TextMessagePart).text.trim();
                if (!text) break;
                process.stdout.write(chalk.bold.green('[助手] ') + text + '\n');
                break;
            }
            case 'tool_call': {
                const tcPart = part as ToolCallMessagePart;
                for (const tc of tcPart.toolcalls) {
                    if (!tc.tool && tc.tool_name) {
                        const tool = task.chat_context.getTool(tc.tool_name);
                        if (tool) tc.setTool(tool);
                    }
                }
                const view = new ToolCallMessagePartView();
                view.setToolcalls(tcPart.toolcalls);
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
                process.stdout.write(chalk.bold.red('[错误] ') + errPart.title + ': ' + errPart.message + '\n');
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
        return `${seconds}.${String(ms % 1000).padStart(3, '0').slice(0, 1)}s`;
    }
}
