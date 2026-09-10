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
import {
    createModePermissionEnforcer,
    createTaskArtifactPermissionRules,
    HarnessContext
} from '../security/harness.js';
import { GlobPermissionEnforcer, ReadableDirectoryRegistry } from '../security/enforcer.js';
import type { PermissionEnforcer, PermissionPromptProvider, PermissionRule } from '../security/permission.js';
import { getPlatform } from '../../../platforms/base.js';
import { AgentRegistry } from '../agents/registry.js';
import type { AgentDecl, ModeDecl } from '../agents/common.js';
import type { Participant } from '../../plugins/types.js';
import { TaskState } from '../states/tasks.js';
import { atomicWriteFile, atomicWriteFileSync } from '../../utils/temp.js';
import { deserializeTaskFromIndex, indexEntryHasMetadata, normalizeTaskIndexEntry } from './serializer.js';

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
    private _sharedHarnessBaseEnforcers: Set<GlobPermissionEnforcer> = new Set();
    private _activeSharedHarnessBaseEnforcers: Set<GlobPermissionEnforcer> = new Set();
    private _disposeReadableDirectoryListener?: () => void;
    private _updateLazyHarnessMode?: (mode: ModeDecl) => void;
    private _lazyHarnessPromptModes: WeakMap<TaskState, ModeDecl> = new WeakMap();
    /**
     * Harness 延迟初始化回调，由宿主环境（Electron main / CLI）设置。
     * 当 getTaskLoadResult() 发现 task.harnessContext.workspace 为空时调用，
     * 避免启动时为所有 task 创建 GlobPermissionEnforcer（每个 ~70KB picomatch 编译开销）。
     */
    private _harnessInitializer?: (task: TaskState) => void;

    /**
     * 设置 harness 延迟初始化回调。
     * 宿主环境应在启动流程中（创建共享 enforcer 之后）调用此方法。
     */
    setHarnessInitializer(fn: (task: TaskState) => void): void {
        this._harnessInitializer = fn;
    }

    /**
     * 释放 lazy harness 使用的全局目录监听。
     * 仅应在 TaskManagerState 不再使用时调用。
     */
    disposeLazyHarnessInit(): void {
        this._disposeReadableDirectoryListener?.();
        this._disposeReadableDirectoryListener = undefined;
        this._sharedHarnessBaseEnforcers.clear();
        this._activeSharedHarnessBaseEnforcers.clear();
        this._harnessInitializer = undefined;
        this._updateLazyHarnessMode = undefined;
        this._lazyHarnessPromptModes = new WeakMap();
    }

    /**
     * 更新尚未初始化任务应使用的 mode。
     */
    updateLazyHarnessMode(mode: ModeDecl): void {
        this._updateLazyHarnessMode?.(mode);
    }

    /**
     * 为刚完成 lazy harness 初始化的任务刷新与该 mode 对应的 system prompt。
     * 生成失败时保留待刷新标记，允许后续入口重试。
     */
    async refreshLazyTaskSystemPrompt(task: TaskState): Promise<boolean> {
        const mode = this._lazyHarnessPromptModes.get(task);
        if (!mode) return false;

        const systemPrompt = await task.buildSystemPrompt();
        if (this._lazyHarnessPromptModes.get(task) !== mode) {
            return false;
        }
        task.installBuiltSystemPrompt(systemPrompt);
        this._lazyHarnessPromptModes.delete(task);
        return true;
    }

    clearLazyTaskSystemPromptRefresh(task: TaskState): void {
        this._lazyHarnessPromptModes.delete(task);
    }

    /**
     * 释放既不属于当前 lazy cache、也不再被任务 overlay 继承的共享权限基座。
     */
    pruneLazyHarnessBaseEnforcers(): void {
        const taskPermissions = this.tasks
            .map((task) => task.harnessContext.permission)
            .filter((permission): permission is PermissionEnforcer => permission !== null);
        for (const enforcer of this._sharedHarnessBaseEnforcers) {
            if (this._activeSharedHarnessBaseEnforcers.has(enforcer)) {
                continue;
            }
            const isInherited = taskPermissions.some(
                (permission) =>
                    permission === enforcer ||
                    (permission instanceof GlobPermissionEnforcer && permission.inheritsFrom(enforcer))
            );
            if (!isInherited) {
                this._sharedHarnessBaseEnforcers.delete(enforcer);
            }
        }
    }

    /**
     * 为已从磁盘恢复的旧任务设置延迟 harness 初始化。
     * 按 workspace 去重创建共享的只读基础 GlobPermissionEnforcer，避免重复编译 picomatch 规则。
     * 每个 task 使用独立 overlay 保存 artifact 和用户授权等运行期规则。
     * 同时监听 ReadableDirectoryRegistry 变更，将后续注册的可读目录传播到所有基础 enforcer。
     *
     * @param mode 用于生成权限规则的 ModeDecl
     * @param defaultWorkspace 全局默认 workspace（当 task 未指定 workspace 时回退使用）
     * @param permissionPromptFactory 为每个 task 创建 PermissionPromptProvider 的工厂函数
     */
    async setupLazyHarnessInit(
        mode: ModeDecl,
        defaultWorkspace: string,
        permissionPromptFactory: () => PermissionPromptProvider
    ): Promise<void> {
        this._activeSharedHarnessBaseEnforcers.clear();
        this.pruneLazyHarnessBaseEnforcers();

        // 收集所有 unique workspace，为每个预热一个共享基础 GlobPermissionEnforcer
        const uniqueWorkspaces = new Set<string>();
        for (const task of this.tasks) {
            if (task.workspace) uniqueWorkspaces.add(task.workspace);
        }
        uniqueWorkspaces.add(defaultWorkspace);

        let currentMode = mode;
        const sharedBaseEnforcers = new Map<string, PermissionEnforcer>();
        this._updateLazyHarnessMode = (nextMode: ModeDecl) => {
            if (currentMode.id === nextMode.id) {
                currentMode = nextMode;
                return;
            }
            for (const enforcer of sharedBaseEnforcers.values()) {
                if (enforcer instanceof GlobPermissionEnforcer) {
                    this._activeSharedHarnessBaseEnforcers.delete(enforcer);
                }
            }
            currentMode = nextMode;
            sharedBaseEnforcers.clear();
            this.pruneLazyHarnessBaseEnforcers();
        };
        const readableRegistry = ReadableDirectoryRegistry.getInstance();
        const mainAgent = AgentRegistry.getMainAgent();
        const createSharedBaseEnforcer = (
            workspace: string,
            agentId: string,
            taskMode: ModeDecl
        ): PermissionEnforcer | undefined => {
            const cacheKey = `${agentId}\0${taskMode.id}\0${workspace}`;
            const existing = sharedBaseEnforcers.get(cacheKey);
            if (existing) return existing;
            try {
                const enforcer = createModePermissionEnforcer(workspace, taskMode, readableRegistry.getReadRules());
                sharedBaseEnforcers.set(cacheKey, enforcer);
                if (enforcer instanceof GlobPermissionEnforcer) {
                    this._sharedHarnessBaseEnforcers.add(enforcer);
                    this._activeSharedHarnessBaseEnforcers.add(enforcer);
                }
                return enforcer;
            } catch (err) {
                logger.warn(`Failed to create shared permission enforcer for workspace ${workspace}: ${err}`);
                return undefined;
            }
        };
        for (const workspace of uniqueWorkspaces) {
            createSharedBaseEnforcer(workspace, mainAgent.agentId, currentMode);
        }

        // 监听后续注册的可读目录，传播到当前 manager 创建过的所有共享基础 enforcer。
        // setupLazyHarnessInit() 重复调用时，旧任务仍继承旧基础 enforcer，因此监听器必须覆盖全部历史实例。
        if (!this._disposeReadableDirectoryListener) {
            this._disposeReadableDirectoryListener = readableRegistry.onRegister((dirPath: string) => {
                const rule: PermissionRule = {
                    resourceType: 'file',
                    action: 'read',
                    pathPattern: `${dirPath}{,/**}`,
                    effect: 'allow'
                };
                for (const enforcer of this._sharedHarnessBaseEnforcers) {
                    enforcer
                        .addRule(rule)
                        .catch((err) => logger.warn(`Failed to propagate readable rule to shared enforcer: ${err}`));
                }
            });
        }

        // 设置延迟初始化回调
        this.setHarnessInitializer((task) => {
            if (task.harnessContext.workspace) return;
            const savedExecutionHost = task.harnessContext.executionHost;
            const taskWorkspace = task.workspace || defaultWorkspace;
            const taskAgent = task.getAgent();
            const taskMode = taskAgent === mainAgent ? currentMode : task.getAgentMode();
            const sharedBaseEnforcer = createSharedBaseEnforcer(taskWorkspace, taskAgent.agentId, taskMode);
            if (!sharedBaseEnforcer) {
                task.harnessContext.workspace = taskWorkspace;
                return;
            }
            task.harnessContext = new HarnessContext();
            task.harnessContext.workspace = taskWorkspace;
            task.harnessContext.permission =
                sharedBaseEnforcer instanceof GlobPermissionEnforcer
                    ? sharedBaseEnforcer.createOverlay(
                          createTaskArtifactPermissionRules(getTaskArtifactDirectory(task.task_id, false))
                      )
                    : sharedBaseEnforcer;
            task.harnessContext.executionHost = savedExecutionHost;
            task.harnessContext.permissionPrompt = permissionPromptFactory();
            task.activeModeId = taskMode.id;
            task.allowedTools = taskMode.allowedTools;
            task.disabledTools = taskMode.disabledTools;
            this._lazyHarnessPromptModes.set(task, taskMode);
        });
    }

    /**
     * Load the task manager state from the file system.
     * 懒加载策略：仅读取 task_list.json 索引（1 次 I/O），用其中的简化元数据创建
     * 轻量 TaskState。chat_context 等重字段延迟到 getTask() -> ensureLoaded() 时加载。
     * 旧格式索引条目（仅有 task_id）回退到全量加载。
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
        let needsIndexUpgrade = false;
        const rejectedLegacyTaskIds = new Set<string>();
        let taskList: Record<string, unknown>[];
        try {
            taskList = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        } catch (err) {
            logger.error(`failed to parse task_list.json: ${err}, falling back to directory scan...`);
            return TaskManagerState.rebuildTaskListFromDirectory();
        }
        for (const entry of taskList) {
            const taskId = entry.task_id as string;
            if (!taskId) continue;
            const taskFilePath = path.join(taskDirectory, `${taskId}.json`);
            try {
                if (indexEntryHasMetadata(entry)) {
                    // 新格式索引：含简化元数据，创建懒加载 TaskState
                    taskManagerState.tasks.push(deserializeTaskFromIndex(entry, taskFilePath, taskManagerState));
                } else {
                    // 旧格式索引：仅有 task_id，回退到全量加载。
                    const task = TaskState.load(taskFilePath, taskManagerState);
                    if (task.task_id !== taskId) {
                        rejectedLegacyTaskIds.add(taskId);
                        needsIndexUpgrade = true;
                        throw new Error(
                            `task ID mismatch while loading ${taskFilePath}: expected ${taskId}, got ${task.task_id}`
                        );
                    }
                    taskManagerState.tasks.push(task);
                    needsIndexUpgrade = true;
                }
            } catch (err) {
                logger.warn(`error loading task ${taskId}: ${err}`);
                continue;
            }
        }
        if (taskManagerState.tasks.length > 0) {
            if (needsIndexUpgrade) {
                taskManagerState.saveTaskListSync({ excludedTaskIds: rejectedLegacyTaskIds });
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
        const taskListFile = path.join(taskDirectory, 'task_list.json');
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
                const expectedTaskId = path.basename(file, '.json');
                if (task.task_id !== expectedTaskId) {
                    throw new Error(
                        `task ID mismatch while recovering ${filePath}: expected ${expectedTaskId}, got ${task.task_id}`
                    );
                }
                taskManagerState.tasks.push(task);
                logger.info(`recovered task: ${task.task_id} (${task.task_name ?? 'unnamed'})`);
            } catch (err) {
                logger.warn(`skipping unrecoverable task file ${file}: ${err}`);
                continue;
            }
        }

        if (taskManagerState.tasks.length === 0) {
            atomicWriteFileSync(taskListFile, JSON.stringify([], null, 4));
            return null;
        }

        taskManagerState.tasks.sort((a, b) => {
            const aTime = (a.updated_at ?? a.started_at)?.getTime() ?? 0;
            const bTime = (b.updated_at ?? b.started_at)?.getTime() ?? 0;
            return aTime - bTime;
        });

        // 重建结果必须严格来自本次目录扫描，不能再把旧 task_list.json 中
        // 无法反序列化的条目通过多进程合并逻辑带回来。
        for (const task of taskManagerState.tasks) {
            task._dirty = false;
        }
        taskManagerState.saveTaskListSync({ mergeDiskEntries: false });
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
        // 调度时快照任务目录：2s 等待窗口内目录可能被切换（如测试环境的
        // setCustomOpendeskDirectory 重置），触发时再解析会把脏任务写进
        // 切换后的目录。生产环境目录恒定，该快照不改变行为。
        // 目录解析失败时保持旧有语义：不在调度路径上向 persistLater()
        // 调用方抛错，推迟到触发时由 _writeAll 解析并经 .catch 记录。
        let targetDirectory: string | undefined;
        try {
            targetDirectory = getTaskDirectory();
        } catch (err) {
            logger.warn(`failed to resolve task directory while scheduling save: ${err}`);
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = undefined;
            const hadPending = this._savePendingAfterTimer;
            this._savePendingAfterTimer = false;
            this._lastWritePromise = this._writeAll(targetDirectory)
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

    private async _writeAll(scheduledTaskDirectory?: string): Promise<void> {
        // 未传入调度时快照的目录（如 flushAllPendingSaves 直接落盘）时按当前目录解析
        const taskDirectory = scheduledTaskDirectory ?? getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // 只写入在本进程中被修改过的任务文件，防止多进程互相覆盖。
        // 跳过未完全加载的懒加载任务：其 chat_context 为空，写入会覆盖磁盘上的真实数据。
        // 先快照脏任务并立即清除 _dirty 标记：如果在异步写入期间 persistLater()
        // 被调用，_dirty 会被重新设为 true，不会被本方法的后续逻辑意外覆盖。
        const dirtyTasks = this.tasks.filter((t) => t._dirty && t._fullyLoaded);
        for (const task of dirtyTasks) {
            task._dirty = false;
        }
        // 防御性检查：懒加载任务不应被标记为脏。如果出现，说明有代码路径
        // 绕过了 ensureLoaded() 保护直接修改了懒加载任务的状态。
        for (const task of this.tasks.filter((t) => t._dirty && !t._fullyLoaded)) {
            logger.warn(
                `lazy task ${task.task_id} is dirty — this indicates a code path that ` +
                    `modifies a lazy task without calling ensureLoaded() first. ` +
                    `Clearing dirty flag to prevent flushAllPendingSaves dead loop.`
            );
            task._dirty = false;
        }

        const results = await Promise.allSettled(
            dirtyTasks.map((task) => {
                const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
                return atomicWriteFile(taskFile, JSON.stringify(task.toJSON(), null, 4));
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
        await atomicWriteFile(taskListFile, JSON.stringify(mergedList, null, 4));
    }

    /**
     * 构建合并后的任务列表：以内存任务为主，同时保留磁盘上由其他进程创建的任务条目。
     * 防止 CLI 和 GUI 同时运行时互相覆盖彼此的任务。
     */
    private _buildMergedTaskList(
        taskDirectory: string,
        taskListFile: string,
        excludedTaskIds: ReadonlySet<string> = new Set()
    ): object[] {
        const inMemoryIds = new Set(this.tasks.map((t) => t.task_id));
        const mergedList: object[] = this.tasks.map((t) => t.toIndexJSON());

        try {
            if (!fs.existsSync(taskListFile)) return mergedList;
            const diskEntries: Record<string, unknown>[] = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
            for (const entry of diskEntries) {
                const taskId = entry.task_id as string;
                if (inMemoryIds.has(taskId) || excludedTaskIds.has(taskId)) {
                    continue;
                }
                const taskFile = path.join(taskDirectory, `${taskId}.json`);
                if (fs.existsSync(taskFile)) {
                    mergedList.push(normalizeTaskIndexEntry(entry));
                }
            }
        } catch {
            // 读取/解析失败时仅使用内存中的任务列表
        }

        return mergedList;
    }

    /** Persist only task_list.json without treating any full task file as modified. */
    private saveTaskListSync(
        options: { mergeDiskEntries?: boolean; excludedTaskIds?: ReadonlySet<string> } = {}
    ): void {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');
        const mergedList =
            options.mergeDiskEntries === false
                ? this.tasks.map((task) => task.toIndexJSON())
                : this._buildMergedTaskList(taskDirectory, taskListFile, options.excludedTaskIds);
        atomicWriteFileSync(taskListFile, JSON.stringify(mergedList, null, 4));
    }

    /**
     * Synchronous write for operations that require immediate persistence
     * (e.g. rebuild, clear, remove — user may exit right after).
     */
    saveSync(options: { mergeDiskEntries?: boolean; excludedTaskIds?: ReadonlySet<string> } = {}): void {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // 只写入在本进程中被修改过的任务文件（跳过懒加载任务，防止空数据覆盖）
        const dirtyTasks = this.tasks.filter((t) => t._dirty && t._fullyLoaded);
        for (const task of dirtyTasks) {
            const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
            try {
                atomicWriteFileSync(taskFile, JSON.stringify(task.toJSON(), null, 4));
                task._dirty = false;
            } catch (err) {
                // 写入失败保持 _dirty = true 以便后续重试
                logger.error(`failed to persist task ${task.task_id} synchronously: ${err}`);
            }
        }
        // 防御性检查：懒加载任务不应被标记为脏。如果出现，说明有代码路径
        // 绕过了 ensureLoaded() 保护直接修改了懒加载任务的状态。
        for (const task of this.tasks.filter((t) => t._dirty && !t._fullyLoaded)) {
            logger.warn(
                `lazy task ${task.task_id} is dirty during saveSync — this indicates a code path that ` +
                    `modifies a lazy task without calling ensureLoaded() first. ` +
                    `Clearing dirty flag.`
            );
            task._dirty = false;
        }

        // 构建合并后的 task_list.json
        const mergedList =
            options.mergeDiskEntries === false
                ? this.tasks.map((task) => task.toIndexJSON())
                : this._buildMergedTaskList(taskDirectory, taskListFile, options.excludedTaskIds);
        atomicWriteFileSync(taskListFile, JSON.stringify(mergedList, null, 4));
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
        task.name_pending = true;
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
     *
     * 注意：此入口提交消息时不带 `interactive` 标记，因此不会挂载交互工具集
     * （askUser / exitPlanMode）。仅适用于后台/自动化场景（如定时任务）；
     * 需要阻塞式用户交互的任务应通过 GUI/TUI 的 submitUserMessage 入口发起。
     *
     * @param agent Agent 声明，或供 AIKernel 内部使用的规范 agentId
     * @param modeName 使用的 Mode 名称，undefined 则使用 Agent 的默认 Mode
     * @param prompt 要提交的用户消息
     * @returns 创建好的 TaskState（已提交消息，任务开始执行）
     */
    async dispatchPromptToAgent(
        agent: AgentDecl | string,
        modeName: string | undefined,
        prompt: string,
        options?: { workspace?: string; origin?: Participant }
    ): Promise<TaskState> {
        let agentDecl: AgentDecl;
        if (typeof agent === 'string') {
            const registered = AgentRegistry.resolveAgentReference(agent);
            if (!registered) {
                throw new Error(`Agent "${agent}" not found in AgentRegistry`);
            }
            agentDecl = registered;
        } else {
            agentDecl = agent;
        }

        // 解析 Mode
        const modes = agentDecl.supportedModes();
        const activeMode = modes.find((mode) => mode.id === modeName) ?? agentDecl.getDefaultMode();

        // 获取 workspace
        const workspace = options?.workspace || getPlatform().getEffectiveWorkspace();

        // 创建任务
        const task = this.createTask();
        task.agentId = agentDecl.agentId;

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
        await task.rebuildSystemPrompt();

        // 触发 beforeTaskStart 钩子（在 system prompt 已设置但用户消息尚未提交时）
        await task.hooks.noticeBeforeTaskStart({ task });

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
        const taskToRemove = this.tasks.find((task) => task.task_id === taskId);
        if (!taskToRemove) {
            logger.warn(`Task ${taskId} not found for deletion.`);
            return [];
        }

        const removedIds = new Set<string>();
        this._removeTaskRecursive(taskId, removedIds);

        if (removedIds.size > 0) {
            this.tasks = this.tasks.filter((t) => !removedIds.has(t.task_id));
            this.publishTaskListUpdate();
            // 即使某个任务文件删除失败，也不能在合并磁盘索引时把已明确删除的任务重新加回来。
            // 文件保留后仍可由手动恢复流程重新发现。
            this.saveSync({ excludedTaskIds: removedIds });
        }
        return Array.from(removedIds);
    }

    /**
     * Remove a corrupted task from task_list.json without touching its task JSON,
     * artifacts, todos, or child tasks. The preserved files can be recovered later
     * with /recover tasks after the underlying data issue is repaired.
     */
    removeCorruptedTaskEntry(taskId: string): boolean {
        const task = this.tasks.find((candidate) => candidate.task_id === taskId);
        if (!task || !task._corrupted) {
            return false;
        }

        this.tasks = this.tasks.filter((candidate) => candidate.task_id !== taskId);
        this.publishTaskListUpdate();
        // 损坏任务的 .json 文件仍保留在磁盘上（供 /recover 恢复），因此本次合并必须
        // 显式排除它；其他进程写入的有效任务条目仍应保留。
        this.saveSync({ excludedTaskIds: new Set([taskId]) });
        return true;
    }

    private _removeTaskRecursive(taskId: string, removedIds: Set<string>) {
        const task = this.tasks.find((candidate) => candidate.task_id === taskId);
        if (!task || removedIds.has(taskId)) return;

        task.ensureLoaded();
        if (!task._corrupted) {
            task.stop('system');
        }

        const children = this.tasks.filter((t) => t.parent_id === taskId);
        for (const child of children) {
            this._removeTaskRecursive(child.task_id, removedIds);
        }

        task.cleanup();
        deleteTaskTodos(taskId);
        removedIds.add(taskId);
    }

    /**
     * Remove all tasks from the task manager
     */
    clearAllTasks(): string[] {
        const removedIds = this.tasks.map((task) => task.task_id);
        for (const task of this.tasks) {
            // 懒加载任务并未实际运行（status 已转为 failed），跳过 stop()
            // 以避免不必要的 ensureLoaded() 触发全量磁盘读取。
            // cleanup() 和 deleteTaskTodos() 仍会正常清理磁盘文件。
            if (task._fullyLoaded) {
                task.stop('system');
            }
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
     * Find a task by its id.
     * 返回前会触发懒加载，确保调用方拿到的是含 chat_context 的完整 TaskState。
     * 同时触发 harness 延迟初始化（如果尚未设置 workspace）。
     * @returns the task, or undefined if the task is not found
     */
    getTaskLoadResult(taskId: string): { task: TaskState | undefined; corrupted: boolean } {
        const task = this.tasks.find((task) => task.task_id === taskId);
        if (task) {
            task.ensureLoaded();
            if (!task.harnessContext.workspace && this._harnessInitializer) {
                this._harnessInitializer(task);
            }
        }
        return { task, corrupted: task?._corrupted === true };
    }

    getTask(taskId: string): TaskState | undefined {
        const result = this.getTaskLoadResult(taskId);
        if (result.corrupted) {
            this.removeCorruptedTaskEntry(taskId);
            return undefined;
        }
        return result.task;
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
