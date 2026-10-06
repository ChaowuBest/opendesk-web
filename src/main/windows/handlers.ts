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

import * as fsPromises from 'node:fs/promises';
import path from 'node:path';

import { ipcMain } from 'electron';

import { GlobalState } from '../aikernel/states/global.js';
import { LLM } from '../aikernel/llm.js';
import { AgentRegistry } from '../aikernel/agents/registry.js';
import { HarnessContext } from '../aikernel/security/harness.js';
import { ElectronPermissionPromptProvider } from '../aikernel/security/electronPrompt.js';
import { getPlatform } from '../../platforms/base.js';
import { getOpendeskDirectory, getTaskArtifactDirectory, Setting } from '../utils/setting.js';
import { getLocale, t } from '../../locale/index.js';
import { logger } from '../utils/logger.js';
import { TRASH_RETENTION_MS, prepareTrashPreviewCopy, restoreTrashEntry, searchTrashEntries } from '../utils/trash.js';
import {
    buildCardGenerationPrompt,
    extractHtmlFromAssistantText,
    getLastAssistantMessageText,
    normalizeCardData,
    summarizeCardPromptForTaskName
} from '../utils/cardGeneration.js';

function getCardGenerationTaskName(prompt: string, isRefresh: boolean): string {
    return t(isRefresh ? 'main.desktop.card.refreshTaskName' : 'main.desktop.card.createTaskName', {
        prompt: summarizeCardPromptForTaskName(prompt)
    });
}

/** 单张卡片生成的总时限：任务内部对模型错误有自动重试，必须有上限避免界面无限悬挂 */
const CARD_GENERATION_TIMEOUT_MS = 3 * 60_000;

/**
 * 注册沉浸桌面相关 IPC：卡片持久化（desktop/loadCards、desktop/saveCards）
 * 与卡片内容生成（desktop/generateCardContent，内部创建 internal 任务交给 agent 生成 HTML）。
 */
export function registerDesktopAPIHandlers(): void {
    const desktopDirectory = path.join(getOpendeskDirectory(), 'desktop');
    const cardsFile = path.join(desktopDirectory, 'cards.json');

    const ensureDesktopDirectory = async (): Promise<void> => {
        await fsPromises.mkdir(desktopDirectory, { recursive: true });
    };

    ipcMain.handle('desktop:loadCards', async () => {
        try {
            await ensureDesktopDirectory();
            const raw = await fsPromises.readFile(cardsFile, 'utf8');
            return { status: 'ok', data: normalizeCardData(JSON.parse(raw)) };
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                logger.warn(`[desktop] failed to load cards: ${error?.message || String(error)}`);
            }
            return { status: 'ok', data: [] };
        }
    });

    ipcMain.handle('desktop:saveCards', async (_event, cards: unknown) => {
        try {
            await ensureDesktopDirectory();
            const tempFile = `${cardsFile}.tmp`;
            await fsPromises.writeFile(tempFile, JSON.stringify(normalizeCardData(cards), null, 2), 'utf8');
            await fsPromises.rename(tempFile, cardsFile);
            return { status: 'ok' };
        } catch (error: any) {
            logger.warn(`[desktop] failed to save cards: ${error?.message || String(error)}`);
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('desktop:generateCardContent', async (_event, input: unknown) => {
        if (!input || typeof input !== 'object') {
            return { status: 'error', message: t('main.desktop.card.invalidInput') };
        }
        const data = input as Record<string, unknown>;
        const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
        if (!prompt) {
            return { status: 'error', message: t('main.desktop.card.promptRequired') };
        }

        const width = typeof data.width === 'number' && Number.isFinite(data.width) ? data.width : 420;
        const height = typeof data.height === 'number' && Number.isFinite(data.height) ? data.height : 320;
        const currentHtml = typeof data.currentHtml === 'string' ? data.currentHtml : undefined;
        const locale = typeof data.locale === 'string' ? data.locale : undefined;
        const theme = data.theme === 'dark' ? 'dark' : 'light';
        const taskManager = GlobalState.getInstance().taskManagerState;
        const isRefresh = !!currentHtml?.trim();
        const task = taskManager.createTask(undefined, {
            internal: true,
            taskName: getCardGenerationTaskName(prompt, isRefresh)
        });
        task.reasoningEffort = LLM.getMinimalReasoningEffort(task.ensureValidModelOrFallback());

        try {
            const workspace = Setting.getInstance().getEffectiveWorkspace();
            const agentDecl = AgentRegistry.getMainAgent();
            const modes = agentDecl.supportedModes();
            const activeMode = modes.find((mode) => mode.id === 'solo') ?? modes[0];
            task.harnessContext = await HarnessContext.createForMode(workspace, activeMode);
            task.harnessContext.permissionPrompt = new ElectronPermissionPromptProvider();
            task.workspace = workspace;
            task.activeModeId = activeMode.id;
            task.allowedTools = activeMode.allowedTools;
            task.disabledTools = activeMode.disabledTools;
            await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
            task.interactionToolset = getPlatform().createInteractionToolset(task);
            await task.rebuildSystemPrompt();
            // 生成全程限时：任务内部对模型错误有自动重试，若不设上限，
            // 渲染层的"正在生成"会无限悬挂，错误对用户完全不可见
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error(t('main.desktop.card.timeout')));
                }, CARD_GENERATION_TIMEOUT_MS);
                (async () => {
                    await task.submitUserMessage(
                        buildCardGenerationPrompt({
                            prompt,
                            currentHtml,
                            width,
                            height,
                            locale: locale || getLocale(),
                            theme
                        })
                    );
                    await task.waitUntilFinished(undefined, true);
                })().then(
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    (err) => {
                        clearTimeout(timer);
                        reject(err);
                    }
                );
            });

            const html = extractHtmlFromAssistantText(getLastAssistantMessageText(task));
            if (!html || !/<[a-z][\s\S]*>/i.test(html)) {
                return { status: 'error', message: t('main.desktop.card.noHtml'), taskId: task.task_id };
            }
            return { status: 'ok', data: { html, taskId: task.task_id } };
        } catch (error: any) {
            if (task.task_status !== 'stopped') {
                try {
                    task.stop('system');
                } catch (stopError: any) {
                    logger.warn(
                        `[desktop] failed to stop card generation task: ${stopError?.message || String(stopError)}`
                    );
                }
            }
            logger.warn(`[desktop] card generation failed: ${error?.message || String(error)}`);
            return { status: 'error', message: error?.message || String(error), taskId: task.task_id };
        }
    });
}

