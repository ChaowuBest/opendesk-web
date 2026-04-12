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

import { ToolResultReplacementStates, type ToolResultReplacementState } from '../compaction/tool-results.js';
import {
    ChatContext,
    UserMessage,
    UserMessagePart,
    AssistantMessage,
    AssistantMessagePart,
    FileMessagePart,
    ImageMessagePart,
    SystemMessage,
    Usage,
    ToolCall,
    ToolCallMessagePart,
    CompactSeparatorMessage,
    extractImagePaths,
    imageToDataUri
} from '../messages.js';
import { prepareContextForModel } from '../compaction/pipeline.js';
import type { ActiveContextView } from '../compaction/types.js';
import { compactContext } from '../compact.js';
import { BaseTool, BaseToolset } from '../tool.js';
import { LLM, type ReasoningEffort, type LLMRequestOptions } from '../llm.js';
import { getTaskArtifactDirectory, getTaskDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { type ToolsetProvider, EmptyToolsetProvider } from './toolset-provider.js';
import { jsonrepair } from 'jsonrepair';
import officeParser from 'officeparser';
import path from 'path';
import fs from 'fs';
import { SkillRegistry } from '../skill.js';
import { createMemoryToolset } from '../memory/tools.js';
import { createMainPlanningToolset, createSubTaskPlanningToolset } from '../planning/tools.js';
import { createTaskInfoToolset } from './tools.js';
import { TaskHooks } from '../hooks.js';
import type { Participant } from '../plugins/types.js';
import { HarnessContext } from '../security/harness.js';
import type { PermissionRequest, PermissionCheckResult, PermissionUserResponse } from '../security/permission.js';
import { createResourcePath } from '../security/permission.js';
import { TaskProfiler } from '../profiler.js';

type TaskStatus = 'waiting' | 'running' | 'stopped';

export interface TaskUpdateUserChunk {
    type: 'user';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    last_part_index: number;
    last_part: UserMessagePart;
    usage?: Usage;
    internal?: boolean;
}

export interface TaskUpdateAssistantChunk {
    type: 'assistant';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    last_part_index: number;
    last_part: AssistantMessagePart;
    usage?: Usage;
}

export type TaskUpdateChunk = TaskUpdateUserChunk | TaskUpdateAssistantChunk;

export class BaseTaskUpdateSubscriber {
    subscription_id: string = crypto.randomUUID();

    isAvailable() {
        return true;
    }

    send(chunkUpdate: TaskUpdateChunk) {
        throw new Error('send not implemented');
    }
}

class CallbackTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    callback: (chunkUpdate: TaskUpdateChunk) => void;

    constructor(callback: (chunkUpdate: TaskUpdateChunk) => void) {
        super();
        this.callback = callback;
    }

    send(chunkUpdate: TaskUpdateChunk) {
        this.callback(chunkUpdate);
    }
}

/**
 * 生成短任务ID
 * 格式: task_时间戳8位_随机4字符
 * 示例: task_a1b2c3d4_x7yz
 *
 * 碰撞概率分析：
 * - 时间戳部分（8位36进制）：可覆盖约282年，不同毫秒必不同
 * - 随机部分（4位36进制）：约168万种可能
 * - 同一毫秒内创建任务的碰撞概率约1/168万
 */
function generateShortTaskId(): string {
    const timestamp = Date.now().toString(36).slice(-8);
    const random = Math.random().toString(36).slice(2, 6);
    return `task_${timestamp}_${random}`;
}

export class TaskState {
    task_id: string = generateShortTaskId();
    parent_id: string | null = null;
    task_name: string | null = null;
    task_status: TaskStatus = 'waiting';
    chat_context: ChatContext = new ChatContext();
    tool_result_replacement_state: ToolResultReplacementState = ToolResultReplacementStates.create();

    model?: string;
    reasoningEffort?: ReasoningEffort;
    message_queue: string[] = [];

    /**
     * 工程框架上下文：包含环境变量、权限等非聊天信息的外部约束。
     * 不参与序列化/持久化——其中的 environ 等字段可能包含敏感数据。
     */
    harnessContext: HarnessContext = HarnessContext.createEmpty();

    stop_requested_by_user: boolean = false;
    started_at?: Date;
    finished_at?: Date;
    total_elapsed_ms: number = 0;
    bookmark_path?: string;
    /** Task origin - set for channel-initiated tasks to identify the source channel */
    origin?: Participant;

    /** 性能分析器，当 CLI --profile 启用时创建 */
    profiler: TaskProfiler | null = null;

    /** 任务钩子，用于在一系列任务控制点中执行回调函数 */
    hooks: TaskHooks = new TaskHooks();
    /** 订阅者，主要用于在 TUI/GUI 中获取任务状态更新等 */
    subscribers: BaseTaskUpdateSubscriber[] = [];
    /** 文本片段完成回调，用于 channel 增量发送 - 当一个文本片段生成结束时调用（下一个片段创建时） */
    onTextPartComplete?: (text: string) => void;
    /** 全局任务管理器的状态 */
    task_manager_state: TaskManagerState;
    /** stop() 被调用时直接 resolve 所有 waitUntilFinished 的等待者 */
    private _stopResolvers: (() => void)[] = [];
    /** 标记 processTaskTurn 是否正在运行，stop() 据此决定是否立即发送 feedback */
    private _turnRunning: boolean = false;

    constructor(task_manager_state: TaskManagerState, parent_id: string | null = null) {
        this.task_manager_state = task_manager_state;
        this.parent_id = parent_id;
    }

    static load(task_json_path: string, task_manager_state: TaskManagerState): TaskState {
        const task_json = JSON.parse(fs.readFileSync(task_json_path, 'utf8'));
        const task = new TaskState(task_manager_state, task_json.parent_id || null);
        task.task_id = task_json.task_id;
        task.task_name = task_json.task_name;
        task.task_status = task_json.task_status === 'running' ? 'failed' : task_json.task_status;
        task.chat_context = ChatContext.assign(task_json.chat_context);
        task.tool_result_replacement_state = ToolResultReplacementStates.deserialize(
            task_json.tool_result_replacement_state,
            task.chat_context
        );
        if (task_json.started_at) {
            task.started_at = new Date(task_json.started_at);
        }
        if (task_json.finished_at) {
            task.finished_at = new Date(task_json.finished_at);
        }
        if (typeof task_json.total_elapsed_ms === 'number') {
            task.total_elapsed_ms = task_json.total_elapsed_ms;
        }
        if (task_json.bookmark_path) {
            task.bookmark_path = task_json.bookmark_path;
        }
        if (typeof task_json.stop_requested_by_user === 'boolean') {
            task.stop_requested_by_user = task_json.stop_requested_by_user;
        }
        if (task_json.origin) {
            task.origin = task_json.origin;
        }
        return task;
    }

