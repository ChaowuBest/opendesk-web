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

import type { ModeDecl } from '../agents/common.js';
import { AgentRegistry } from '../agents/registry.js';
import { HarnessContext } from '../security/harness.js';
import type { PermissionEnforcer, PermissionPromptProvider } from '../security/permission.js';
import type { TaskState } from '../states/tasks.js';
import { getTaskArtifactDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

/**
 * 为任务选择运行 mode。主 Agent 跟随入口选择的 mode，其他 Agent 始终使用自身绑定的 mode。
 */
export function resolveTaskMode(task: TaskState, mainAgentMode: ModeDecl): ModeDecl {
    const taskAgent = task.getAgent();
    return taskAgent.agentId === AgentRegistry.getMainAgent().agentId ? mainAgentMode : task.getAgentMode();
}

/**
 * 替换单个任务的 mode harness，并让 bypass mode 接管已经等待中的权限请求。
 */
export async function replaceTaskHarnessForMode(
    task: TaskState,
    workspace: string,
    mode: ModeDecl,
    permissionPromptFactory: () => PermissionPromptProvider
): Promise<void> {
    const taskAgent = task.getAgent();
    const taskMode =
        taskAgent === AgentRegistry.getMainAgent()
            ? mode
            : taskAgent.supportedModes().find((candidate) => candidate.id === mode.id);
    if (!taskMode) {
        throw new Error(t('mode.unsupportedForAgent', { agentId: taskAgent.agentId, modeId: mode.id }));
    }

    const taskWorkspace = task.getWorkspace() || workspace;
    const savedEnv = task.harnessContext.environ;
    const savedExecutionHost = task.harnessContext.executionHost;
    const permissionPrompt = task.harnessContext.permissionPrompt || permissionPromptFactory();
    const ctx = await HarnessContext.createForMode(taskWorkspace, taskMode);
    ctx.environ = savedEnv;
    ctx.executionHost = savedExecutionHost;
    ctx.permissionPrompt = permissionPrompt;
    await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
    const currentPermission = task.harnessContext.permission;
    let nextFallbackPermission: PermissionEnforcer | null = null;
    if (currentPermission?.setFallbackEnforcer && ctx.permission) {
        nextFallbackPermission = ctx.permission;
        ctx.permission = currentPermission;
    }
    const previousModeId = task.activeModeId;
    const previousAllowedTools = task.allowedTools;
    const previousDisabledTools = task.disabledTools;
    task.activeModeId = taskMode.id;
    task.allowedTools = taskMode.allowedTools;
    task.disabledTools = taskMode.disabledTools;
    let systemPrompt: string;
    try {
        systemPrompt = await task.buildSystemPrompt();
    } catch (err) {
        task.activeModeId = previousModeId;
        task.allowedTools = previousAllowedTools;
        task.disabledTools = previousDisabledTools;
        throw err;
    }
    if (currentPermission?.setFallbackEnforcer && nextFallbackPermission) {
        currentPermission.setFallbackEnforcer(nextFallbackPermission);
    }
    task.harnessContext = ctx;
    task.installBuiltSystemPrompt(systemPrompt);
    task.task_manager_state.clearLazyTaskSystemPromptRefresh(task);

    if (taskMode.bypassPermissionChecks && ctx.permission) {
        try {
            await permissionPrompt.notifyPermissionRulesChanged?.(ctx.permission, [task.task_id]);
        } catch (err) {
            logger.warn(`Failed to refresh permission prompts after switching task ${task.task_id}: ${err}`);
        }
    }
}
