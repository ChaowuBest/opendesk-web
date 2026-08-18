/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type { TaskState } from '../../../aikernel/states/tasks.js';
import { type ToolCall } from '../../../aikernel/messages.js';
import { t } from '../../../../locale/index.js';
import { logger } from '../../../utils/logger.js';
import { getPluginHost, PluginHookError } from './host.js';
import type {
    PluginChatHeadersInput,
    PluginChatParams,
    PluginSkillInstallAfterContext,
    PluginSkillInstallBeforeOutput,
    PluginSkillInstallContext,
    PluginSkillLoadBeforeOutput,
    PluginSkillLoadContext
} from '../../../../../packages/plugin-sdk/src/index.js';
import type { PermissionRequest } from '../../../aikernel/types/index.js';
import type { BeforeToolCallValidateAction } from '../../../aikernel/hooks.js';

export async function runPluginChatParams(
    input: PluginChatHeadersInput,
    params: PluginChatParams = {}
): Promise<PluginChatParams> {
    return await getPluginHost().trigger('chat.params', input, { ...params });
}

export async function runPluginBeforeSkillLoad(input: PluginSkillLoadContext): Promise<PluginSkillLoadBeforeOutput> {
    const output: PluginSkillLoadBeforeOutput = { operation: 'allow' };
    await getPluginHost().trigger('skill.load.before', input, output);
    return output;
}

export async function runPluginAfterSkillLoad(input: PluginSkillLoadContext): Promise<void> {
    try {
        await getPluginHost().trigger('skill.load.after', input, {});
    } catch (error) {
        if (!(error instanceof PluginHookError)) {
            logger.error(`Plugin after-skill-load hook failed: ${input.bundleName}/${input.skillName}`, error);
        }
    }
}

export async function runPluginBeforeSkillInstall(
    input: PluginSkillInstallContext
): Promise<PluginSkillInstallBeforeOutput> {
    const output: PluginSkillInstallBeforeOutput = { operation: 'allow' };
    await getPluginHost().trigger('skill.install.before', input, output);
    return output;
}

export async function runPluginAfterSkillInstall(input: PluginSkillInstallAfterContext): Promise<void> {
    try {
        await getPluginHost().trigger('skill.install.after', input, {});
    } catch (error) {
        if (!(error instanceof PluginHookError)) {
            logger.error(`Plugin after-skill-install hook failed: ${input.skillName}`, error);
        }
    }
}

export async function runPluginChatHeaders(
    input: PluginChatHeadersInput,
    headers: Record<string, string> = {}
): Promise<Record<string, string>> {
    const output = await getPluginHost().trigger('chat.headers', input, {
        headers: { ...headers }
    });
    return output.headers;
}

export async function runPluginBeforeToolCall(
    task: TaskState,
    toolCall: ToolCall
): Promise<BeforeToolCallValidateAction> {
    const output: {
        args: unknown;
        deny?: { message?: string; metadata?: Record<string, unknown> };
    } = { args: toolCall.args_object };
    try {
        await getPluginHost().trigger(
            'tool.execute.before',
            {
                tool: toolCall.tool_name,
                taskId: task.task_id,
                callId: toolCall.id,
                workspace: task.getWorkspace()
            },
            output
        );
    } catch (error) {
        if (error instanceof PluginHookError && error.failureMode === 'closed') {
            return { operation: 'deny', message: t('plugin.hook.beforeTool.failed') };
        }
        logger.error(`Plugin before-tool hook failed: ${toolCall.tool_name}`, error);
        return { operation: 'allow' };
    }
    if (output.deny) {
        if (output.deny.metadata) {
            toolCall.result_object = output.deny.metadata;
        }
        return {
            operation: 'deny',
            message: output.deny.message || t('plugin.hook.beforeTool.denied')
        };
    }
    /* 插件改写参数：就地写回 toolCall，供后续权限检查与执行使用 */
    if (JSON.stringify(output.args) !== JSON.stringify(toolCall.args_object)) {
        toolCall.args_object = output.args as Record<string, unknown>;
    }
    return { operation: 'allow' };
}

export async function runPluginAfterToolCall(task: TaskState, toolCall: ToolCall): Promise<void> {
    const output = {
        status: toolCall.status === 'success' ? ('success' as const) : ('error' as const),
        result: toolCall.result ?? '',
        resultObject: toolCall.result_object
    };
    try {
        await getPluginHost().trigger(
            'tool.execute.after',
            {
                tool: toolCall.tool_name,
                taskId: task.task_id,
                callId: toolCall.id,
                workspace: task.getWorkspace(),
                args: toolCall.args_object
            },
            output
        );
        toolCall.status = output.status;
        toolCall.result = output.result;
        toolCall.result_object = output.resultObject;
    } catch (error) {
        if (!(error instanceof PluginHookError)) {
            logger.error(`Plugin after-tool hook failed: ${toolCall.tool_name}`, error);
        }
    }
}

export async function runPluginPermissionAsk(
    task: TaskState,
    input: { tool: string; callId?: string; permissions: PermissionRequest[] }
): Promise<'ask' | 'allow' | 'deny'> {
    const output = await getPluginHost().trigger(
        'permission.ask',
        {
            taskId: task.task_id,
            workspace: task.getWorkspace() || undefined,
            tool: input.tool,
            callId: input.callId,
            requests: input.permissions.map((request) => ({ ...request }))
        },
        { decision: 'ask' }
    );
    return output.decision;
}

export async function runPluginShellEnv(
    task: TaskState | undefined,
    input: { shell: string; command: string },
    env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
    const output = await getPluginHost().trigger(
        'shell.env',
        {
            taskId: task?.task_id,
            workspace: task?.getWorkspace() || undefined,
            shell: input.shell,
            command: input.command
        },
        { env: { ...env } }
    );
    return output.env;
}