// ── 文件回收站 IPC：统一回收站（<opendeskDir>/trash/）的搜索、找回、
// "打开"（原始文件名预览副本 + 系统默认应用）与任务上下文。供 GUI 文件回收站
// 弹窗调用（trashAPI），数据格式见 main/utils/trash.ts。

interface TrashSearchIpcOptions {
    scope?: 'task' | 'global';
    taskId?: string;
    keyword?: string;
    offset?: number;
    limit?: number;
}

/** 注册文件回收站相关 IPC handler（trash:search / trash:restore / trash:openEntry / trash:getTaskContext）。 */
export function registerTrashAPIHandlers(): void {
    ipcMain.handle('trash:search', async (_event, options: TrashSearchIpcOptions) => {
        try {
            const scope = options?.scope === 'task' ? 'task' : 'global';
            const keyword = typeof options?.keyword === 'string' ? options.keyword : '';
            // 全局范围且无关键字时只列出"最近一个星期"有交互的任务
            // （任务最后一次用户交互 = updated_at，超期回收站在启动时已被清理）
            let recentTaskIds: string[] | undefined;
            if (scope === 'global' && !keyword) {
                const since = Date.now() - TRASH_RETENTION_MS;
                recentTaskIds = GlobalState.getInstance()
                    .taskManagerState.getTaskList()
                    .filter((task) => {
                        const time = Date.parse(task.updated_at ?? '');
                        return Number.isFinite(time) && time >= since;
                    })
                    .map((task) => task.task_id);
            }
            const result = searchTrashEntries({
                scope,
                taskId: typeof options?.taskId === 'string' ? options.taskId : undefined,
                keyword: keyword || undefined,
                recentTaskIds,
                offset: typeof options?.offset === 'number' ? options.offset : undefined,
                limit: typeof options?.limit === 'number' ? options.limit : undefined
            });
            return { status: 'ok', data: result };
        } catch (error: any) {
            logger.error('searching trash failed', error);
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle(
        'trash:restore',
        async (_event, payload: { taskId?: string; uuid?: string; overwrite?: boolean }) => {
            try {
                const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
                const uuid = typeof payload?.uuid === 'string' ? payload.uuid : '';
                if (!taskId || !uuid) {
                    return { status: 'error', message: 'taskId and uuid are required' };
                }
                const result = restoreTrashEntry({
                    taskId,
                    uuid,
                    overwrite: payload?.overwrite === true
                });
                return { status: 'ok', data: result };
            } catch (error: any) {
                logger.error('restoring trash entry failed', error);
                return { status: 'error', message: error?.message || String(error) };
            }
        }
    );

    // 浮窗任务信息区：任务名称 + 最后一条用户消息（getFullTask 太重，这里走懒加载）
    ipcMain.handle('trash:getTaskContext', async (_event, taskId: string) => {
        try {
            if (typeof taskId !== 'string' || !taskId) {
                return { status: 'error', message: 'taskId is required' };
            }
            const { task } = GlobalState.getInstance().taskManagerState.getTaskLoadResult(taskId);
            if (!task) {
                return { status: 'ok', data: null };
            }
            const lastUserMessage = task.chat_context.lastUserMessage();
            return {
                status: 'ok',
                data: {
                    task_id: task.task_id,
                    task_name: task.task_name,
                    last_user_message: lastUserMessage ? lastUserMessage.getPlainText() : ''
                }
            };
        } catch (error: any) {
            logger.error('loading trash task context failed', error);
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    // "打开"：以原始文件名生成回收站内容的临时副本（.back 的扩展名无应用关联，
    // 按原名命名后系统默认应用才能选中正确的程序），再经平台能力用系统默认
    // 方式打开——与 taskview 文件卡片的 openPath 同一实现
    ipcMain.handle('trash:openEntry', async (_event, payload: { taskId?: string; uuid?: string }) => {
        try {
            const result = prepareTrashPreviewCopy({
                taskId: typeof payload?.taskId === 'string' ? payload.taskId : '',
                uuid: typeof payload?.uuid === 'string' ? payload.uuid : ''
            });
            if (!result.path) {
                return { status: 'error', message: result.message ?? 'preview copy failed' };
            }
            await getPlatform().openPath(result.path);
            return { status: 'ok', data: { path: result.path } };
        } catch (error: any) {
            logger.error('opening trash entry failed', error);
            return { status: 'error', message: error?.message || String(error) };
        }
    });
}