    toSimplifiedJSON() {
        return {
            task_id: this.task_id,
            parent_id: this.parent_id,
            task_name: this.task_name,
            task_status: this.task_status,
            started_at: this.started_at?.toISOString(),
            finished_at: this.finished_at?.toISOString(),
            total_elapsed_ms: this.total_elapsed_ms,
            bookmark_path: this.bookmark_path,
            origin: this.origin,
            stop_requested_by_user: this.stop_requested_by_user
        };
    }

    toJSON() {
        const toolResultReplacementState = this.getSynchronizedToolResultReplacementState();
        return {
            task_id: this.task_id,
            parent_id: this.parent_id,
            task_name: this.task_name,
            task_status: this.task_status,
            chat_context: this.chat_context.toJSON(),
            tool_result_replacement_state: ToolResultReplacementStates.serialize(toolResultReplacementState),
            started_at: this.started_at?.toISOString(),
            finished_at: this.finished_at?.toISOString(),
            total_elapsed_ms: this.total_elapsed_ms,
            bookmark_path: this.bookmark_path,
            origin: this.origin,
            stop_requested_by_user: this.stop_requested_by_user
        };
    }

    /** 仅包含前端渲染所需的字段（不含 args_string / result 等大字段） */
    toRenderJSON() {
        return {
            task_id: this.task_id,
            task_name: this.task_name,
            task_status: this.task_status,
            model: this.model,
            reasoningEffort: this.reasoningEffort,
            chat_context: this.chat_context.toRenderJSON()
        };
    }

    setSystemPrompt(prompt: string) {
        // logger.info(`setting system prompt ${prompt} to task ${this.task_id}`);
        this.chat_context.system_prompt = new SystemMessage(prompt);
    }

    private getSynchronizedToolResultReplacementState(): ToolResultReplacementState {
        this.tool_result_replacement_state = ToolResultReplacementStates.synchronize(
            this.tool_result_replacement_state,
            this.chat_context
        );
        return this.tool_result_replacement_state;
    }

    async attachToolset(toolset: BaseToolset) {
        logger.info(`attaching toolset ${toolset.name} to task ${this.task_id}`);
        this.chat_context.toolsets.set(toolset.name, toolset);
    }

    async attachFiles(filePaths: string[]) {
        if (filePaths.length === 0) {
            return;
        }

        const user_message = new UserMessage();
        for (const filePath of filePaths) {
            const extname = path.extname(filePath);
            const content = await officeParser.parseOfficeAsync(filePath);
            logger.info(`attach file ${filePath} to task ${this.task_id} with extension ${extname}`);
            user_message.content.push(new FileMessagePart(filePath, content));
        }

        this.chat_context.appendMessage(user_message);
    }

    /** 当 TUI 层已经执行过压缩时置 true，防止 submitUserMessage 重复压缩 */
    private _compactedBeforeSubmit = false;

    /** 标记外部已经完成一次压缩，submitUserMessage 应跳过自动压缩 */
    markCompacted() {
        this._compactedBeforeSubmit = true;
    }

    async manualCompact(): Promise<boolean> {
        return await compactContext(this.chat_context, this.model);
    }

    /**
     * Submit a message to the task
     */
    async submitUserMessage(message: string) {
        this.task_status = 'running';
        this.started_at = new Date(); // 记录任务开始时间
        this.stop_requested_by_user = false;
        this.finished_at = undefined; // 清除之前的完成时间
        this.task_manager_state.publishTaskListUpdate();

        // 在追加新消息前检查是否需要自动压缩上下文（TUI 层可能已经做过，此处为 GUI 等场景的兜底）
        if (this._compactedBeforeSubmit) {
            this._compactedBeforeSubmit = false;
        } else {
            try {
                await prepareContextForModel(this.chat_context, this.model, {
                    beforeCompact: () => {
                        logger.info(`Auto-compacting context for task ${this.task_id}`);
                    }
                });
            } catch (err: unknown) {
                logger.warn(`Auto-compact check failed: ${err instanceof Error ? err.message : err}`);
            }
        }

        const user_message = new UserMessage(message);

        const imagePaths = extractImagePaths(message);
        for (const imgPath of imagePaths) {
            try {
                const dataUri = imageToDataUri(imgPath);
                user_message.content.push(new ImageMessagePart(dataUri));
                logger.info(`attached image from message text: ${imgPath}`);
            } catch (err) {
                logger.warn(`failed to read image ${imgPath}: ${err}`);
            }
        }

        const assistant_message = new AssistantMessage();
        this.chat_context.appendMessage(user_message);
        this.chat_context.appendMessage(assistant_message);

        const allToolsets = await this.buildToolsets();
        this.chat_context.attachToolsets(...allToolsets);

        // 检测用户消息中的 /skillname 引用并预加载
        await this.preloadSlashSkills(message, assistant_message);

        logger.info(`messsage submitted to task ${this.task_id}`);

        if (this.task_name === null) {
            // 这里我们先放一个占位符，避免可能出现的重复submitUserMessage导致多次起名
            this.task_name = '未命名任务';
            this.generateTaskName(message).then(() => {
                this.task_manager_state.publishTaskListUpdate();
            });
        }

        this.processTaskTurn();
    }

