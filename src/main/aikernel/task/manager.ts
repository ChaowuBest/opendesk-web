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

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { Setting, getTaskArtifactDirectory, getTaskDirectory } from '../../utils/setting.js';
import { type ToolsetProvider, EmptyToolsetProvider } from '../tool.js';
import { deleteTaskTodos } from '../todos/task-todos.js';
import { HarnessContext } from '../security/harness.js';
import { getPlatform } from '../../../platforms/base.js';
import { MainAgentDecl } from '../agents/main/agent.js';
import { AgentRegistry } from '../agents/registry.js';
import type { AgentDecl, ModeDecl } from '../agents/common.js';
import type { Participant } from '../../plugins/types.js';
import { TaskState } from '../states/tasks.js';

/**
 * 原子写入文件：先写入临时文件，再 rename 覆盖目标文件。
 * 防止进程崩溃时产生残缺/损坏的 JSON 文件。
 */
async function _atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    await fs.promises.rename(tmpPath, filePath);
}

function _atomicWriteFileSync(filePath: string, content: string): void {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
    fs.renameSync(tmpPath, filePath);
}

export class BaseTaskManagerUpdateSubscriber {
    subscription_id: string = crypto.randomUUID();

    isAvailable() {
        return true;
    }

    send(_taskList: object[]): void {
        throw new Error('send not implemented');
    }
}

