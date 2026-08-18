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

import { logger } from '../../utils/logger.js';
import { BaseTool } from '../tool.js';
import { AssistantMessage, ToolCall } from '../messages.js';
import type {
    PermissionEnforcer,
    PermissionRequest,
    PermissionCheckResult,
    PermissionPromptProvider,
    PermissionPromptContext,
    PermissionRule,
    PermissionUserResponse
} from '../security/permission.js';
import { createResourcePath } from '../security/permission.js';
import type { TaskState } from '../states/tasks.js';

export async function handleToolPermissionsForTask(
    task: TaskState,
    tool: BaseTool<any>,
    args: Record<string, unknown>,
    tool_call: ToolCall
): Promise<boolean> {
    const enforcer = task.harnessContext.permission;
    if (!enforcer) {
        return false;
    }

    const contextualResults = enforcer.checkToolCall
        ? await enforcer.checkToolCall({
              toolName: tool.name,
              args,
              workspace: task.getWorkspace()
          })
        : [];
    const declaredPermissions = tool.getDeclaredPermissions(args, task) || [];
    const declaredResults = declaredPermissions.length > 0 ? await enforcer.checkAllDetailed(declaredPermissions) : [];
    const allResults = [...contextualResults, ...declaredResults];
    if (allResults.length === 0) {
        return false;
    }

    // deny 优先：只要有一个 deny 就拒绝整个工具调用
    const denied = allResults.find((r) => r.effect === 'deny');
    if (denied) {
        tool_call.status = 'error';
        tool_call.result = `权限被拒绝: ${denied.reason || denied.request.action + ' ' + denied.request.resourcePath}`;
        tool_call.result_object = { permission_denied: true };
        return true;
    }

    // 剩下全是 ask，按 (resourceType, action) 分组合并
    const askResults = allResults.filter((r) => r.effect === 'ask');
    if (askResults.length === 0) {
        return false;
    }

    const groups = new Map<string, PermissionCheckResult[]>();
    for (const result of askResults) {
        const key = `${result.request.resourceType}:${result.request.action}`;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(result);
    }

    // 逐组提示用户
    for (const [, groupResults] of groups) {
        const requests = groupResults.map((r) => r.request);

        // 计算所有请求路径的共同前缀选项
        const prefixOptions = computePrefixOptions(task, requests);

        const response = await promptPermissionBatchForTask(task, requests, tool.name, prefixOptions, tool_call);

        if (response.decision === 'deny') {
            const paths = requests.map((r) => r.resourcePath).join(', ');
            const reasonLabel =
                response.denyReason === 'timeout'
                    ? '权限请求超时自动拒绝'
                    : response.denyReason === 'no_prompt_provider'
                      ? '无权限确认界面，已自动拒绝'
                      : response.denyReason === 'task_stopped'
                        ? '任务已停止，权限请求已取消'
                        : '用户拒绝了权限请求';
            tool_call.status = 'error';
            tool_call.result = `${reasonLabel}: ${requests[0].action} ${paths}`;
            tool_call.result_object = {
                permission_denied: true,
                deny_reason: response.denyReason || 'user_denied'
            };
            return true;
        }

        // 根据用户选择写回规则
        if (response.rememberScope === 'prefix' && response.selectedPrefixPattern && task.harnessContext.permission) {
            await applyPersistentPermissionAllowForTask(task, {
                resourceType: requests[0].resourceType,
                action: requests[0].action,
                pathPattern: response.selectedPrefixPattern,
                effect: 'allow'
            });
        } else if (response.rememberScope === 'type' && task.harnessContext.permission) {
            await applyPersistentPermissionAllowForTask(task, {
                resourceType: requests[0].resourceType,
                action: requests[0].action,
                pathPattern: '**',
                effect: 'allow'
            });
        }
    }

    return false;
}

