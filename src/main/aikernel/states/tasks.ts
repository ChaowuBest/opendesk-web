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

import {
    ChatContext, UserMessage, UserMessagePart,
    AssistantMessage, AssistantMessagePart, FileMessagePart,
    SystemMessage, Usage, ToolCall
} from '../messages.js';
import { shouldCompact, compactContext } from '../compact.js';
import { BaseToolset } from '../tool.js';
import { LLM } from '../llm.js';
import { getTaskDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { ApplicationRegistry } from '../../applications/registry.js';
import { jsonrepair } from 'jsonrepair';
import officeParser from 'officeparser';
import path from 'path';
import fs from 'fs';
import { SkillRegistry } from '../skill.js';
import { createMemoryToolset } from '../memory/tools.js';
import { createMainPlanningToolset, createSubTaskPlanningToolset } from '../planning/tools.js';
import { TaskHooks } from '../hooks.js';


type TaskStatus = 'waiting' | 'running' | 'stopped';

export interface TaskUpdateUserChunk {
    type: 'user';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    last_part_index: number;
    last_part: UserMessagePart;
    usage?: Usage;
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

export class TaskState {

    task_id: string = crypto.randomUUID();
    parent_id: string | null = null;
    task_name: string | null = null;
    task_status: TaskStatus = 'waiting';
    chat_context: ChatContext = new ChatContext();

    model?: string;
    message_queue: string[] = [];

    stop_requested_by_user: boolean = false;
    started_at?: Date;
    finished_at?: Date;
    total_elapsed_ms: number = 0;
    bookmark_path?: string;

    /** 任务钩子，用于在一系列任务控制点中执行回调函数 */
    hooks: TaskHooks = new TaskHooks();
    /** 订阅者，主要用于在 TUI/GUI 中获取任务状态更新等 */
    subscribers: BaseTaskUpdateSubscriber[] = [];
    /** 全局任务管理器的状态 */
    task_manager_state: TaskManagerState;

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
            stop_requested_by_user: this.stop_requested_by_user,
        }
    }

    toJSON() {
        return {
            task_id: this.task_id,
            parent_id: this.parent_id,
            task_name: this.task_name,
            task_status: this.task_status,
            chat_context: this.chat_context.toJSON(),
            started_at: this.started_at?.toISOString(),
            finished_at: this.finished_at?.toISOString(),
            total_elapsed_ms: this.total_elapsed_ms,
            bookmark_path: this.bookmark_path,
            stop_requested_by_user: this.stop_requested_by_user,
        }
    }

    setSystemPrompt(prompt: string) {
        logger.info(`setting system prompt ${prompt} to task ${this.task_id}`);
        this.chat_context.system_prompt = new SystemMessage(prompt);
    }

    async attachToolset(toolset: BaseToolset) {
        logger.info(`attaching toolset ${toolset.name} to task ${this.task_id}`);
        this.chat_context.toolsets.set(toolset.name, toolset);
    }

    async attachFiles(filePaths: string[]) {
        if (filePaths.length === 0) {
            return;
        }

        let user_message = new UserMessage();
        for (let filePath of filePaths) {
            let extname = path.extname(filePath);
            let content = await officeParser.parseOfficeAsync(filePath);
            logger.info(`attach file ${filePath} to task ${this.task_id} with extension ${extname}`);
            user_message.content.push(new FileMessagePart(filePath, content));
        }

        this.chat_context.appendMessage(user_message);
    }

    /** 当 TUI 层已经执行过压缩时置 true，防止 submitUserMessage 重复压缩 */
    private _compactedBeforeSubmit = false;

    /** 标记外部已经完成一次压缩，submitUserMessage 应跳过自动压缩 */
    markCompacted() { this._compactedBeforeSubmit = true; }

    async manualCompact(): Promise<boolean> {
        return await compactContext(this.chat_context, this.model);
    }

    /**
     * Submit a message to the task
     */
    async submitUserMessage(message: string) {
        this.task_status = 'running';
        this.started_at = new Date();  // 记录任务开始时间
        this.stop_requested_by_user = false;
        this.finished_at = undefined;  // 清除之前的完成时间
        this.task_manager_state.publishTaskListUpdate();

        // 在追加新消息前检查是否需要自动压缩上下文（TUI 层可能已经做过，此处为 GUI 等场景的兜底）
        if (this._compactedBeforeSubmit) {
            this._compactedBeforeSubmit = false;
        } else {
            try {
                if (await shouldCompact(this.chat_context, this.model)) {
                    logger.info(`Auto-compacting context for task ${this.task_id}`);
                    await compactContext(this.chat_context, this.model);
                }
            } catch (err: any) {
                logger.warn(`Auto-compact check failed: ${err?.message ?? err}`);
            }
        }

        let user_message = new UserMessage(message);
        let assistant_message = new AssistantMessage();
        this.chat_context.appendMessage(user_message);
        this.chat_context.appendMessage(assistant_message);

        let toolsets = await ApplicationRegistry.listAvailableToolsets();
        let skillToolset = SkillRegistry.getInstance().getToolset();
        let memoryToolset = createMemoryToolset();
        let planningToolset = this.parent_id
            ? createSubTaskPlanningToolset()
            : createMainPlanningToolset();

        const allToolsets = [...toolsets, skillToolset, memoryToolset, planningToolset];
        this.chat_context.attachToolsets(...allToolsets);

        logger.info(`messsage submitted to task ${this.task_id}`)

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

        // 1. Delete task JSON configuration
        const taskJsonPath = path.join(taskDirectory, `${this.task_id}.json`);
        if (fs.existsSync(taskJsonPath)) {
            try {
                fs.unlinkSync(taskJsonPath);
            } catch (err) {
                logger.error(`Failed to delete task file ${taskJsonPath}: ${(err as Error).message}`);
            }
        }

        // 2. Delete associated Artifacts (logs)
        const artifactsDir = path.join(taskDirectory, 'artifacts');
        if (fs.existsSync(artifactsDir)) {
            try {
                const files = fs.readdirSync(artifactsDir);
                for (const file of files) {
                    // If filename starts with task_id, it belongs to this task
                    if (file.startsWith(`${this.task_id}_`)) {
                        const filePath = path.join(artifactsDir, file);
                        fs.unlinkSync(filePath);
                    }
                }
            } catch (err) {
                logger.error(`Failed to cleanup artifacts for task ${this.task_id}: ${(err as Error).message}`);
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
        this.task_manager_state.publishTaskListUpdate();
    }

    /**
     * Wait until task_status is no longer 'running' or 'waiting'.
     */
    async waitUntilFinished(callback?: (updateChunk: TaskUpdateChunk) => void): Promise<void> {
        const activeStatuses: TaskStatus[] = ['running', 'waiting'];
        if (!activeStatuses.includes(this.task_status)) {
            return;
        }
        return new Promise<void>((resolve) => {
            const subscriber = new CallbackTaskUpdateSubscriber((chunkUpdate: TaskUpdateChunk) => {
                callback?.(chunkUpdate);

                if (!activeStatuses.includes(chunkUpdate.task_status)) {
                    this.removeSubscriber(subscriber.subscription_id);
                    resolve();
                }
            });
            this.addSubscriber(subscriber);
        });
    }

    async generateTaskName(user_message: string) {
        const prompt = `
        你是一个任务管理助手，请根据以下用户消息生成一个任务名称: ${user_message}
        请返回一个简洁明了的任务名称，不要超过10个字符。不要包含任何其他内容。
        `

        const task_name = await LLM.ask(new UserMessage(prompt.trim()))
            .catch(err => {
                logger.error(err);
                return null;
            })

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

        // Copy chat context via serialization
        forkedTask.chat_context = ChatContext.assign(this.chat_context.toJSON());

        // Copy model
        forkedTask.model = this.model;

        // Set forked name with "-fork" suffix
        forkedTask.task_name = this.task_name ? `${this.task_name}-fork` : null;

        // Copy task status (forked task should have the same status as the original)
        forkedTask.task_status = this.task_status;

        forkedTask.started_at = this.started_at;
        forkedTask.finished_at = this.finished_at;
        forkedTask.total_elapsed_ms = this.total_elapsed_ms;

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

        this.subscribers = this.subscribers.filter(subscriber => subscriber.isAvailable());
        if (this.subscribers.length === 0) return;

        try {
            let chunkUpdate: TaskUpdateChunk
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
                };
            } else if (last_message instanceof AssistantMessage && last_message.content.length > 0) {
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
            } else {
                throw new Error('last message is not a user message or assistant message');
            }

            for (const subscriber of this.subscribers) {
                subscriber.send(chunkUpdate);
            }
        } catch (err) {
            logger.error(`error sending subscription feedback for task ${this.task_id}: ${(err as Error).message}`);
        }
    }

    async processCompletion() {
        let assistant_message = this.chat_context.lastMessage()
        if (assistant_message === undefined || !(assistant_message instanceof AssistantMessage)) {
            return;
        }

        for await (const chunk_resp of LLM.streamComplete(this.chat_context, this.model)) {
            // 检查是否已停止
            if (this.task_status === 'stopped') {
                logger.info(`task ${this.task_id} completion interrupted by stop request`);
                break;
            }

            assistant_message.mergeChunk(chunk_resp.content);
            assistant_message.usage = chunk_resp.usage;

            this.resolveStreamingToolCalls(assistant_message);

            if (this.subscribers.length == 0) {
                // no subscribers, skip
                continue;
            }

            await this.sendSubscriptionFeedback();
        }

        this.task_manager_state.save();
    }

    /**
     * 确保 chat_context 已挂载 toolsets，并为所有历史 ToolCall 解析 tool 引用。
     * 从硬盘加载任务后 toolsets 为空、ToolCall.tool 为 undefined，
     * 调用此方法后 CLI 自定义渲染器即可正常工作。
     */
    async ensureToolsResolved() {
        if (this.chat_context.toolsets.size === 0) {
            const toolsets = await ApplicationRegistry.listAvailableToolsets();
            const skillToolset = SkillRegistry.getInstance().getToolset();
            const memoryToolset = createMemoryToolset();
            this.chat_context.attachToolsets(...toolsets);
            this.chat_context.attachToolsets(skillToolset);
            this.chat_context.attachToolsets(memoryToolset);
            this.chat_context.attachToolsets(
                this.parent_id === null ?
                    createMainPlanningToolset() :
                    createSubTaskPlanningToolset()
            )
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
                        } catch { /* 解析失败不影响后续逻辑 */ }
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
                    } catch { /* streaming 阶段 JSON 不完整属正常现象 */ }
                }
            }
        }
    }

    /**
     * 完成一个工具调用的实际执行过程, 并将结果直接写入 tool_call 中
     * @param tool_call 要被执行的工具调用
     */
    async processToolCall(tool_call: ToolCall): Promise<void> {
        let tool = this.chat_context.getTool(tool_call.tool_name);
        if (tool === undefined) {
            logger.error(`tool ${tool_call.tool_name} not found`);
            tool_call.status = 'error';
            tool_call.result = `tool ${tool_call.tool_name} not found`;
            return;
        }

        tool_call.setTool(tool);
        try {
            let args: any = {};
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

            let result = await tool.execute(
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
            await tool_call.freezeRenderResult();
        }
    }

    /**
     * Process the tool calls in the last message
     * @returns true if there are tool calls to process, false otherwise
     */
    async processToolCalls(): Promise<boolean> {
        let lastMessage = this.chat_context.lastMessage();
        if (!(lastMessage instanceof AssistantMessage)) {
            return false;
        }

        const pendingCalls: { tool_call: ToolCall, partIndex: number }[] = [];

        for (let message of this.chat_context.messages) {
            if (message instanceof AssistantMessage) {
                for (let index = 0; index < message.content.length; index++) {
                    let part = message.content[index];
                    if (part.type !== 'tool_call') {
                        continue;
                    }
                    for (let tool_call of part.toolcalls) {
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

        await Promise.all(pendingCalls.map(async ({ tool_call, partIndex }) => {
            await this.processToolCall(tool_call);
            await tool_call.render();
            await this.sendSubscriptionFeedback(partIndex);
        }));

        return true;
    }

    /**
     * 执行任务的一个轮次
     *
     * 从收到消息，到反复执行工具获取结果，直到没有新的工具要执行为止，这样的过程我们
     * 称为一个轮次 (turn)。processTaskTurn 负责这个执行过程以及相关的钩子判断。
     */
    async processTaskTurn() {
        while (this.task_status !== 'stopped') {
            await this.processCompletion();
            // @ts-ignore 这里的task_status可能通过前端的请求被随时中止
            if (this.task_status === 'stopped') {
                break;
            }

            const hasToolCalls = await this.processToolCalls();
            if (hasToolCalls) {
                continue;
            }

            // 如果当前任务没有更多工具调用需要处理，那么可以结束这一个轮次(turn)了
            // 但在此之前首先要看下有没有注册的钩子函数会要求这一轮继续执行
            const checkHooks = await this.hooks.checkBeforeFinishTurn(this)
            if (checkHooks.operation === 'finish') {
                break;
            } else {
                // 如果某个钩子要求继续执行，则发送一个用户消息给 agent，并继续补全
                const user_message = new UserMessage(checkHooks.message);
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
        this.finished_at = new Date();  // 记录任务完成时间
        this.sendSubscriptionFeedback();
        this.task_manager_state.publishTaskListUpdate();
    }

    async render() {
        for (let message of this.chat_context.messages) {
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
        let subscriber = this.subscribers.find(s => s.subscription_id === subscription_id);
        if (subscriber === undefined) {
            logger.error('subscriber not found for task', this.task_id)
            return false;
        }

        this.subscribers = this.subscribers.filter(s => s.subscription_id !== subscription_id);
        logger.info('task update subscriber removed for task', this.task_id)
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

    /**
     * Load the task manager state from the file system
     * @returns the task manager state, or null if the files does not exist
     */
    static load(): TaskManagerState | null {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');
        if (!fs.existsSync(taskListFile)) {
            return null;
        }

        let taskManagerState = new TaskManagerState();
        let taskList: any[];
        try {
            taskList = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        } catch (err) {
            logger.error(`failed to load task list: ${err}`)
            return new TaskManagerState();
        }
        for (let task of taskList) {
            try {
                taskManagerState.tasks.push(TaskState.load(path.join(taskDirectory, `${task.task_id}.json`), taskManagerState));
            } catch (err) {
                logger.warn(`error loading task ${task.task_id}: ${err}`);
                continue;
            }
        }
        return taskManagerState.tasks.length > 0 ? taskManagerState : null;
    }

    save(): void {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // Write task list
        fs.writeFileSync(
            taskListFile,
            JSON.stringify(this.tasks.map(task => task.toSimplifiedJSON()), null, 4),
            { encoding: 'utf8' }
        );

        // Write individual task files
        for (let task of this.tasks) {
            const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
            fs.writeFileSync(
                taskFile,
                JSON.stringify(task.toJSON(), null, 4),
                { encoding: 'utf8' }
            );
        }
    }

    /**
     * Clean up task files that are no longer in the current tasks list
     */
    private cleanupOldTaskFiles(): void {
        const taskDirectory = getTaskDirectory();
        const existingTaskIds = new Set(this.tasks.map(task => task.task_id));

        fs.readdirSync(taskDirectory).forEach(file => {
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
        return this.tasks
            .map(task => task.toSimplifiedJSON());
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
        logger.info('task created', task.task_id)
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
        const children = this.tasks.filter(t => t.parent_id === taskId);

        for (const child of children) {
            // 递归调用，这样子任务的子任务也会被删除
            this.removeTask(child.task_id);
        }

        // 3. [清理步骤] 调用 TaskState 的 cleanup 方法删除物理文件 (JSON + Logs)
        taskToRemove.cleanup();

        // 4. [内存清理] 从内存列表中移除
        this.tasks = this.tasks.filter(task => task.task_id !== taskId);

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
        return this.tasks.find(task => task.task_id === taskId);
    }

    publishTaskListUpdate() {
        for (let subscriber of this.subscribers) {
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
        let subscriber = this.subscribers.find(s => s.subscription_id === subscription_id);
        if (subscriber === undefined) {
            logger.warn('subscriber not found for task list update')
            return false;
        }
    }

    removeSubscriberByFilter(filter: (subscriber: BaseTaskManagerUpdateSubscriber) => boolean) {
        this.subscribers = this.subscribers.filter(filter);
    }
}
