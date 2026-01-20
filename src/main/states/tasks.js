import { ChatContext, UserMessage, AssistantMessage, ToolCallMessagePart, FileMessagePart, SystemMessage } from '../agents/messages.js';
import { LLM } from '../agents/llm.js';
import { BaseToolset } from '../agents/tool.js';
import { getTaskDirectory } from '../utils/setting.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import officeParser from 'officeparser';
import { ApplicationRegistry } from '../applications/registry.js';


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
        task.task_status = task_json.task_status;
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
     submitUserMessage(message) {
        let user_message = new UserMessage(message);
        let assistant_message = new AssistantMessage();
        this.chat_context.appendMessage(user_message);
        this.chat_context.appendMessage(assistant_message);
        this.chat_context.attachToolsets(...ApplicationRegistry.listAvailableToolsets().values());

        logger.info(`messsage submitted to task ${this.task_id}`)

        if (this.task_name === null) {
            this.generateTaskName(message).then(() => {
                this.task_manager_state.publishTaskListUpdate();
            });
        }

        this.processTask();
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
        await last_part.render();
        var subscription_feedback = {
            task_id: this.task_id,
            message_id: last_message.message_id,
            last_part_index: updated_part_index,
            last_part: last_part,
            usage: last_message.usage
        };

        this.subscribers = this.subscribers.filter(subscriber => subscriber.isAvailable());
        for (let subscriber of this.subscribers) {
            subscriber.send(subscription_feedback)
        }
    }

    async processCompletion() {
        let assistant_message = this.chat_context.messages[this.chat_context.messages.length - 1];
        for await (const chunk_resp of LLM.streamComplete(this.chat_context)) {
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
     * @param {ToolCall} tool_call
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

        try {
            let args = {};
            if (tool_call.args_string) {
                args = JSON.parse(tool_call.args_string);
            }
            tool_call.tool_title = await tool.getTitle(args);
            tool_call.status = 'running';
            await tool_call.render();
            await this.sendSubscriptionFeedback();

            let result = await tool.execute(args);
            tool_call.status = 'success';
            tool_call.result = result;
        } catch (err) {
            logger.error(err);
            tool_call.status = 'error';
            tool_call.result = err.message;
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
        while (true) {
            await this.processCompletion();
            if (!await this.processToolCalls()) {
                break;
            }
        }
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
        taskManagerState.tasks = taskList.map(
            task => TaskState.load(path.join(taskDirectory, `${task.task_id}.json`), taskManagerState)
        );
        return taskManagerState;
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