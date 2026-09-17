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
import {
    buildCardGenerationPrompt,
    extractHtmlFromAssistantText,
    getLastAssistantMessageText,
    normalizeCardData,
    summarizeCardPromptForTaskName
} from './cardGeneration.js';

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