    /**
     * Clean up the task resources (delete JSON file and artifacts)
     * Imported from tasks.js
     * [修改: 增加 cleanup 方法，支持清理物理文件和 Artifacts 记录]
     */
    cleanup() {
        const taskDirectory = getTaskDirectory();
        const taskArtifactDirectory = getTaskArtifactDirectory(this.task_id, false);

        // 1. Delete task JSON configuration
        const taskJsonPath = path.join(taskDirectory, `${this.task_id}.json`);
        if (fs.existsSync(taskJsonPath)) {
            try {
                fs.unlinkSync(taskJsonPath);
            } catch (err) {
                logger.error(`Failed to delete task file ${taskJsonPath}: ${(err as Error).message}`);
            }
        }

        // 2. Delete task-scoped artifacts under artifacts/<taskId>/
        if (fs.existsSync(taskArtifactDirectory)) {
            try {
                fs.rmSync(taskArtifactDirectory, { recursive: true, force: true });
            } catch (err) {
                logger.error(
                    `Failed to cleanup task artifact directory ${taskArtifactDirectory}: ${(err as Error).message}`
                );
            }
        }

        // 3. Compatibility cleanup for older task-scoped artifacts under tasks/artifacts/
        const legacyArtifactsDir = path.join(taskDirectory, 'artifacts');
        if (fs.existsSync(legacyArtifactsDir)) {
            try {
                const entries = fs.readdirSync(legacyArtifactsDir);
                for (const entry of entries) {
                    if (!entry.startsWith(`${this.task_id}_`)) {
                        continue;
                    }
                    fs.rmSync(path.join(legacyArtifactsDir, entry), { recursive: true, force: true });
                }
            } catch (err) {
                logger.error(`Failed to cleanup legacy artifacts for task ${this.task_id}: ${(err as Error).message}`);
            }
        }
    }
    /**
     * Stop the task execution
     */
    stop(reason: 'user' | 'system' = 'user') {
        if (this.task_status === 'stopped') {
            return;
        }
        this.task_status = 'stopped';
        this.stop_requested_by_user = reason === 'user';
        this.finished_at = new Date();
        logger.info(`task ${this.task_id} stopped (reason=${reason})`);

        for (const task of this.task_manager_state.tasks) {
            if (task.parent_id === this.task_id && task.task_status !== 'stopped') {
                task.stop(reason);
            }
        }

        for (const resolver of this._stopResolvers) {
            resolver();
        }
        this._stopResolvers = [];

        if (!this._turnRunning) {
            this.sendSubscriptionFeedback();
        }
        this.task_manager_state.publishTaskListUpdate();
    }

