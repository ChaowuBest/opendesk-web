const { ChatContext, UserMessage, AssistantMessage, ToolCallMessagePart, FileMessagePart } = require('../agents/messages');
const { LLM } = require('../agents/llm');
const { getTaskDirectory } = require('../utils/setting');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');
const { ApplicationRegistry } = require('../applications/base');
const officeParser = require('officeparser');


class TaskUpdateSubscriber {

    /**
     * A subscriber for task update
     * @param {Electron.WebContents} web_contents
     */
    constructor (web_contents) {
        /** @type {Electron.WebContents} */
        this.web_contents = web_contents;
        /** @type {string} */
        this.subscription_id = crypto.randomUUID();
    }

    /**
     * Send a message to the subscriber
     * @param {any} message the message to send
     */
    send(message) {
        this.web_contents.send(`taskManager:taskUpdate:${this.subscription_id}`, message)
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

    async attachFiles(filePaths) {
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
        logger.info(`messsage submitted to task ${this.task_id}`)

        this.chat_context.tools = ApplicationRegistry.listAvailableTools();
        logger.info(`attach ${this.chat_context.tools.length} tools to task ${this.task_id}`);

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

    async sendSubscriptionFeedback() {
        let last_message = this.chat_context.lastMessage();
        if (last_message.content.length === 0) {
            return;
        }

        let last_part = last_message.content[last_message.content.length - 1];
        /* render the last part before sending the update to the subscribers */
        await last_part.render();
        var subscription_feedback = {
            task_id: this.task_id,
            message_id: last_message.message_id,
            last_part_index: last_message.content.length - 1,
            last_part: last_part
        };

        for (let subscriber of this.subscribers) {
            subscriber.send(subscription_feedback)
        }
    }

    async processCompletion() {
        let assistant_message = this.chat_context.messages[this.chat_context.messages.length - 1];
        for await (const chunk_resp of LLM.streamComplete(this.chat_context)) {
            assistant_message.mergeChunk(chunk_resp.content);
            if (this.subscribers.length == 0) {
                // no subscribers, skip
                continue;
            }

            await this.sendSubscriptionFeedback();
        }

        this.task_manager_state.save();
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
        let last_part = lastMessage.content[lastMessage.content.length - 1];
        if (last_part !== undefined && last_part.type === 'tool_call') {
            /** @type {ToolCallMessagePart} */
            for (let tool_call of last_part.toolcalls) {
                if (tool_call.status !== 'pending') {
                    continue;
                }

                has_pending_tool_call = true;
                let tool = this.chat_context.tools.get(tool_call.tool_name);
                if (tool === undefined) {
                    logger.error(`tool ${tool_call.tool_name} not found`);
                    return false;
                }

                try {
                    console.info(tool_call.args_string);
                    let args = JSON.parse(tool_call.args_string);
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

                await tool_call.render();
                await this.sendSubscriptionFeedback();
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
     * @param {Electron.WebContents} webContents
     * @returns {string} the subscription id
     */
    addSubscriber(web_contents) {
        let subscriber = new TaskUpdateSubscriber(web_contents);
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

module.exports = { TaskManagerState, TaskState };