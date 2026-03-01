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

import { ChatContext, UserMessage, AssistantMessage, FileMessagePart, SystemMessage, AssistantResponse, AssistantMessagePart, Usage, ToolCall } from '../aikernel/messages.js';
import { BaseToolset } from '../aikernel/tool.js';
import { LLM } from '../aikernel/llm.js';
import { getTaskDirectory } from '../utils/setting.js';
import { logger } from '../utils/logger.js';
import { ApplicationRegistry } from '../applications/registry.js';
import { jsonrepair } from 'jsonrepair';
import officeParser from 'officeparser';
import path from 'path';
import fs from 'fs';
import { SkillRegistry } from '../aikernel/skill.js';


type TaskStatus = 'waiting' | 'running' | 'stopped';

export interface TaskUpdateChunk {
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    last_part_index: number;
    last_part: AssistantMessagePart;
    usage?: Usage;
}

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
    task_name: string | null = null;
    task_status: TaskStatus = 'waiting';
    chat_context: ChatContext = new ChatContext();
    subscribers: BaseTaskUpdateSubscriber[] = [];
    task_manager_state: TaskManagerState;
    model?: string;
    message_queue: string[] = [];

    constructor(task_manager_state: TaskManagerState) {
        this.task_manager_state = task_manager_state;
    }

    static load(task_json_path: string, task_manager_state: TaskManagerState): TaskState {
        const task_json = JSON.parse(fs.readFileSync(task_json_path, 'utf8'));
        const task = new TaskState(task_manager_state);
        task.task_id = task_json.task_id;
        task.task_name = task_json.task_name;
        // 从硬盘加载的任务如果是running状态，则说明其在运行时被异常中断关闭了
        task.task_status = task_json.task_status === 'running' ? 'failed' : task_json.task_status;
        task.chat_context = ChatContext.assign(task_json.chat_context);
        return task;
    }

    toSimplifiedJSON() {
        return {
            task_id: this.task_id,
            task_name: this.task_name,
            task_status: this.task_status,
        }
    }

    toJSON() {
        return {
            task_id: this.task_id,
            task_name: this.task_name,
            task_status: this.task_status,
            chat_context: this.chat_context.toJSON(),
        }
    }

    async setSystemPrompt(prompt: string) {
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

    /**
     * Submit a message to the task
     */
    async submitUserMessage(message: string) {
        this.task_status = 'running';
        this.task_manager_state.publishTaskListUpdate();

        let user_message = new UserMessage(message);
        let assistant_message = new AssistantMessage();
        this.chat_context.appendMessage(user_message);
        this.chat_context.appendMessage(assistant_message);

        let toolsets = await ApplicationRegistry.listAvailableToolsets();
        let skillToolset = SkillRegistry.getInstance().getToolset();
        this.chat_context.attachToolsets(...toolsets);
        this.chat_context.attachToolsets(skillToolset);

        logger.info(`messsage submitted to task ${this.task_id}`)

        if (this.task_name === null) {
            this.generateTaskName(message).then(() => {
                this.task_manager_state.publishTaskListUpdate();
            });
        }

        this.processTask();
    }

    /**
     * Stop the task execution
     */
    stop() {
        if (this.task_status === 'stopped') {
            return;
        }
        this.task_status = 'stopped';
        logger.info(`task ${this.task_id} stopped by user`);
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
        const task_name = await LLM.ask(new UserMessage(prompt))
            .catch(err => {
                logger.error(err);
                return null;
            })
        this.task_name = task_name;
    }

    /**
     * 向前端的订阅者发布任务状态更新，如果指定了part_index，则只更新该part
     * 否则更新最后一个part
     */
    async sendSubscriptionFeedback(part_index: number | undefined = undefined) {
        let last_message = this.chat_context.lastMessage();
        if (last_message === undefined || last_message.content.length === 0 || last_message instanceof UserMessage) {
            return;
        }

        let updated_part_index = part_index !== undefined ? part_index : last_message.content.length - 1;
        let last_part = last_message.content[updated_part_index];
        /* render the last part before sending the update to the subscribers */

        try {
            await last_part.render();
            var chunkUpdate: TaskUpdateChunk = {
                task_id: this.task_id,
                task_status: this.task_status,
                message_id: last_message.message_id,
                last_part_index: updated_part_index,
                last_part: last_part,
                usage: last_message.usage
            };

            this.subscribers = this.subscribers.filter(subscriber => subscriber.isAvailable());
            for (let subscriber of this.subscribers) {
                subscriber.send(chunkUpdate);
            }
        } catch (err) {
            logger.error(`error sending subscription feedback for task ${this.task_id}: ${err.message}`);
        }
    }

    async processCompletion() {
        let assistant_message = this.chat_context.lastMessage()
        if (assistant_message === undefined || assistant_message instanceof UserMessage) {
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
     * Process a tool call
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
            let args = undefined;
            if (tool_call.args_string) {
                try {
                    args = JSON.parse(tool_call.args_string);
                } catch (err) {
                    logger.warn(`failed to parse args string ${tool_call.args_string} for tool ${tool_call.tool_name}: ${err.message}`);
                }

                try {
                    args = JSON.parse(jsonrepair(tool_call.args_string));
                } catch (err) {
                    logger.error(`failed to repair args string ${tool_call.args_string} for tool ${tool_call.tool_name}: ${err.message}`);
                    throw err;
                }
            }
            tool_call.args_object = args;
            tool_call.status = 'running';
            await this.sendSubscriptionFeedback();

            /* 在执行工具前检查是否任务已经被中止 */
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
            tool_call.result = err.message;
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
        if (lastMessage instanceof UserMessage) {
            return false;
        }

        let has_pending_tool_call = false;

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
                        has_pending_tool_call = true;

                        await this.processToolCall(tool_call);
                        await tool_call.render();
                        await this.sendSubscriptionFeedback(index);
                    }
                }
            }
        }

        return has_pending_tool_call;
    }

    async processTask() {
        while (this.task_status !== 'stopped') {
            await this.processCompletion();
            // @ts-ignore 这里的task_status可能通过前端的请求被随时中止
            if (this.task_status === 'stopped') {
                break;
            }

            if (!await this.processToolCalls()) {
                break;  /* no more tool calls to process, break */
            }
        }

        if (this.task_status !== 'stopped') {
            this.task_status = 'stopped';
        }
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
     * Get a simplified list of tasks
     * @returns the list of tasks
     */
    getTaskList(): object[] {
        return this.tasks.map(task => task.toSimplifiedJSON());
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
     * Remove a task by its id
     */
    removeTask(taskId: string): void {
        this.tasks = this.tasks.filter(task => task.task_id !== taskId);
        this.publishTaskListUpdate();

        // Delete just the specific task's file
        const taskDirectory = getTaskDirectory();
        const taskFile = path.join(taskDirectory, `${taskId}.json`);
        if (fs.existsSync(taskFile)) {
            fs.unlinkSync(taskFile);
        }

        this.save();
    }

    /**
     * Remove all tasks from the task manager
     */
    clearAllTasks(): void {
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