export class TaskManagerState {
    tasks: TaskState[] = [];
    subscribers: BaseTaskManagerUpdateSubscriber[] = [];
    toolsetProvider: ToolsetProvider = new EmptyToolsetProvider();
    private _deletedTaskIds: Set<string> = new Set();

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
            logger.error(`failed to parse task_list.json: ${err}, falling back to directory scan...`);
            return TaskManagerState.rebuildTaskListFromDirectory();
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
        if (taskManagerState.tasks.length > 0) {
            if (taskManagerState.tasks.some((task) => task._dirty)) {
                taskManagerState.save();
            }
            return taskManagerState;
        }
        // task_list.json 有条目但所有任务文件都加载失败，尝试从目录恢复
        logger.warn('all tasks in task_list.json failed to load, falling back to directory scan...');
        return TaskManagerState.rebuildTaskListFromDirectory();
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
            if (!file.endsWith('.json') || file === 'task_list.json' || file.endsWith('.tmp')) {
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
            const aTime = (a.updated_at ?? a.started_at)?.getTime() ?? 0;
            const bTime = (b.updated_at ?? b.started_at)?.getTime() ?? 0;
            return aTime - bTime;
        });

        taskManagerState.saveSync();
        logger.info(`task list rebuilt: ${taskManagerState.tasks.length} task(s) recovered`);
        return taskManagerState;
    }

    private _saveTimer?: ReturnType<typeof setTimeout>;
    private _lastWritePromise: Promise<void> = Promise.resolve();
    private _savePendingAfterTimer: boolean = false;
    private static SAVE_THROTTLE_MS = 2000;

    /**
     * Schedule an async throttled write of all tasks to disk.
     * Multiple calls within the throttle window are coalesced into a single write
     * of the latest state snapshot, keeping the event loop free for UI rendering.
     *
     * 如果在 timer 等待期间再次调用 save()，会标记 _savePendingAfterTimer，
     * 确保 timer 触发写入后再安排一次写入以捕获最新状态。
     */
    save(): void {
        if (this._saveTimer) {
            this._savePendingAfterTimer = true;
            return;
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = undefined;
            const hadPending = this._savePendingAfterTimer;
            this._savePendingAfterTimer = false;
            this._lastWritePromise = this._writeAll()
                .catch((err) => {
                    logger.error(`async save failed: ${err}`);
                })
                .finally(() => {
                    if (hadPending || this._savePendingAfterTimer) {
                        this._savePendingAfterTimer = false;
                        this.save();
                    }
                });
        }, TaskManagerState.SAVE_THROTTLE_MS);
    }

    private async _writeAll(): Promise<void> {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // 只写入在本进程中被修改过的任务文件，防止多进程互相覆盖。
        // 先快照脏任务并立即清除 _dirty 标记：如果在异步写入期间 persistLater()
        // 被调用，_dirty 会被重新设为 true，不会被本方法的后续逻辑意外覆盖。
        const dirtyTasks = this.tasks.filter((t) => t._dirty);
        for (const task of dirtyTasks) {
            task._dirty = false;
        }

        const results = await Promise.allSettled(
            dirtyTasks.map((task) => {
                const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
                return _atomicWriteFile(taskFile, JSON.stringify(task.toJSON(), null, 4));
            })
        );
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'rejected') {
                // 写入失败：恢复 _dirty 以便下次重试，并记录错误原因
                dirtyTasks[i]._dirty = true;
                logger.error(`failed to persist task ${dirtyTasks[i].task_id}: ${results[i].reason}`);
            }
            // 写入成功：_dirty 保持 false。如果写入期间 persistLater() 被调用过，
            // _dirty 已经是 true，不会被本方法覆盖，数据会在下次写入中落盘。
        }

        // 构建合并后的 task_list.json：保留其他进程写入的任务条目
        const mergedList = this._buildMergedTaskList(taskDirectory, taskListFile);
        await _atomicWriteFile(taskListFile, JSON.stringify(mergedList, null, 4));
    }

    /**
     * 构建合并后的任务列表：以内存任务为主，同时保留磁盘上由其他进程创建的任务条目。
     * 防止 CLI 和 GUI 同时运行时互相覆盖彼此的任务。
     */
    private _buildMergedTaskList(taskDirectory: string, taskListFile: string): object[] {
        const inMemoryIds = new Set(this.tasks.map((t) => t.task_id));
        const mergedList: object[] = this.tasks.map((t) => t.toSimplifiedJSON());

        try {
            if (!fs.existsSync(taskListFile)) return mergedList;
            const diskEntries: { task_id: string }[] = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
            for (const entry of diskEntries) {
                if (inMemoryIds.has(entry.task_id) || this._deletedTaskIds.has(entry.task_id)) {
                    continue;
                }
                const taskFile = path.join(taskDirectory, `${entry.task_id}.json`);
                if (fs.existsSync(taskFile)) {
                    mergedList.push(entry);
                }
            }
        } catch {
            // 读取/解析失败时仅使用内存中的任务列表
        }

        return mergedList;
    }

    /**
     * Synchronous write for operations that require immediate persistence
     * (e.g. rebuild, clear, remove — user may exit right after).
     */
    saveSync(): void {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // 只写入在本进程中被修改过的任务文件
        const dirtyTasks = this.tasks.filter((t) => t._dirty);
        for (const task of dirtyTasks) {
            const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
            try {
                _atomicWriteFileSync(taskFile, JSON.stringify(task.toJSON(), null, 4));
                task._dirty = false;
            } catch (err) {
                // 写入失败保持 _dirty = true 以便后续重试
                logger.error(`failed to persist task ${task.task_id} synchronously: ${err}`);
            }
        }

        // 构建合并后的 task_list.json
        const mergedList = this._buildMergedTaskList(taskDirectory, taskListFile);
        _atomicWriteFileSync(taskListFile, JSON.stringify(mergedList, null, 4));
    }

    /**
     * Cancel any pending throttled write and perform a final synchronous write.
     * Call before process exit to ensure no data is lost.
     *
     * 循环写入直到没有脏任务为止：如果在 _writeAll() 异步写入期间有新的
     * persistLater() 调用将 _dirty 重新设为 true，循环会捕获并再次写入。
     */
    async flushAllPendingSaves(): Promise<void> {
        // 取消当前节流定时器
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
        }
        this._savePendingAfterTimer = false;

        // 等待正在进行的写入完成
        await this._lastWritePromise;

        // 循环写入，直到没有脏任务或达到最大重试次数。
        // 防止在写入期间新产生的脏数据被遗漏。
        const MAX_FLUSH_RETRIES = 5;
        for (let attempt = 0; attempt < MAX_FLUSH_RETRIES; attempt++) {
            // 取消可能在等待期间被 save() 启动的新定时器
            if (this._saveTimer) {
                clearTimeout(this._saveTimer);
                this._saveTimer = undefined;
            }
            this._savePendingAfterTimer = false;

            const dirtyBefore = this.tasks.some((t) => t._dirty);
            if (!dirtyBefore) {
                break;
            }
            await this._writeAll();
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
     * Get a simplified list of tasks. The renderer uses child task entries to
     * build nested sidebar groups, so this intentionally returns all tasks.
     * @returns {object[]} the list of tasks
     */
    getTaskList() {
        return this.tasks.map((task) => task.toSimplifiedJSON());
    }

    /**
     * 将任务移动到数组末尾，使其在列表中显示为最新（sidebar 以 reverse 顺序渲染）。
     */
    moveTaskToEnd(task: TaskState): void {
        const idx = this.tasks.indexOf(task);
        if (idx >= 0 && idx < this.tasks.length - 1) {
            this.tasks.splice(idx, 1);
            this.tasks.push(task);
        }
    }

    /**
     * Create a task from user request
     * @returns the created task
     */
    createTask(model?: string, options: { internal?: boolean; taskName?: string } = {}): TaskState {
        const task = new TaskState(this);
        if (model) {
            if (Setting.getInstance().getModelInstance(model, 'chat')) {
                task.model = model;
            } else {
                logger.warn(`task ${task.task_id} requested model "${model}" not found, using global default model`);
            }
        }
        if (options.taskName !== undefined) {
            task.task_name = options.taskName;
        }
        if (options.internal) {
            task.internal = true;
        }
        logger.info('task created', task.task_id);
        this.tasks.push(task);
        this.save();
        this.publishTaskListUpdate();
        return task;
    }

    /**
     * 为任务初始化 HarnessContext：根据 mode 创建权限引擎，设置 mode 相关属性，
     * 并调用 Platform.initPlatformHarness 注入平台特定提供者。
     */
    async initHarness(task: TaskState, workspace: string, mode: ModeDecl): Promise<void> {
        const previousExecutionHost = task.harnessContext.executionHost;
        try {
            task.harnessContext = await HarnessContext.createForMode(workspace, mode);
            task.harnessContext.executionHost = previousExecutionHost;
            task.workspace = workspace;
            task.activeModeId = mode.id;
            task.allowedTools = mode.allowedTools;
            task.disabledTools = mode.disabledTools;
            await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
            await getPlatform().initPlatformHarness(task);
        } catch (err) {
            logger.warn(`Failed to init task harness, using empty context: ${err}`);
            task.harnessContext = HarnessContext.createEmpty();
            task.harnessContext.workspace = workspace;
            task.harnessContext.executionHost = previousExecutionHost;
            task.workspace = workspace;
        }
    }

    /**
     * 将 prompt 分发给指定 Agent 执行：创建任务、初始化 harness、提交消息。
     * @param agentName Agent 名称（'main' 或 AgentRegistry 中注册的名称）
     * @param modeName 使用的 Mode 名称，undefined 则使用 Agent 的默认 Mode
     * @param prompt 要提交的用户消息
     * @returns 创建好的 TaskState（已提交消息，任务开始执行）
     */
    async dispatchPromptToAgent(
        agentName: string,
        modeName: string | undefined,
        prompt: string,
        options?: { workspace?: string; origin?: Participant }
    ): Promise<TaskState> {
        // 解析 Agent
        let agentDecl: AgentDecl;
        if (agentName === 'main') {
            agentDecl = new MainAgentDecl();
        } else {
            const registered = AgentRegistry.getAgent(agentName);
            if (!registered) {
                throw new Error(`Agent "${agentName}" not found in AgentRegistry`);
            }
            agentDecl = registered;
        }

        // 解析 Mode
        const modes = agentDecl.supportedModes();
        const targetModeId = modeName || agentDecl.defaultModeId();
        const activeMode = modes.find((m) => m.id === targetModeId) ?? modes[0];

        // 获取 workspace
        const workspace = options?.workspace || getPlatform().getEffectiveWorkspace();

        // 创建任务
        const task = this.createTask();

        // 设置 origin（需在 submitUserMessage 之前，以便 buildToolsets 中 isAvailable 能读取）
        if (options?.origin) {
            task.origin = options.origin;
        }

        // 先初始化 harness（设置 workspace、权限引擎等），
        // 这样 createSystemPrompt 中的 taskCtx.getWorkspace() 才能返回正确值
        await this.initHarness(task, workspace, activeMode);

        // initHarness 设置了 task.workspace，需要立即通知前端更新工具栏副标题，
        // 否则前端在 createTask 发出的 taskListUpdate 中看到的是空 workspace，
        // 导致工具栏短暂显示全局工作区后才刷新为任务指定的工作区
        this.publishTaskListUpdate();

        // 构建 system prompt 并设置
        const systemPrompt = await agentDecl.createSystemPrompt(activeMode, task);
        task.setSystemPrompt(systemPrompt);

        // 触发 beforeTaskStart 钩子（在 system prompt 已设置但用户消息尚未提交时）
        await task.hooks.noticeBeforeTaskStart(task);

        // 提交用户消息
        await task.submitUserMessage(prompt);

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
    removeTask(taskId: string): string[] {
        const taskToRemove = this.getTask(taskId);
        if (!taskToRemove) {
            logger.warn(`Task ${taskId} not found for deletion.`);
            return [];
        }

        const removedIds = new Set<string>();
        this._removeTaskRecursive(taskId, removedIds);

        if (removedIds.size > 0) {
            this.tasks = this.tasks.filter((t) => !removedIds.has(t.task_id));
            this.publishTaskListUpdate();
            this.saveSync();
        }
        return Array.from(removedIds);
    }

    private _removeTaskRecursive(taskId: string, removedIds: Set<string>) {
        const task = this.getTask(taskId);
        if (!task || removedIds.has(taskId)) return;

        task.stop('system');

        const children = this.tasks.filter((t) => t.parent_id === taskId);
        for (const child of children) {
            this._removeTaskRecursive(child.task_id, removedIds);
        }

        task.cleanup();
        deleteTaskTodos(taskId);
        removedIds.add(taskId);
        this._deletedTaskIds.add(taskId);
    }

    /**
     * Remove all tasks from the task manager
     */
    clearAllTasks(): string[] {
        const removedIds = this.tasks.map((task) => task.task_id);
        for (const task of this.tasks) {
            this._deletedTaskIds.add(task.task_id);
            task.stop('system');
            task.cleanup();
            deleteTaskTodos(task.task_id);
        }
        this.tasks = [];
        this.publishTaskListUpdate();
        this.cleanupOldTaskFiles();
        this.saveSync();
        return removedIds;
    }

    /**
     * Find a task by its id
     * @returns the task, or undefined if the task is not found
     */
    getTask(taskId: string): TaskState | undefined {
        return this.tasks.find((task) => task.task_id === taskId);
    }

    publishTaskListUpdate() {
        const isSubscriberAvailable = (subscriber: BaseTaskManagerUpdateSubscriber) =>
            typeof subscriber.isAvailable !== 'function' || subscriber.isAvailable();

        this.removeSubscriberByFilter(isSubscriberAvailable);
        if (this.subscribers.length === 0) return;

        const taskList = this.getTaskList();
        const failedSubscriptionIds = new Set<string>();
        for (const subscriber of this.subscribers) {
            try {
                subscriber.send(taskList);
            } catch (err) {
                failedSubscriptionIds.add(subscriber.subscription_id);
                logger.warn(
                    `failed to publish task list update to subscriber ${subscriber.subscription_id}: ${(err as Error)?.message || String(err)}`
                );
            }
        }

        if (failedSubscriptionIds.size > 0) {
            this.removeSubscriberByFilter(
                (subscriber) =>
                    isSubscriberAvailable(subscriber) && !failedSubscriptionIds.has(subscriber.subscription_id)
            );
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
        this.subscribers = this.subscribers.filter((s) => s.subscription_id !== subscription_id);
        return true;
    }

    removeSubscriberByFilter(filter: (subscriber: BaseTaskManagerUpdateSubscriber) => boolean) {
        this.subscribers = this.subscribers.filter(filter);
    }
}
