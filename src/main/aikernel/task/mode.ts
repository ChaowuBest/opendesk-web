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
import { HarnessContext } from '../security/harness.js';
import type { PermissionPromptProvider } from '../security/permission.js';
import type { TaskState } from '../states/tasks.js';
import { getTaskArtifactDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';

/**
 * 替换单个任务的 mode harness，并让 bypass mode 接管已经等待中的权限请求。
 */
export async function replaceTaskHarnessForMode(
    task: TaskState,
    workspace: string,
    mode: ModeDecl,
    permissionPromptFactory: () => PermissionPromptProvider,
    createSystemPrompt?: () => Promise<string>
): Promise<void> {
    const taskWorkspace = task.getWorkspace() || workspace;
    const savedEnv = task.harnessContext.environ;
    const savedExecutionHost = task.harnessContext.executionHost;
    const permissionPrompt = task.harnessContext.permissionPrompt || permissionPromptFactory();
    const systemPrompt = await createSystemPrompt?.();
    const ctx = await HarnessContext.createForMode(taskWorkspace, mode);
    ctx.environ = savedEnv;
    ctx.executionHost = savedExecutionHost;
    ctx.permissionPrompt = permissionPrompt;
    await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
    task.harnessContext = ctx;
    task.activeModeId = mode.id;
    task.allowedTools = mode.allowedTools;
    task.disabledTools = mode.disabledTools;
    if (systemPrompt !== undefined) {
        task.setSystemPrompt(systemPrompt);
        task.task_manager_state.clearLazyTaskSystemPromptRefresh(task);
    }

    if (mode.bypassPermissionChecks && ctx.permission) {
        try {
            await permissionPrompt.notifyPermissionRulesChanged?.(ctx.permission, [task.task_id]);
        } catch (err) {
            logger.warn(`Failed to refresh permission prompts after switching task ${task.task_id}: ${err}`);
        }
    }
}
