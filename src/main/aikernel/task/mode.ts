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

import type { AgentDecl, ModeDecl } from '../agents/common.js';
import { AgentRegistry } from '../agents/registry.js';
import { HarnessContext } from '../security/harness.js';
import type { PermissionEnforcer, PermissionPromptProvider } from '../security/permission.js';
import type { TaskState } from '../states/tasks.js';
import { getTaskArtifactDirectory, Setting } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export interface SupportedModeSnapshot {
    modes: Array<Pick<ModeDecl, 'id' | 'name' | 'description' | 'icon' | 'color'>>;
    defaultModeId: string;
    currentModeId: string;
}

export type GlobalModeSelectionResult =
    | { status: 'ok'; modeId: string; changed: boolean }
    | { status: 'error'; message: string };

/**
 * Build the public mode snapshot shared by GUI hosts.
 * The current value is normalized to a supported mode so a stale host value
 * cannot be exposed as a selectable mode after the agent declaration changes.
 */
export function getSupportedModeSnapshot(
    agent: Pick<AgentDecl, 'supportedModes' | 'getDefaultMode'>,
    currentModeId?: string | null
): SupportedModeSnapshot {
    const modes = agent.supportedModes();
    const defaultModeId = agent.getDefaultMode().id;
    const currentMode = modes.find((mode) => mode.id === currentModeId);
    return {
        modes: modes.map(({ id, name, description, icon, color }) => ({ id, name, description, icon, color })),
        defaultModeId,
        currentModeId: currentMode?.id ?? defaultModeId
    };
}

/**
 * Validate and apply a host's process-local global mode selection.
 * Persistence is the host's current-mode state (it is intentionally not a
 * user setting); callers broadcast only after this result succeeds.
 */
export function selectGlobalMode(
    agent: Pick<AgentDecl, 'supportedModes'>,
    currentModeId: string | null | undefined,
    requestedModeId: unknown
): GlobalModeSelectionResult {
    if (typeof requestedModeId !== 'string') {
        return { status: 'error', message: `unknown mode: ${String(requestedModeId)}` };
    }
    const target = agent.supportedModes().find((mode) => mode.id === requestedModeId);
    if (!target) {
        return { status: 'error', message: `unknown mode: ${requestedModeId}` };
    }
    return { status: 'ok', modeId: target.id, changed: currentModeId !== target.id };
}

/**
 * 为任务选择运行 mode。主 Agent 跟随入口选择的 mode，其他 Agent 始终使用自身绑定的 mode。
 */
export function resolveTaskMode(task: TaskState, mainAgentMode: ModeDecl): ModeDecl {
    const taskAgent = task.getAgent();
    return taskAgent.agentId === AgentRegistry.getMainAgent().agentId ? mainAgentMode : task.getAgentMode();
}

/**
 * 将任务切换到指定模式（单任务模式切换）。
 * 收敛 onExitMode/onEnterMode 钩子与 replaceTaskHarnessForMode 的核心逻辑；
 * 通知 UI（renderer/session 广播）由各调用方负责。
 *
 * @returns 是否成功切换
 */
export async function switchTaskMode(
    task: TaskState,
    targetModeId: string,
    permissionPromptFactory: () => PermissionPromptProvider
): Promise<boolean> {
    const agent = task.getAgent();
    const modes = agent.supportedModes();
    const targetMode = modes.find((m) => m.id === targetModeId);
    if (!targetMode) return false;

    const ws = task.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
    const oldId = task.activeModeId || agent.getDefaultMode().id;
    if (oldId !== targetModeId) {
        const oldMode = modes.find((m) => m.id === oldId);
        await oldMode?.onExitMode?.(ws);
        await targetMode.onEnterMode?.(ws);
    }

    try {
        await replaceTaskHarnessForMode(task, ws, targetMode, permissionPromptFactory);
        return true;
    } catch (err) {
        logger.warn(`Failed to switch task ${task.task_id} to mode ${targetModeId}: ${err}`);
        return false;
    }
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
    // 模式切换后立即重新过滤工具集，使交互工具的 isAvailable 按新模式求值
    await task.refreshBaseToolsets();
    if (taskMode.interactive === false) {
        task.cancelInteractionPrompts();
    }

    // 模式切换会生成新的权限引擎：让 provider 用新规则重评当前弹窗与排队中的
    // ask 请求。重评由 provider 逐条实测，仅当新引擎将请求全部判为 allow 时才
    // 自动放通（如 solo 的 allow ** 与 unlimited 的无条件放行），未放通的请求
    // 保持等待，因此对所有模式切换都安全，不限于 bypass 模式。
    if (ctx.permission) {
        try {
            await permissionPrompt.notifyPermissionRulesChanged?.(ctx.permission, [task.task_id]);
        } catch (err) {
            logger.warn(`Failed to refresh permission prompts after switching task ${task.task_id}: ${err}`);
        }
    }
}

