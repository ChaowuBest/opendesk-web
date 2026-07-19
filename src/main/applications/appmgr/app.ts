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

import { BaseApplication } from '../base.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { Skill } from '../../aikernel/skill.js';
import type { EventDecl } from '../base.js';
import {
    AppManagerStore,
    appEntryUrl,
    readAppManifestFromZipFile,
    toPublicUserApp,
    type UserAppRecord
} from './manager.js';
import { MANAGE_APPS_SKILL } from './skills.js';
import { APPMGR_APPGUIDE_SKILL } from './skills/appguide.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { MainAgentDecl } from '../../aikernel/agents/main/agent.js';
import { getPlatform } from '../../../platforms/base.js';
import { logger } from '../../utils/logger.js';

/** 复用已有任务的最大时间窗口（毫秒） */
const RECENT_TASK_WINDOW_MS = 15 * 60 * 1000;

const APPMGR_ICON_URL = './applications/appmgr/icon.png';

export class AppMgrApplication extends BaseApplication {
    static bundleName: string = 'appmgr';

    constructor() {
        super('appmgr', '应用工坊');
    }

    isExperimental(): boolean {
        return true;
    }

    toJSON(): Record<string, unknown> {
        return {
            ...super.toJSON(),
            iconUrl: APPMGR_ICON_URL,
            source: 'system',
            removable: false,
            active: true
        };
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [{ eventName: 'appUpdated', eventDescription: '应用修改任务完成后触发，通知渲染进程刷新预览' }];
    }

    async getSkills(): Promise<Skill[]> {
        const skill = Skill.parseMd(MANAGE_APPS_SKILL);
        const appguide = Skill.parseMd(APPMGR_APPGUIDE_SKILL);
        return [skill, appguide];
    }

    async getToolsets(): Promise<BaseToolset[]> {
        return [];
    }

    installFromZip(zipPath: string) {
        const manifest = readAppManifestFromZipFile(zipPath);
        this.assertNotSystemBundle(manifest.bundleName);
        const result = AppManagerStore.installFromZip(zipPath);
        this.refreshExternalApplications();
        return {
            app: toPublicUserApp(result.app),
            version: result.version
        };
    }

    createApp(input: { bundleName: string; displayName: string; description?: string }) {
        this.assertNotSystemBundle(input.bundleName);
        const result = AppManagerStore.createApp(input);
        this.refreshExternalApplications();
        return {
            app: toPublicUserApp(result.app),
            version: result.version
        };
    }

    listUserApps() {
        return AppManagerStore.listApps().map((app) => toPublicUserApp(app));
    }

    listBuiltinApps() {
        const apps = Array.from(this.registry?.applications?.values?.() ?? []) as BaseApplication[];
        return apps
            .filter((app) => !AppManagerStore.getApp(app.bundleName))
            .map((app) => ({
                ...app.toJSON(),
                iconUrl: (app.toJSON() as any).iconUrl || `./applications/${app.bundleName}/icon.png`,
                source: 'system',
                removable: false,
                active: true
            }));
    }

    async listAllApps() {
        return {
            userApps: this.listUserApps(),
            builtinApps: this.listBuiltinApps()
        };
    }

    getAppInfo(bundleName: string) {
        const userApp = AppManagerStore.getApp(bundleName);
        if (userApp) {
            return toPublicUserApp(userApp);
        }
        const builtinApp = this.registry?.getApplication?.(bundleName) as BaseApplication | undefined;
        if (!builtinApp) {
            throw new Error(`application ${bundleName} not found`);
        }
        return {
            ...builtinApp.toJSON(),
            iconUrl: (builtinApp.toJSON() as any).iconUrl || `./applications/${builtinApp.bundleName}/icon.png`,
            source: 'system',
            removable: false,
            active: true
        };
    }

    setActive(bundleName: string, active: boolean) {
        const app = AppManagerStore.setActive(bundleName, active);
        this.refreshExternalApplications();
        return toPublicUserApp(app);
    }

