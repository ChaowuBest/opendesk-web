import { ChatContext, UserMessage, AssistantMessage, ToolCallMessagePart, FileMessagePart, SystemMessage } from '../agents/messages';
import { LLM } from '../agents/llm.js';
import { getTaskDirectory } from '../utils/setting.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import officeParser from 'officeparser';
import { ApplicationRegistry } from '../applications/registry.js';
import { jsonrepair } from 'jsonrepair';


class TaskUpdateSubscriber {

    /**
     * A subscriber for task update
     * @param {import('electron').WebFrameMain} senderFrame
     */
    constructor (senderFrame) {
        /** @type {import('electron').WebFrameMain} */
        this.senderFrame = senderFrame;
        /** @type {string} */
        this.subscription_id = crypto.randomUUID();
    }

    isAvailable() {
        return !this.senderFrame.isDestroyed();
    }

    /**
     * Send a message to the subscriber
     * @param {any} message the message to send
     */
    send(message) {
        this.senderFrame.send(`taskManager:taskUpdate:${this.subscription_id}`, message);
    }
}

/**
 * @property {ChatContext} chat_context
 */
class TaskState {
    constructor (task_manager_state) {
        /** @type {string} */
        this.task_id = crypto.randomUUID();
        /** @type {string | null} */
        this.task_name = null;
        /** @type {string} */
        this.task_status = 'waiting';
        /** @type {ChatContext} */
        this.chat_context = new ChatContext();

        /** @type {TaskUpdateSubscriber[]} */
        this.subscribers = [];
        /** @type {TaskManagerState} */
        this.task_manager_state = task_manager_state;
    }