export interface TaskWorkspaceHost {
    currentModeId?: string | null;
    permissionPromptFactory: () => PermissionPromptProvider;
}

/**
 * Apply the complete GUI workspace operation shared by all hosts.
 * An existing task mode wins over the host's new-task default; custom agents
 * always retain their own mode. Hosts own task lookup, transport and delivery.
 */
export async function updateTaskWorkspace(
    task: TaskState,
    newWorkspace: string,
    host: TaskWorkspaceHost
): Promise<void> {
    const mainAgent = AgentRegistry.getMainAgent();
    const mainModeId = task.activeModeId || host.currentModeId;
    const mainMode =
        mainAgent.supportedModes().find((candidate) => candidate.id === mainModeId) ?? mainAgent.getDefaultMode();
    await replaceTaskHarnessForWorkspace(
        task,
        newWorkspace,
        (taskAgent) => (taskAgent.agentId === mainAgent.agentId ? mainMode : task.getAgentMode()),
        host.permissionPromptFactory
    );
    task.persistLater();
    // workspace 归属变化会改变任务列表的工作空间分组，广播列表更新让侧栏立即拿到新归属
    task.task_manager_state.publishTaskListUpdate();
    await task.refreshToolsets();
}

/**
 * 为任务切换工作空间：按当前模式重建权限引擎，并让 provider 用新规则重评
 * 已经在等待中的权限请求（例如旧工作空间外的路径在新工作空间下变为 allow）。
 * 与模式切换共用同一套重评语义，失败时保持原 harness 不变并向调用方抛出。
 *
 * @param resolveMode 由调用方决定该任务使用的模式（主 agent 通常跟随全局模式）
 */
export async function replaceTaskHarnessForWorkspace(
    task: TaskState,
    newWorkspace: string,
    resolveMode: (taskAgent: AgentDecl) => ModeDecl,
    permissionPromptFactory?: () => PermissionPromptProvider
): Promise<void> {
    const taskAgent = task.getAgent();
    const mode = resolveMode(taskAgent);
    // 工作空间变了，即使模式没变也要重跑 onEnterMode（如 plan 模式在新空间创建 .plan 目录）
    await mode.onEnterMode?.(newWorkspace);
    const savedEnv = task.harnessContext.environ;
    const savedExecutionHost = task.harnessContext.executionHost;
    // Resolve a lazy host provider into the new context only. A failed rebuild
    // must not mutate the provider attached to the still-active old harness.
    const permissionPrompt = task.harnessContext.permissionPrompt || permissionPromptFactory?.() || null;
    const ctx = await HarnessContext.createForMode(newWorkspace, mode);
    ctx.environ = savedEnv;
    ctx.executionHost = savedExecutionHost;
    ctx.permissionPrompt = permissionPrompt;
    await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
    const previousModeId = task.activeModeId;
    const previousAllowedTools = task.allowedTools;
    const previousDisabledTools = task.disabledTools;
    task.activeModeId = mode.id;
    task.allowedTools = mode.allowedTools;
    task.disabledTools = mode.disabledTools;
    let systemPrompt: string;
    try {
        systemPrompt = await task.buildSystemPrompt();
    } catch (err) {
        task.activeModeId = previousModeId;
        task.allowedTools = previousAllowedTools;
        task.disabledTools = previousDisabledTools;
        throw err;
    }
    task.harnessContext = ctx;
    task.workspace = newWorkspace;
    task.installBuiltSystemPrompt(systemPrompt);
    task.task_manager_state.clearLazyTaskSystemPromptRefresh(task);
    await task.refreshBaseToolsets();

    if (ctx.permission) {
        try {
            await permissionPrompt?.notifyPermissionRulesChanged?.(ctx.permission, [task.task_id]);
        } catch (err) {
            logger.warn(`Failed to refresh permission prompts after switching task ${task.task_id} workspace: ${err}`);
        }
    }
}