export async function applyPersistentPermissionAllowForTask(task: TaskState, rule: PermissionRule): Promise<void> {
    const relatedTasks = [task];
    if (task.parent_id) {
        const parentTask = task.task_manager_state.getTask(task.parent_id);
        if (parentTask) {
            relatedTasks.push(parentTask);
        }
    }

    const enforcers: PermissionEnforcer[] = [];
    for (const relatedTask of relatedTasks) {
        const enforcer = relatedTask.harnessContext.permission;
        if (enforcer && !enforcers.includes(enforcer)) {
            enforcers.push(enforcer);
        }
    }

    for (const enforcer of enforcers) {
        await enforcer.addRule(rule);
    }

    const authoritativeEnforcer = [...relatedTasks]
        .reverse()
        .find((relatedTask) => relatedTask.harnessContext.permission)?.harnessContext.permission;
    if (!authoritativeEnforcer) {
        return;
    }

    const providers: PermissionPromptProvider[] = [];
    for (const relatedTask of relatedTasks) {
        const provider = relatedTask.harnessContext.permissionPrompt;
        if (provider?.notifyPermissionRulesChanged && !providers.includes(provider)) {
            providers.push(provider);
        }
    }

    const relatedTaskIds = relatedTasks.map((relatedTask) => relatedTask.task_id);
    for (const provider of providers) {
        await provider.notifyPermissionRulesChanged?.(authoritativeEnforcer, relatedTaskIds);
    }
}

/**
 * 计算一组同类请求的共同前缀选项，用于让用户选择授权范围。
 * 对所有请求的 ResourcePath.getPrefixes() 取交集（保留所有请求都共享的前缀）。
 * 如果请求只有一个，直接返回其前缀。
 * 如果前缀无法取交集，返回各自的精确路径前缀。
 */
function computePrefixOptions(task: TaskState, requests: PermissionRequest[]): { label: string; pattern: string }[] {
    if (requests.length === 0) return [];

    const allPrefixLists = requests.map((req) => createResourcePath(req.resourceType, req.resourcePath).getPrefixes());

    if (allPrefixLists.length === 1) {
        return allPrefixLists[0];
    }

    // 取交集：只保留所有请求都有的 pattern
    const first = allPrefixLists[0];
    const commonPrefixes = first.filter((prefix) =>
        allPrefixLists.every((list) => list.some((p) => p.pattern === prefix.pattern))
    );

    if (commonPrefixes.length > 0) {
        return commonPrefixes;
    }

    // 没有共同前缀时，返回每个请求的精确路径
    return requests.map((req) => ({ label: req.resourcePath, pattern: req.resourcePath }));
}

/**
 * 通过 harnessContext 的 permissionPrompt 向用户请求权限确认（合并后的批量请求）
 */
export async function promptPermissionBatchForTask(
    task: TaskState,
    requests: PermissionRequest[],
    toolName: string,
    prefixOptions: { label: string; pattern: string }[],
    toolCall: ToolCall
): Promise<PermissionUserResponse> {
    const pluginDecision = await task.hooks.checkBeforePermissionAsk(task, toolCall, requests);
    if (pluginDecision === 'allow') {
        return { decision: 'allow', rememberScope: 'none' };
    }
    if (pluginDecision === 'deny') {
        return { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' };
    }
    const promptProvider = task.harnessContext.permissionPrompt;
    if (!promptProvider) {
        logger.warn(`permission ask required but no prompt provider configured, defaulting to deny`);
        return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
    }

    const parentTask = task.parent_id ? task.task_manager_state.getTask(task.parent_id) : undefined;
    const taskInfo = {
        taskId: parentTask?.task_id ?? task.task_id,
        taskName: parentTask?.task_name ?? task.task_name,
        workspace: parentTask?.getWorkspace() ?? task.getWorkspace(),
        sourceTaskId: task.task_id,
        sourceTaskName: task.task_name,
        parentTaskId: parentTask?.task_id ?? null
    };
    const promptContext: PermissionPromptContext = {
        toolCallId: toolCall.id,
        messageId: findMessageIdForToolCallForTask(task, toolCall),
        input: toolCall.args_object
    };

    try {
        return await promptProvider.prompt(requests, toolName, prefixOptions, taskInfo, promptContext);
    } catch (err) {
        logger.error(`permission prompt failed: ${err}`);
        return { decision: 'deny', rememberScope: 'none' };
    }
}

export function findMessageIdForToolCallForTask(task: TaskState, toolCall: ToolCall): string | undefined {
    for (const message of task.chat_context.messages) {
        if (!(message instanceof AssistantMessage)) continue;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
            if (!part || part.type !== 'tool_call') continue;
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            if (toolcalls.includes(toolCall)) {
                return message.message_id;
            }
        }
    }
    return undefined;
}