    /**
     * Wait until task_status is no longer 'running' or 'waiting'.
     *
     * @param callback  每次收到更新 chunk 时的回调
     * @param resolveOnStop  如果为 true，当 stop() 被调用时立即 resolve（用于父任务等待子任务完成的场景）；
     *                       默认 false，则等待 processTaskTurn 正常结束后通过 sendSubscriptionFeedback 触发 resolve。
     */
    async waitUntilFinished(
        callback?: (updateChunk: TaskUpdateChunk) => void,
        resolveOnStop: boolean = false
    ): Promise<void> {
        const activeStatuses: TaskStatus[] = ['running', 'waiting'];
        if (!activeStatuses.includes(this.task_status)) {
            return;
        }
        return new Promise<void>((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                this.removeSubscriber(subscriber.subscription_id);
                resolve();
            };

            if (resolveOnStop) {
                this._stopResolvers.push(settle);
            }

            const subscriber = new CallbackTaskUpdateSubscriber((chunkUpdate: TaskUpdateChunk) => {
                callback?.(chunkUpdate);
                if (!activeStatuses.includes(chunkUpdate.task_status)) {
                    settle();
                }
            });
            this.addSubscriber(subscriber);
        });
    }

    /**
     * 从用户消息中提取 /skillname 引用，逐一查找并预加载到 assistant message 中。
     * 未找到的 skill name 静默忽略（不报错）。
     */
    private async preloadSlashSkills(message: string, assistantMessage: AssistantMessage) {
        // 提取消息中所有 /skillname 模式（skill name 规则: 小写字母、数字、连字符）
        const skillNamePattern = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=\s|$)/g;
        const matchedNames = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = skillNamePattern.exec(message)) !== null) {
            matchedNames.add(match[1]);
        }
        if (matchedNames.size === 0) return;

        const registry = SkillRegistry.getInstance();
        const allSkills = await registry.getAllSkillsFlat();

        for (const name of matchedNames) {
            // 查找 user-invocable 的 skill
            const entry = allSkills.find((e) => e.skill.frontmatter.name === name && e.skill.isUserInvocable);
            if (!entry) continue;

            const { bundleName, skill } = entry;
            try {
                const loadedSkill = await registry.getSkill(bundleName, name);
                if (!loadedSkill) continue;

                // 将 skill 的 .env 环境变量合并到当前 task 的 harnessContext.environ
                if (loadedSkill.env && Object.keys(loadedSkill.env).length > 0) {
                    Object.assign(this.harnessContext.environ, loadedSkill.env);
                    logger.info(
                        `preloaded skill ${name} env merged to task harnessContext.environ: ${Object.keys(loadedSkill.env).join(', ')}`
                    );
                }

                const fullContent = loadedSkill.getFullContent();

                const toolCall = new ToolCall(
                    0,
                    `preload_${crypto.randomUUID()}`,
                    'LoadSkill',
                    JSON.stringify({ bundleName, skillName: name })
                );
                toolCall.args_object = { bundleName, skillName: name };
                toolCall.status = 'success';
                toolCall.result = fullContent;

                const loadSkillTool = this.chat_context.getTool('LoadSkill');
                if (loadSkillTool) toolCall.setTool(loadSkillTool);

                const toolCallPart = new ToolCallMessagePart();
                toolCallPart.push(toolCall);
                assistantMessage.content.push(toolCallPart);

                logger.info(`preloaded skill via /skillname: ${bundleName}/${name}`);
            } catch (err) {
                logger.warn(`failed to preload skill ${name}: ${err}`);
            }
        }
    }

    async generateTaskName(user_message: string) {
        const prompt = `
        你是一个任务管理助手，请根据以下用户消息生成一个任务名称: ${user_message}
        请返回一个简洁明了的任务名称，不要超过10个字符。不要包含任何其他内容。
        `;

        const task_name = await LLM.ask(new UserMessage(prompt.trim())).catch((err) => {
            logger.error(err);
            return null;
        });

        this.task_name = task_name;
    }

    /**
     * Rename the task
     * @param name the new name for the task
     */
    rename(name: string) {
        this.task_name = name;
        this.task_manager_state.save();
        this.task_manager_state.publishTaskListUpdate();
        logger.info(`task ${this.task_id} renamed to "${name}"`);
    }

    /**
     * Fork the current task to create a copy with a new task_id
     * The forked task's name will have "-fork" suffix
     * @returns the forked task
     */
    fork(): TaskState {
        const forkedTask = new TaskState(this.task_manager_state, null);
        const toolResultReplacementState = this.getSynchronizedToolResultReplacementState();

        // Copy chat context via serialization
        forkedTask.chat_context = ChatContext.assign(this.chat_context.toJSON());
        forkedTask.tool_result_replacement_state = ToolResultReplacementStates.clone(toolResultReplacementState);

        // Copy model and reasoning effort
        forkedTask.model = this.model;
        forkedTask.reasoningEffort = this.reasoningEffort;

        // Set forked name with "-fork" suffix
        forkedTask.task_name = this.task_name ? `${this.task_name}-fork` : null;

        // Copy task status (forked task should have the same status as the original)
        forkedTask.task_status = this.task_status;

        forkedTask.started_at = this.started_at;
        forkedTask.finished_at = this.finished_at;
        forkedTask.total_elapsed_ms = this.total_elapsed_ms;

        // harnessContext 不落盘但 fork 时复制环境变量和权限引擎（便于工具继续使用）
        forkedTask.harnessContext.environ = { ...this.harnessContext.environ };
        forkedTask.harnessContext.permission = this.harnessContext.permission;
        forkedTask.harnessContext.permissionPrompt = this.harnessContext.permissionPrompt;
        forkedTask.harnessContext.workspace = this.harnessContext.workspace;

        // Add to task manager
        this.task_manager_state.tasks.push(forkedTask);
        this.task_manager_state.save();
        this.task_manager_state.publishTaskListUpdate();

        logger.info(`task ${this.task_id} forked to ${forkedTask.task_id}`);

        return forkedTask;
    }

    /**
     * Set bookmark path for the task
     * @param path the bookmark path, "/" for root, or unix-style path like "/folder/subfolder"
     */
    setBookmark(path: string) {
        this.bookmark_path = path;
        this.task_manager_state.save();
        this.task_manager_state.publishTaskListUpdate();
        logger.info(`task ${this.task_id} bookmark set to "${path}"`);
    }

    /**
     * Remove bookmark from the task
     */
    removeBookmark() {
        this.bookmark_path = undefined;
        this.task_manager_state.save();
        this.task_manager_state.publishTaskListUpdate();
        logger.info(`task ${this.task_id} bookmark removed`);
    }

    /**
     * 向前端的订阅者发布任务状态更新，如果指定了part_index，则只更新该part
     * 否则更新最后一个 part。根据最后一条消息类型发送 UserChunk 或 AssistantChunk。
     */
    async sendSubscriptionFeedback(part_index: number | undefined = undefined) {
        const last_message = this.chat_context.lastMessage();
        if (last_message === undefined) {
            return;
        }

        this.subscribers = this.subscribers.filter((subscriber) => subscriber.isAvailable());
        if (this.subscribers.length === 0) return;

        try {
            let chunkUpdate: TaskUpdateChunk;
            if (last_message instanceof UserMessage) {
                if (last_message.content.length === 0) return;
                const updated_part_index = part_index !== undefined ? part_index : last_message.content.length - 1;
                const last_part = last_message.content[updated_part_index];
                await last_message.render();
                chunkUpdate = {
                    type: 'user',
                    task_id: this.task_id,
                    task_status: this.task_status,
                    message_id: last_message.message_id,
                    last_part_index: updated_part_index,
                    last_part,
                    internal: last_message.internal
                };
            } else if (last_message instanceof AssistantMessage) {
                if (last_message.content.length === 0) return; // 空的助手消息，跳过
                const updated_part_index = part_index !== undefined ? part_index : last_message.content.length - 1;
                const last_part = last_message.content[updated_part_index];
                await last_part.render();
                chunkUpdate = {
                    type: 'assistant',
                    task_id: this.task_id,
                    task_status: this.task_status,
                    message_id: last_message.message_id,
                    last_part_index: updated_part_index,
                    last_part,
                    usage: last_message.usage
                };
            } else if (last_message instanceof CompactSeparatorMessage) {
                // 压缩分隔消息不需要发送订阅更新，直接返回
                return;
            } else {
                logger.warn(
                    `unexpected last message type in sendSubscriptionFeedback: ${(last_message as { role?: string }).role}`
                );
                return;
            }

            for (const subscriber of this.subscribers) {
                subscriber.send(chunkUpdate);
            }
        } catch (err) {
            logger.error(`error sending subscription feedback for task ${this.task_id}: ${(err as Error).message}`);
        }
    }

    async processCompletion() {
        const assistant_message = this.chat_context.lastMessage();
        if (assistant_message === undefined || !(assistant_message instanceof AssistantMessage)) {
            return;
        }

        let streamOptions:
            | {
                  toolResultOverrides?: Map<string, string>;
                  activeContext?: ActiveContextView;
              }
            | undefined = undefined;
        try {
            const preparation = await prepareContextForModel(this.chat_context, this.model, {
                beforeCompact: () => {
                    logger.info(`Auto-compacting context for task ${this.task_id}`);
                },
                enableToolResultBudget: true,
                taskId: this.task_id,
                toolResultReplacementState: this.tool_result_replacement_state
            });

            if (preparation.toolResultReplacementState) {
                this.tool_result_replacement_state = preparation.toolResultReplacementState;
            }

            if (preparation.budgetApplied && preparation.toolResultBudgetStats) {
                const stats = preparation.toolResultBudgetStats;
                logger.info(
                    `[Compact Step4] query-time tool result budget: groups=${stats.groupCount}, ` +
                        `overrides=${stats.overrideCount}, reapplied=${stats.reappliedCount}, ` +
                        `newlySelected=${stats.newlySelectedCount}, newlySeen=${stats.newlySeenCount}, ` +
                        `overBudgetGroups=${stats.overBudgetGroupCount}`
                );
            }

            if (preparation.compacted || preparation.toolResultStateChanged) {
                this.task_manager_state.save();
            }

            streamOptions = {
                activeContext: preparation.activeContext,
                toolResultOverrides: preparation.toolResultOverrides
            };
        } catch (err: unknown) {
            logger.warn(`Prepare context before completion failed: ${err instanceof Error ? err.message : err}`);
        }

        this.profiler?.beginLLM(this._currentTurn);

        // Track the last sent text part index to avoid duplicate sends
        let lastSentTextPartIndex = -1;
        const requestOptions: LLMRequestOptions = { reasoningEffort: this.reasoningEffort };
        for await (const chunk_resp of LLM.streamComplete(
            this.chat_context,
            this.model,
            streamOptions,
            requestOptions
        )) {
            // 检查是否已停止
            if (this.task_status === 'stopped') {
                logger.info(`task ${this.task_id} completion interrupted by stop request`);
                break;
            }

            const prevPartCount = assistant_message.content.length;
            assistant_message.mergeChunk(chunk_resp.content);
            assistant_message.usage = chunk_resp.usage;

            this.resolveStreamingToolCalls(assistant_message);

            // When content length increases, a new part was created - the previous part is now complete
            if (assistant_message.content.length > prevPartCount) {
                const prevPartIndex = prevPartCount - 1;
                const prevPart = assistant_message.content[prevPartIndex];

                // Check if the previous part is a text part that hasn't been sent yet
                if (prevPart?.type === 'text' && lastSentTextPartIndex < prevPartIndex) {
                    this.onTextPartComplete?.(prevPart.text);
                    lastSentTextPartIndex = prevPartIndex;
                }
            }

            if (this.subscribers.length == 0) {
                // no subscribers, skip
                continue;
            }

            if (assistant_message.content.length > prevPartCount) {
                // content 数组增长了（如 <think> 标签拆分产生新 part），
                // 需要同时更新被修改的旧 part 和新增的 part
                for (let i = Math.max(0, prevPartCount - 1); i < assistant_message.content.length; i++) {
                    await this.sendSubscriptionFeedback(i);
                }
            } else {
                await this.sendSubscriptionFeedback();
            }
        }

        // After streaming ends, send any remaining text part if it hasn't been sent
        const lastPart = assistant_message.content[assistant_message.content.length - 1];
        if (lastPart?.type === 'text' && lastSentTextPartIndex < assistant_message.content.length - 1) {
            this.onTextPartComplete?.(lastPart.text);
        }

        this.profiler?.endLLM({
            prompt_tokens: assistant_message.usage?.prompt_tokens,
            completion_tokens: assistant_message.usage?.completion_tokens,
            total_tokens: assistant_message.usage?.total_tokens
        });

        this.task_manager_state.save();
    }

    /**
     * 构建当前任务所需的全部 toolsets。
     * 主任务和子任务共享应用工具集与 skill 工具集，
     * 但 planning 工具集和 task-info 工具集仅主任务拥有。
     */
    async buildToolsets(): Promise<BaseToolset[]> {
        const appToolsets = await this.task_manager_state.toolsetProvider.listAvailableToolsets();
        const skillToolset = SkillRegistry.getInstance().getToolset();
        const memoryToolset = createMemoryToolset();
        const planningToolset = this.parent_id ? createSubTaskPlanningToolset() : createMainPlanningToolset();

        const all = [...appToolsets, skillToolset, memoryToolset, planningToolset];
        if (this.parent_id === null) {
            all.push(createTaskInfoToolset(this.task_manager_state));
        }
        return all;
    }

    /**
     * 确保 chat_context 已挂载 toolsets，并为所有历史 ToolCall 解析 tool 引用。
     * 从硬盘加载任务后 toolsets 为空、ToolCall.tool 为 undefined，
     * 调用此方法后 CLI 自定义渲染器即可正常工作。
     */
    async ensureToolsResolved() {
        if (this.chat_context.toolsets.size === 0) {
            const allToolsets = await this.buildToolsets();
            this.chat_context.attachToolsets(...allToolsets);
        }
        this.resolveAllToolCalls();
    }

    /**
     * 为历史消息中所有未绑定 tool 的 ToolCall 解析 tool 引用并解析 args_object。
     * 用于从硬盘加载任务后、在 toolsets 已挂载的前提下重新绑定工具，
     * 使 CLI 自定义渲染器能正常工作。
     */
    resolveAllToolCalls() {
        for (const message of this.chat_context.messages) {
            if (!(message instanceof AssistantMessage)) continue;
            for (const part of message.content) {
                if (part.type !== 'tool_call') continue;
                for (const tc of part.toolcalls) {
                    if (!tc.tool && tc.tool_name) {
                        const tool = this.chat_context.getTool(tc.tool_name);
                        if (tool) tc.setTool(tool);
                    }
                    if (tc.args_string && !tc.args_object) {
                        try {
                            tc.args_object = JSON.parse(jsonrepair(tc.args_string));
                        } catch {
                            /* 解析失败不影响后续逻辑 */
                        }
                    }
                }
            }
        }
    }

    /**
     * 在流式输出阶段提前解析 ToolCall 的 tool 引用和 args_object，
     * 使 CLI 自定义卡片能在参数生成过程中实时渲染。
     */
    private resolveStreamingToolCalls(message: AssistantMessage) {
        for (const part of message.content) {
            if (part.type !== 'tool_call') continue;
            for (const tc of part.toolcalls) {
                if (!tc.tool && tc.tool_name) {
                    const tool = this.chat_context.getTool(tc.tool_name);
                    if (tool) tc.setTool(tool);
                }
                if (tc.args_string) {
                    try {
                        tc.args_object = JSON.parse(jsonrepair(tc.args_string));
                    } catch {
                        /* streaming 阶段 JSON 不完整属正常现象 */
                    }
                }
            }
        }
    }

    /**
     * 根据 tool_call 查找对应的 BaseTool 实例（不设置 tool_call 状态）
     */
    private resolveToolForCall(tool_call: ToolCall): BaseTool<any> | undefined {
        return this.chat_context.getTool(tool_call.tool_name);
    }

    /**
     * 完成一个工具调用的实际执行过程, 并将结果直接写入 tool_call 中
     * @param tool_call 要被执行的工具调用
     * @param skipPermission 是否跳过权限检查（已在 processToolCalls 预检阶段完成时为 true）
     */
    async processToolCall(tool_call: ToolCall, skipPermission = false): Promise<void> {
        const tool = this.chat_context.getTool(tool_call.tool_name);
        if (tool === undefined) {
            logger.error(`tool ${tool_call.tool_name} not found`);
            tool_call.status = 'error';
            tool_call.result = `tool ${tool_call.tool_name} not found`;
            return;
        }

        const profilerToken = this.profiler?.beginTool(tool_call.tool_name, this._currentTurn);

        tool_call.setTool(tool);
        try {
            let args: Record<string, unknown> = {};
            if (tool_call.args_string) {
                const repaired = jsonrepair(tool_call.args_string);
                args = JSON.parse(repaired);
            }
            tool_call.args_object = args;
            tool_call.status = 'running';

            await this.sendSubscriptionFeedback();

            /* 在执行工具前检查是否任务已经被用户手动中止 */
            if (this.task_status === 'stopped') {
                tool_call.status = 'error';
                tool_call.result = '任务已停止';
                return;
            }

            if (!skipPermission) {
                /* 权限检查：工具声明所需权限 → 引擎判定 → allow/deny/ask */
                const permissionDenied = await this.handleToolPermissions(tool, args, tool_call);
                if (permissionDenied) {
                    return;
                }
            }

            await this.hooks.checkBeforeToolCall(this, tool_call);

            const result = await tool.execute(
                args,
                async (result) => {
                    tool_call.result = result.result;
                    tool_call.result_object = result.result_object;
                    await this.sendSubscriptionFeedback();
                },
                this
            );
            tool_call.status = result.status;
            tool_call.result = result.result;
            tool_call.result_object = result.result_object;
        } catch (err) {
            logger.error(err);
            tool_call.status = 'error';
            tool_call.result = `工具运行错误: ${err}`;
        } finally {
            if (profilerToken !== undefined) {
                this.profiler?.endTool(profilerToken, { status: tool_call.status });
            }
            await this.hooks.noticeAfterToolCall(this, tool_call);
            await tool_call.freezeRenderResult();
        }
    }

    /**
     * 处理工具的全部权限请求。
     *
     * 1. 收集所有声明的权限并逐条检查
     * 2. 如有 deny → 直接拒绝
     * 3. 将所有 ask 按 (resourceType, action) 分组合并
     * 4. 逐组提示用户
     *
     * @returns true 表示工具被拒绝执行，false 表示可以继续
     */
    private async handleToolPermissions(
        tool: BaseTool<any>,
        args: Record<string, unknown>,
        tool_call: ToolCall
    ): Promise<boolean> {
        const enforcer = this.harnessContext.permission;
        if (!enforcer) {
            return false;
        }

        const declaredPermissions = tool.getDeclaredPermissions(args, this);
        if (!declaredPermissions || declaredPermissions.length === 0) {
            return false;
        }

        const allResults = await enforcer.checkAllDetailed(declaredPermissions);
        if (allResults.length === 0) {
            return false;
        }

        // deny 优先：只要有一个 deny 就拒绝整个工具调用
        const denied = allResults.find((r) => r.effect === 'deny');
        if (denied) {
            tool_call.status = 'error';
            tool_call.result = `权限被拒绝: ${denied.reason || denied.request.action + ' ' + denied.request.resourcePath}`;
            tool_call.result_object = { permission_denied: true };
            return true;
        }

        // 剩下全是 ask，按 (resourceType, action) 分组合并
        const askResults = allResults.filter((r) => r.effect === 'ask');
        if (askResults.length === 0) {
            return false;
        }

        const groups = new Map<string, PermissionCheckResult[]>();
        for (const result of askResults) {
            const key = `${result.request.resourceType}:${result.request.action}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(result);
        }

        // 逐组提示用户
        for (const [, groupResults] of groups) {
            const requests = groupResults.map((r) => r.request);

            // 计算所有请求路径的共同前缀选项
            const prefixOptions = this.computePrefixOptions(requests);

            const response = await this.promptPermissionBatch(requests, tool.name, prefixOptions);

            if (response.decision === 'deny') {
                const paths = requests.map((r) => r.resourcePath).join(', ');
                tool_call.status = 'error';
                tool_call.result = `用户拒绝了权限请求: ${requests[0].action} ${paths}`;
                tool_call.result_object = { permission_denied: true };
                return true;
            }

            // 根据用户选择写回规则
            if (
                response.rememberScope === 'prefix' &&
                response.selectedPrefixPattern &&
                this.harnessContext.permission
            ) {
                await this.harnessContext.permission.addRule({
                    resourceType: requests[0].resourceType,
                    action: requests[0].action,
                    pathPattern: response.selectedPrefixPattern,
                    effect: 'allow'
                });
            } else if (response.rememberScope === 'type' && this.harnessContext.permission) {
                await this.harnessContext.permission.addRule({
                    resourceType: requests[0].resourceType,
                    action: requests[0].action,
                    pathPattern: '**',
                    effect: 'allow'
                });
            }
        }

        return false;
    }

    /**
     * 计算一组同类请求的共同前缀选项，用于让用户选择授权范围。
     * 对所有请求的 ResourcePath.getPrefixes() 取交集（保留所有请求都共享的前缀）。
     * 如果请求只有一个，直接返回其前缀。
     * 如果前缀无法取交集，返回各自的精确路径前缀。
     */
    private computePrefixOptions(requests: PermissionRequest[]): { label: string; pattern: string }[] {
        if (requests.length === 0) return [];

        const allPrefixLists = requests.map((req) =>
            createResourcePath(req.resourceType, req.resourcePath).getPrefixes()
        );

        if (allPrefixLists.length === 1) {
            return allPrefixLists[0];
        }

        // 取交集：只保留所有请求都有的 pattern
        const first = allPrefixLists[0];
        const commonPrefixes = first.filter((prefix) =>
            allPrefixLists.every((list) => list.some((p) => p.pattern === prefix.pattern))
        );

        if (commonPrefixes.length > 0) {
            return commonPrefixes;
        }

        // 没有共同前缀时，返回每个请求的精确路径
        return requests.map((req) => ({ label: req.resourcePath, pattern: req.resourcePath }));
    }

    /**
     * 通过 harnessContext 的 permissionPrompt 向用户请求权限确认（合并后的批量请求）
     */
    private async promptPermissionBatch(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[]
    ): Promise<PermissionUserResponse> {
        const promptProvider = this.harnessContext.permissionPrompt;
        if (!promptProvider) {
            logger.warn(`permission ask required but no prompt provider configured, defaulting to deny`);
            return { decision: 'deny', rememberScope: 'none' };
        }

        try {
            return await promptProvider.prompt(requests, toolName, prefixOptions);
        } catch (err) {
            logger.error(`permission prompt failed: ${err}`);
            return { decision: 'deny', rememberScope: 'none' };
        }
    }

    /**
     * Process the tool calls in the last message
     * @returns true if there are tool calls to process, false otherwise
     */
    async processToolCalls(): Promise<boolean> {
        const lastMessage = this.chat_context.lastMessage();
        if (!(lastMessage instanceof AssistantMessage)) {
            return false;
        }

        const pendingCalls: { tool_call: ToolCall; partIndex: number }[] = [];

        for (const message of this.chat_context.messages) {
            if (message instanceof AssistantMessage) {
                for (let index = 0; index < message.content.length; index++) {
                    const part = message.content[index];
                    if (part.type !== 'tool_call') {
                        continue;
                    }
                    for (const tool_call of part.toolcalls) {
                        if (tool_call.status !== 'pending') {
                            continue;
                        }
                        pendingCalls.push({ tool_call, partIndex: index });
                    }
                }
            }
        }

        if (pendingCalls.length === 0) {
            return false;
        }

        // 阶段 1：串行完成所有权限检查（避免多个权限提示同时弹出）
        const permissionResults = new Map<ToolCall, boolean>();
        for (const { tool_call } of pendingCalls) {
            const tool = this.resolveToolForCall(tool_call);
            if (tool) {
                let args: Record<string, unknown> = {};
                try {
                    if (tool_call.args_string) {
                        const repaired = jsonrepair(tool_call.args_string);
                        args = JSON.parse(repaired);
                    }
                } catch {
                    // parse 失败时不做预检，让 processToolCall 里处理
                }
                const denied = await this.handleToolPermissions(tool, args, tool_call);
                permissionResults.set(tool_call, denied);
            }
        }

        // 阶段 2：并行执行所有通过权限检查的工具（已拒绝的跳过执行阶段）
        await Promise.all(
            pendingCalls.map(async ({ tool_call, partIndex }) => {
                const alreadyDenied = permissionResults.get(tool_call);
                if (alreadyDenied) {
                    await tool_call.render();
                    await this.sendSubscriptionFeedback(partIndex);
                    return;
                }
                await this.processToolCall(tool_call, true);
                await tool_call.render();
                await this.sendSubscriptionFeedback(partIndex);
            })
        );

        return true;
    }

    /**
     * 执行任务的一个轮次
     *
     * 从收到消息，到反复执行工具获取结果，直到没有新的工具要执行为止，这样的过程我们
     * 称为一个轮次 (turn)。processTaskTurn 负责这个执行过程以及相关的钩子判断。
     */
    /** 当前 turn 索引，供 profiler 记录 */
    private _currentTurn: number = 0;

    async processTaskTurn() {
        this._turnRunning = true;
        let hookRejectCount = 0;
        this._currentTurn = 0;

        try {
            while (this.task_status !== 'stopped') {
                await this.processCompletion();
                // @ts-ignore 这里的task_status可能通过前端的请求被随时中止
                if (this.task_status === 'stopped') {
                    break;
                }

                const hasToolCalls = await this.processToolCalls();
                if (hasToolCalls) {
                    hookRejectCount = 0;
                    this._currentTurn++;
                    continue;
                }

                const checkHooks = await this.hooks.checkBeforeFinishTurn(this);
                if (checkHooks.operation === 'finish') {
                    break;
                } else {
                    hookRejectCount++;
                    if (hookRejectCount >= 10) {
                        logger.warn(
                            `task ${this.task_id}: beforeFinishTurn hook rejected ${hookRejectCount} times consecutively, force-ending turn`
                        );
                        break;
                    }
                    const backoffMs = 5_000;
                    logger.info(
                        `task ${this.task_id}: hook rejected (attempt ${hookRejectCount}), backing off ${backoffMs}ms before retry`
                    );
                    await new Promise((resolve) => setTimeout(resolve, backoffMs));
                    const user_message = new UserMessage(checkHooks.message);
                    user_message.internal = true;
                    const assistant_message = new AssistantMessage();
                    this.chat_context.appendMessage(user_message);
                    await this.sendSubscriptionFeedback();
                    this.chat_context.appendMessage(assistant_message);
                    continue;
                }
            }

            if (this.task_status !== 'stopped') {
                this.task_status = 'stopped';
            }
            await this.hooks.noticeAfterFinishTurn(this);
            this.finished_at = new Date();
            this.sendSubscriptionFeedback();
            this.task_manager_state.publishTaskListUpdate();
        } finally {
            this._turnRunning = false;
        }
    }

    async render() {
        for (const message of this.chat_context.messages) {
            await message.render();
        }
    }

    addSubscriber(subscriber: BaseTaskUpdateSubscriber) {
        this.subscribers.push(subscriber);
        return subscriber.subscription_id;
    }

    /**
     * Remove a subscriber for task update
     * @param subscription_id the subscription id
     * @returns true if the subscriber was removed, false otherwise
     */
    removeSubscriber(subscription_id: string) {
        const subscriber = this.subscribers.find((s) => s.subscription_id === subscription_id);
        if (subscriber === undefined) {
            logger.error('subscriber not found for task', this.task_id);
            return false;
        }

        this.subscribers = this.subscribers.filter((s) => s.subscription_id !== subscription_id);
        logger.info('task update subscriber removed for task', this.task_id);
        return true;
    }
}

export class BaseTaskManagerUpdateSubscriber {
    subscription_id: string = crypto.randomUUID();

    send(taskList: object[]): void {
        throw new Error('send not implemented');
    }
}

export class TaskManagerState {
    tasks: TaskState[] = [];
    subscribers: BaseTaskManagerUpdateSubscriber[] = [];
    toolsetProvider: ToolsetProvider = new EmptyToolsetProvider();

    /**
     * Load the task manager state from the file system
     * @returns the task manager state, or null if the files does not exist
     */
    static load(): TaskManagerState | null {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');
        if (!fs.existsSync(taskListFile)) {
            logger.info('task_list.json not found, attempting to rebuild from task files...');
            return TaskManagerState.rebuildTaskListFromDirectory();
        }

        const taskManagerState = new TaskManagerState();
        let taskList: { task_id: string }[];
        try {
            taskList = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        } catch (err) {
            logger.error(`failed to load task list: ${err}`);
            return new TaskManagerState();
        }
        for (const task of taskList) {
            try {
                taskManagerState.tasks.push(
                    TaskState.load(path.join(taskDirectory, `${task.task_id}.json`), taskManagerState)
                );
            } catch (err) {
                logger.warn(`error loading task ${task.task_id}: ${err}`);
                continue;
            }
        }
        return taskManagerState.tasks.length > 0 ? taskManagerState : null;
    }

    /**
     * 从任务目录中扫描所有任务 JSON 文件，重建 task_list.json。
     * 用于 task_list.json 丢失后的自动恢复以及 /recover tasks 命令。
     * @returns 重建后的 TaskManagerState，若无有效任务文件则返回 null
     */
    static rebuildTaskListFromDirectory(): TaskManagerState | null {
        const taskDirectory = getTaskDirectory();
        let files: string[];
        try {
            files = fs.readdirSync(taskDirectory);
        } catch {
            return null;
        }

        const taskManagerState = new TaskManagerState();

        for (const file of files) {
            if (!file.endsWith('.json') || file === 'task_list.json') {
                continue;
            }

            const filePath = path.join(taskDirectory, file);
            try {
                const task = TaskState.load(filePath, taskManagerState);
                taskManagerState.tasks.push(task);
                logger.info(`recovered task: ${task.task_id} (${task.task_name ?? 'unnamed'})`);
            } catch (err) {
                logger.warn(`skipping unrecoverable task file ${file}: ${err}`);
                continue;
            }
        }

        if (taskManagerState.tasks.length === 0) {
            return null;
        }

        taskManagerState.tasks.sort((a, b) => {
            const aTime = a.started_at?.getTime() ?? 0;
            const bTime = b.started_at?.getTime() ?? 0;
            return aTime - bTime;
        });

        taskManagerState.save();
        logger.info(`task list rebuilt: ${taskManagerState.tasks.length} task(s) recovered`);
        return taskManagerState;
    }

    save(): void {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // Write task list
        fs.writeFileSync(
            taskListFile,
            JSON.stringify(
                this.tasks.map((task) => task.toSimplifiedJSON()),
                null,
                4
            ),
            { encoding: 'utf8' }
        );

        // Write individual task files
        for (const task of this.tasks) {
            const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
            fs.writeFileSync(taskFile, JSON.stringify(task.toJSON(), null, 4), {
                encoding: 'utf8'
            });
        }
    }

    /**
     * Clean up task files that are no longer in the current tasks list
     */
    private cleanupOldTaskFiles(): void {
        const taskDirectory = getTaskDirectory();
        const existingTaskIds = new Set(this.tasks.map((task) => task.task_id));

        fs.readdirSync(taskDirectory).forEach((file) => {
            if (file.endsWith('.json') && file !== 'task_list.json') {
                const taskIdFromFile = path.basename(file, '.json');
                if (!existingTaskIds.has(taskIdFromFile)) {
                    fs.unlinkSync(path.join(taskDirectory, file));
                }
            }
        });
    }

    /**
     * Get a simplified list of tasks (已修改：过滤掉子任务)
     * @returns {object[]} the list of tasks
     */
    getTaskList() {
        // 关键改动：只返回 parent_id 为 null 或 undefined 的任务
        return this.tasks.map((task) => task.toSimplifiedJSON());
    }

    /**
     * Create a task from user request
     * @returns the created task
     */
    createTask(model?: string): TaskState {
        const task = new TaskState(this);
        if (model) {
            task.model = model;
        }
        logger.info('task created', task.task_id);
        this.tasks.push(task);
        this.publishTaskListUpdate();
        return task;
    }
    /**
     * Create a sub-task for tool isolation (新增方法)
     * @param {string} parentId
     * @returns {TaskState}
     */
    createSubTask(parentId: string) {
        const subTask = new TaskState(this, parentId);
        this.tasks.push(subTask);
        this.save();
        return subTask;
    }
    /**
     * Remove a task by its id (Recursive deletion)
     * @param {string} taskId
     */
    removeTask(taskId: string) {
        // 1. 找到要删除的任务对象
        const taskToRemove = this.getTask(taskId);

        if (!taskToRemove) {
            logger.warn(`Task ${taskId} not found for deletion.`);
            return;
        }

        // Stop execution first so parent task cannot continue creating more subtasks.
        taskToRemove.stop('system');

        // 2. [递归步骤] 查找所有 parent_id 为当前 taskId 的子任务
        const children = this.tasks.filter((t) => t.parent_id === taskId);

        for (const child of children) {
            // 递归调用，这样子任务的子任务也会被删除
            this.removeTask(child.task_id);
        }

        // 3. [清理步骤] 调用 TaskState 的 cleanup 方法删除物理文件 (JSON + Logs)
        taskToRemove.cleanup();

        // 4. [内存清理] 从内存列表中移除
        this.tasks = this.tasks.filter((task) => task.task_id !== taskId);

        // 5. 更新前端和保存列表
        this.publishTaskListUpdate();
        this.save();
    }

    /**
     * Remove all tasks from the task manager
     */
    clearAllTasks(): void {
        // [新增] 清空前，先遍历调用每个 task 的 cleanup，确保物理日志被销毁
        for (const task of this.tasks) {
            task.stop('system');
            task.cleanup();
        }
        this.tasks = [];
        this.publishTaskListUpdate();
        this.cleanupOldTaskFiles();
        this.save();
    }

    /**
     * Find a task by its id
     * @returns the task, or undefined if the task is not found
     */
    getTask(taskId: string): TaskState | undefined {
        return this.tasks.find((task) => task.task_id === taskId);
    }

    publishTaskListUpdate() {
        for (const subscriber of this.subscribers) {
            subscriber.send(this.getTaskList());
        }
    }

    /**
     * Add a subscriber for task list update
     * @param subscriber the subscriber to add
     */
    addSubscriber(subscriber: BaseTaskManagerUpdateSubscriber) {
        this.subscribers.push(subscriber);
        return subscriber.subscription_id;
    }

    /**
     * Remove a subscriber for task list update
     * @param {Electron.WebContents} webContents
     */
    removeSubscriber(subscription_id: string) {
        const subscriber = this.subscribers.find((s) => s.subscription_id === subscription_id);
        if (subscriber === undefined) {
            logger.warn('subscriber not found for task list update');
            return false;
        }
    }

    removeSubscriberByFilter(filter: (subscriber: BaseTaskManagerUpdateSubscriber) => boolean) {
        this.subscribers = this.subscribers.filter(filter);
    }
}