    setCurrentVersion(bundleName: string, versionId: string) {
        const app = AppManagerStore.setCurrentVersion(bundleName, versionId);
        this.refreshExternalApplications();
        return toPublicUserApp(app);
    }

    updateMetadata(input: {
        bundleName: string;
        displayName?: string;
        description?: string;
        iconSourcePath?: string;
        iconDataUrl?: string;
    }) {
        const app = AppManagerStore.updateMetadata(input);
        this.refreshExternalApplications();
        return toPublicUserApp(app);
    }

    deleteApp(bundleName: string) {
        const result = AppManagerStore.deleteApp(bundleName);
        this.refreshExternalApplications();
        return result;
    }

    getPreviewUrl(bundleName: string, versionId?: string) {
        const app = AppManagerStore.getAppOrThrow(bundleName);
        return appEntryUrl(app, versionId ?? app.currentVersionId);
    }

    /**
     * 通过 AI Agent 修改应用。
     * 创建新版本（以当前版本为父版本），然后创建或复用 Agent 任务来执行修改。
     * @returns { taskId, versionId }
     */
    async requestModifyApp(
        bundleName: string,
        requirements: string,
        options: { displayName?: string; description?: string } = {}
    ): Promise<{ taskId: string; versionId: string }> {
        const app = AppManagerStore.getAppOrThrow(bundleName);

        // 1. 创建新版本（当前版本作为父版本）
        const versionName = options.displayName || requirements.slice(0, 50).replace(/\n/g, ' ');
        const result = AppManagerStore.createNewVersion(bundleName, {
            versionName: `AI 修改: ${versionName}`,
            displayName: options.displayName,
            description: options.description
        });

        const { version } = result;
        const versionCodePath = version.codePath;
        const versionDisplayName = result.app.displayName;

        // 2. 刷新外部应用列表
        this.refreshExternalApplications();

        // 3. 查找最近 15 分钟内是否已有相关任务
        const tm = GlobalState.getInstance().taskManagerState;
        const existingTask = this._findRecentModifyTask(tm, bundleName);

        let task: ReturnType<typeof tm.createTask>;

        if (existingTask) {
            // 复用已有任务
            task = existingTask;
            logger.info(`[appmgr] reusing existing task ${task.task_id} for ${bundleName}`);
            await task.submitUserMessage(
                this._buildModifyPrompt(bundleName, versionDisplayName, versionCodePath, requirements, false)
            );
        } else {
            // 创建新 Agent 任务
            const agent = new MainAgentDecl();
            const mode = agent.supportedModes().find((m) => m.id === 'solo') ?? agent.supportedModes()[0];
            const workspace = getPlatform().getEffectiveWorkspace();

            task = tm.createTask();
            task.task_name = `[修改应用] ${versionDisplayName}`;

            try {
                await tm.initHarness(task, workspace, mode);
                task.setSystemPrompt(await agent.createSystemPrompt(mode, task));
                await task.hooks.noticeBeforeTaskStart(task);
                await task.submitUserMessage(
                    this._buildModifyPrompt(bundleName, versionDisplayName, versionCodePath, requirements, true)
                );
            } catch (err) {
                // 初始化失败时清理
                try {
                    tm.removeTask(task.task_id);
                } catch {
                    /* ignore */
                }
                throw err;
            }
        }

        // 4. 后台等待任务完成后重载应用
        this._handleTaskCompletion(task.task_id, bundleName, version.versionId).catch((err) => {
            logger.error(`[appmgr] task completion handler failed: ${err}`);
        });

        return { taskId: task.task_id, versionId: version.versionId };
    }

    /**
     * 查找最近 15 分钟内创建的、与指定应用相关的修改任务。
     */
    private _findRecentModifyTask(
        tm: ReturnType<typeof GlobalState.getInstance>['taskManagerState'],
        bundleName: string
    ): ReturnType<typeof tm.createTask> | undefined {
        const cutoff = Date.now() - RECENT_TASK_WINDOW_MS;
        // 通过 getTaskList 获取所有任务
        const taskList = tm.getTaskList() as Array<{
            task_id: string;
            task_name: string | null;
            started_at?: string | null;
        }>;
        for (const t of taskList) {
            if (t.task_name?.startsWith('[修改应用]') && t.started_at && new Date(t.started_at).getTime() > cutoff) {
                const task = tm.getTask(t.task_id);
                if (task && task.task_status === 'running') {
                    return task;
                }
            }
        }
        return undefined;
    }