    static load(task_json_path, task_manager_state) {
        const task_json = JSON.parse(fs.readFileSync(task_json_path, 'utf8'));
        const task = new TaskState(task_manager_state);
        task.task_id = task_json.task_id;
        task.task_name = task_json.task_name;
        // 从硬盘加载的任务不能是running状态（应用重启后任务已停止）
        task.task_status = task_json.task_status === 'running' ? 'waiting' : task_json.task_status;
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

    async setSystemPrompt(prompt) {
        logger.info(`setting system prompt ${prompt} to task ${this.task_id}`);
        this.chat_context.system_prompt = new SystemMessage(prompt);
    }

    async attachToolset(toolset) {
        logger.info(`attaching toolset ${toolset.name} to task ${this.task_id}`);
        this.chat_context.toolsets.set(toolset.name, toolset);
    }

    async attachFiles(filePaths) {
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
     * @param {string} message
     */
     async submitUserMessage(message) {
        this.task_status = 'running';
        this.task_manager_state.publishTaskListUpdate();

        let user_message = new UserMessage(message);
        let assistant_message = new AssistantMessage();
        this.chat_context.appendMessage(user_message);
        this.chat_context.appendMessage(assistant_message);

        let toolsets = await ApplicationRegistry.listAvailableToolsets();
        this.chat_context.attachToolsets(...toolsets);

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

    async generateTaskName(user_message) {
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
     *
     * @param {number | undefined} part_index the index of the part to update
     * @returns {Promise<void>}
     */
    async sendSubscriptionFeedback(part_index = undefined) {
        let last_message = this.chat_context.lastMessage();
        if (last_message.content.length === 0) {
            return;
        }

        let updated_part_index = part_index !== undefined ? part_index : last_message.content.length - 1;
        let last_part = last_message.content[updated_part_index];
        /* render the last part before sending the update to the subscribers */

        try {
            await last_part.render();
            var subscription_feedback = {
                task_id: this.task_id,
                task_status: this.task_status,
                message_id: last_message.message_id,
                last_part_index: updated_part_index,
                last_part: last_part,
                usage: last_message.usage
            };

            this.subscribers = this.subscribers.filter(subscriber => subscriber.isAvailable());
            for (let subscriber of this.subscribers) {
                subscriber.send(subscription_feedback);
            }
        } catch (err) {
            logger.error(`error sending subscription feedback for task ${this.task_id}: ${err.message}`);
        }
    }

    async processCompletion() {
        let assistant_message = this.chat_context.messages[this.chat_context.messages.length - 1];
        for await (const chunk_resp of LLM.streamComplete(this.chat_context)) {
            // 检查是否已停止
            if (this.task_status === 'stopped') {
                logger.info(`task ${this.task_id} completion interrupted by stop request`);
                break;
            }

            assistant_message.mergeChunk(chunk_resp.content);
            assistant_message.usage = chunk_resp.usage;
            if (this.subscribers.length == 0) {
                // no subscribers, skip
                continue;
            }

            await this.sendSubscriptionFeedback();
        }

        this.task_manager_state.save();
    }

    /**
     * Process a tool call
     * @param {import('../agents/messages').ToolCall} tool_call
     * @returns {Promise<void>}
     */
    async processToolCall(tool_call) {
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

            let result = await tool.execute(args, async (result) => {
                tool_call.result = result.result;
                tool_call.result_object = result.result_object;
                await this.sendSubscriptionFeedback();
            });
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
     * @returns {Promise<boolean>} true if there are tool calls to process, false otherwise
     */
    async processToolCalls() {
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
            if (this.task_status === 'stopped') {
                break;  /* task is stopped, break */
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

    /**
     * Add a subscriber for task update
     * @param {Electron.SenderFrame} senderFrame
     * @returns {string} the subscription id
     */
    addSubscriber(senderFrame) {
        let subscriber = new TaskUpdateSubscriber(senderFrame);
        logger.info('task update subscriber added for task', this.task_id)
        this.subscribers.push(subscriber);
        return subscriber.subscription_id;
    }

    /**
     * Remove a subscriber for task update
     * @param {string} subscription_id
     * @returns {boolean} true if the subscriber was removed, false otherwise
     */
    removeSubscriber(subscription_id) {
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

class TaskManagerState {
    constructor () {

        /** @type {TaskState[]} */
        this.tasks = [];

        /** @type {Electron.WebContents[]} for task list update */
        this.subscribers = [];
    }

    /**
     * Load the task manager state from the file system
     * @returns {TaskManagerState | null} the task manager state, or null if the files does not exist
     */
    static load() {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');
        if (!fs.existsSync(taskListFile)) {
            return null;
        }
        const taskList = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        let taskManagerState = new TaskManagerState();
        for (let task of taskList) {
            try {
                taskManagerState.tasks.push(TaskState.load(path.join(taskDirectory, `${task.task_id}.json`), taskManagerState));
            } catch (err) {
                logger.warn(`error loading task ${task.task_id}: ${err.message}`);
                continue;
            }
        }
        return taskManagerState.tasks.length > 0 ? taskManagerState : null;
    }

    save() {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        fs.writeFileSync(
            taskListFile,
            JSON.stringify(this.tasks.map(task => task.toSimplifiedJSON()), null, 4),
            { encoding: 'utf8' }
        );

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
     * Get a simplified list of tasks
     * @returns {object[]} the list of tasks
     */
    getTaskList() {
        return this.tasks.map(task => task.toSimplifiedJSON());
    }

    /**
     * Create a task from user request
     * @param {string} userRequest
     * @returns
     */
    createTask() {
        const task = new TaskState(this);
        logger.info('task created', task.task_id)
        this.tasks.push(task);
        this.publishTaskListUpdate();
        return task;
    }

    /**
     * Remove a task by its id
     * @param {string} taskId
     */
    removeTask(taskId) {
        this.tasks = this.tasks.filter(task => task.task_id !== taskId);
        this.publishTaskListUpdate();
        this.save();
    }

    /**
     * Find a task by its id
     * @param {string} taskId
     * @returns {TaskState | undefined}
     */
    getTask(taskId) {
        return this.tasks.find(task => task.task_id === taskId);
    }

    publishTaskListUpdate() {
        for (let subscriber of this.subscribers) {
            subscriber.send('taskManager:taskListUpdate', this.getTaskList());
        }
    }

    /**
     * Add a subscriber for task list update
     * @param {Electron.WebContents} webContents
     */
    addSubscriber(webContents) {
        logger.info('task list subscriber added')
        this.subscribers.push(webContents);
    }

    /**
     * Remove a subscriber for task list update
     * @param {Electron.WebContents} webContents
     */
    removeSubscriber(webContents) {
        this.subscribers = this.subscribers.filter(subscriber => subscriber !== webContents);
    }
}

export { TaskManagerState, TaskState };