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

import type { TaskState } from '../../aikernel/states/tasks.js';
import type { TaskManagerState } from '../../aikernel/task/manager.js';
import type { PermissionPromptProvider } from '../../aikernel/security/permission.js';
import type { InteractiveToolset } from '../../aikernel/tool.js';
import { HarnessContext } from '../../aikernel/security/harness.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
import { UnsupportedAttachmentFileTypeError } from '../../aikernel/attachment-support.js';
import { ApplicationRegistry } from '../registry.js';
import { getExecutionNode } from '../devicemgr/execution.js';
import { applyTaskExecutionNode, normalizeExecutionNodeId } from '../devicemgr/task-execution.js';
import { Setting, getTaskArtifactDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export interface GuiCreateTaskOptions {
    modeId?: string;
    selectedExecutionNodeId?: string | null;
    internal?: boolean;
    taskName?: string;
}

export interface GuiTaskHost {
    currentModeId?: string | null;
    defaultExecutionNodeId?: string | null;
    permissionPromptFactory(): PermissionPromptProvider;
    createInteractionToolset(task: TaskState): InteractiveToolset | null;
}

export interface GuiTaskMessage {
    message: string;
    attachedFilePaths?: string[];
    attachedImages?: string[];
    selectedModel?: string;
    reasoningEffort?: TaskState['reasoningEffort'];
    selectedExecutionNodeId?: string | null;
}

export type GuiTaskError = { status: 'error'; message: string };

export function normalizeGuiCreateTaskOptions(raw: unknown): GuiCreateTaskOptions {
    if (raw && typeof raw === 'object') {
        const value = raw as Record<string, unknown>;
        return {
            modeId: typeof value.modeId === 'string' ? value.modeId : undefined,
            selectedExecutionNodeId:
                typeof value.selectedExecutionNodeId === 'string'
                    ? value.selectedExecutionNodeId
                    : value.selectedExecutionNodeId === null
                      ? null
                      : undefined,
            internal: value.internal === true,
            taskName: typeof value.taskName === 'string' ? value.taskName : undefined
        };
    }
    return { modeId: typeof raw === 'string' ? raw : undefined };
}

/** GUI task creation owns business ordering; the host supplies interaction implementations only. */
export async function createGuiTask(
    manager: Pick<TaskManagerState, 'createTask' | 'publishTaskListUpdate'>,
    rawOptions: unknown,
    host: GuiTaskHost
): Promise<{ status: 'ok'; data: string } | GuiTaskError> {
    const options = normalizeGuiCreateTaskOptions(rawOptions);
    // Preserve the existing GUI policy: an empty selection uses the process default.
    const initialNodeId =
        normalizeExecutionNodeId(options.selectedExecutionNodeId) || host.defaultExecutionNodeId || '';
    if (initialNodeId && !getExecutionNode(initialNodeId)) {
        return { status: 'error', message: `node ${initialNodeId} not connected` };
    }
    // Agent declarations must be ready before the task captures its system prompt.
    await ApplicationRegistry.ensureFullyLoaded();
    const task = manager.createTask(undefined, { internal: options.internal, taskName: options.taskName });
    const workspace = Setting.getInstance().getEffectiveWorkspace();
    const agent = AgentRegistry.getMainAgent();
    const modeId = options.modeId || host.currentModeId;
    const mode = agent.supportedModes().find((candidate) => candidate.id === modeId) ?? agent.getDefaultMode();
    try {
        task.harnessContext = await HarnessContext.createForMode(workspace, mode);
        task.harnessContext.permissionPrompt = host.permissionPromptFactory();
        task.workspace = workspace;
        task.activeModeId = mode.id;
        task.allowedTools = mode.allowedTools;
        task.disabledTools = mode.disabledTools;
        await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
        task.interactionToolset = host.createInteractionToolset(task);
        if (initialNodeId) {
            const result = await applyTaskExecutionNode(task, initialNodeId);
            if (result.status !== 'ok') return result;
        }
        await task.rebuildSystemPrompt();
    } catch (error) {
        // Keep the established GUI fallback, including its task-list publication.
        logger.warn(`Failed to initialize GUI task harness, using empty context: ${error}`);
        task.harnessContext = HarnessContext.createEmpty();
        task.harnessContext.workspace = workspace;
        task.workspace = workspace;
    }
    manager.publishTaskListUpdate();
    return { status: 'ok', data: task.task_id };
}

/** Apply a complete GUI submission before entering the task's interactive turn. */
export async function submitGuiTaskMessage(
    manager: Pick<TaskManagerState, 'getTask' | 'refreshLazyTaskSystemPrompt'>,
    taskId: string,
    details: GuiTaskMessage
): Promise<{ status: 'ok' } | GuiTaskError> {
    const task = manager.getTask(taskId);
    if (!task) return { status: 'error', message: `task ${taskId} not found` };
    await manager.refreshLazyTaskSystemPrompt(task);
    if (details.attachedFilePaths) {
        try {
            await task.attachFiles(details.attachedFilePaths);
        } catch (error) {
            if (!(error instanceof UnsupportedAttachmentFileTypeError)) throw error;
            const extensions = [
                ...new Set(
                    error.unsupportedFiles.map((file) =>
                        file.extension ? `.${file.extension}` : t('renderer.agentInput.unsupportedFile.noExtension')
                    )
                )
            ].join(', ');
            return {
                status: 'error',
                message: t('renderer.agentInput.unsupportedFile.message', {
                    extensions,
                    supportedExtensions: error.supportedExtensions.map((extension) => `.${extension}`).join(', ')
                })
            };
        }
    }
    if (details.selectedModel) {
        task.model = details.selectedModel;
        task.ensureValidModelOrFallback();
    }
    if (details.reasoningEffort !== undefined) task.reasoningEffort = details.reasoningEffort;
    if (Object.prototype.hasOwnProperty.call(details, 'selectedExecutionNodeId')) {
        const result = await applyTaskExecutionNode(task, details.selectedExecutionNodeId ?? null);
        if (result.status !== 'ok') return result;
    }
    const imageDataUris =
        Array.isArray(details.attachedImages) && details.attachedImages.length > 0 ? details.attachedImages : undefined;
    await task.submitUserMessage(details.message, { imageDataUris, interactive: true });
    return { status: 'ok' };
}