    /**
     * 构建发送给 Agent 的修改提示词。
     */
    private _buildModifyPrompt(
        bundleName: string,
        displayName: string,
        codePath: string,
        requirements: string,
        isFirstMessage: boolean
    ): string {
        const header = isFirstMessage
            ? `你需要修改一个 OpenDesk 应用「${displayName}」（包名: ${bundleName}）。

**应用代码路径**: ${codePath}
**入口文件**: ${codePath}/opendesk-app.json 中指定的 entry 文件

请你参考 /appmgr-appguide 的指南来对应用进行修改。

请先阅读应用代码，理解其结构和功能，然后根据以下需求进行修改：`
            : `继续修改应用「${displayName}」（包名: ${bundleName}），代码路径: ${codePath}。

新的需求如下：`;

        const footer = `

修改要求：
- 仅修改应用代码目录中的文件，不要修改其他文件
- 保持代码风格一致
- 修改完成后，请确保应用能正常运行
- 如果引入新的依赖，请确保在代码中正确处理`;

        return `${header}

${requirements}
${footer}`;
    }

    /**
     * 后台处理任务完成后的应用重载。
     * 做好充分的容错，避免有 bug 的新版本导致 OpenDesk 崩溃。
     */
    private async _handleTaskCompletion(taskId: string, bundleName: string, versionId: string): Promise<void> {
        const tm = GlobalState.getInstance().taskManagerState;

        try {
            const task = tm.getTask(taskId);
            if (!task) return;

            await task.waitUntilFinished();

            // 任务完成后切换应用到新版本
            if (task.task_status === 'stopped') {
                logger.warn(`[appmgr] task ${taskId} was stopped, not switching version`);
                return;
            }

            // 确保版本存在且已设置为当前版本
            const app = AppManagerStore.getApp(bundleName);
            if (app && app.currentVersionId === versionId) {
                // 版本已自动更新（createNewVersion 已设置），只需刷新外部应用
                this.refreshExternalApplications();
                logger.info(`[appmgr] app ${bundleName} updated to version ${versionId}`);
            } else if (app) {
                // 兜底：手动切换版本
                try {
                    this.setCurrentVersion(bundleName, versionId);
                } catch (err) {
                    logger.error(`[appmgr] failed to switch version: ${err}`);
                }
            }

            // 通知渲染进程刷新预览
            try {
                await this.emitEvent('appUpdated', bundleName, versionId);
            } catch (err) {
                logger.warn(`[appmgr] failed to emit appUpdated event: ${err}`);
            }
        } catch (err) {
            logger.error(`[appmgr] task completion error for ${bundleName}: ${err}`);
            // 容错：即使出错也不影响 OpenDesk 主流程
            try {
                // 如果新版本有问题，回退到父版本
                const app = AppManagerStore.getApp(bundleName);
                const currentVersion = app?.versions.find((v) => v.versionId === versionId);
                if (currentVersion?.parentVersionId) {
                    logger.warn(
                        `[appmgr] rolling back ${bundleName} to parent version ${currentVersion.parentVersionId}`
                    );
                    this.setCurrentVersion(bundleName, currentVersion.parentVersionId);
                }
            } catch (rollbackErr) {
                logger.error(`[appmgr] rollback failed: ${rollbackErr}`);
            }
        }
    }

    private refreshExternalApplications(): void {
        this.registry?.reloadExternalApplications?.();
        this.registry?.notifyApplicationListChanged?.();
    }

    private assertNotSystemBundle(bundleName: string): void {
        const existing = this.registry?.getApplication?.(bundleName) as BaseApplication | undefined;
        if (existing && !AppManagerStore.getApp(bundleName)) {
            throw new Error(`bundleName ${bundleName} conflicts with a system application`);
        }
    }
}

export type { UserAppRecord };
