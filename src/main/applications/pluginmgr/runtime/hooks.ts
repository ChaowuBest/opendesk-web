/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type { TaskState } from '../../../aikernel/states/tasks.js';
import { AssistantMessage, UserMessage, type ToolCall } from '../../../aikernel/messages.js';
import { t } from '../../../../locale/index.js';
import { logger } from '../../../utils/logger.js';
import { getPluginHost, PluginHookError } from './host.js';
import type {
    PluginChatRequestInput,
    PluginChatParams,
    PluginTaskReviewMessage,
    PluginSkillListItem,
    PluginShellType,
    PluginSkillInstallAfterContext,
    PluginSkillInstallBeforeOutput,
    PluginSkillInstallContext,
    PluginSkillLoadBeforeOutput,
    PluginSkillLoadContext
} from '../../../../../packages/plugin-sdk/src/index.js';
import type { PermissionRequest } from '../../../aikernel/types/index.js';
import type { BeforeToolCallExecAction, BeforeToolCallValidateAction } from '../../../aikernel/hooks.js';

// ── Shell 工具名 → shellType 映射 ─────────────────────────────────────────────

const SHELL_TOOL_TYPE_MAP: Record<string, PluginShellType> = {
    'terminal-executeBash': 'bash',
    'terminal-executeZsh': 'zsh',
    // The published plugin SDK uses "powershell" as its protocol value for all pwsh versions.
    'terminal-executePwsh': 'powershell',
    'terminal-executePowerShell': 'powershell'
};

function getShellToolType(toolName: string): PluginShellType | undefined {
    return SHELL_TOOL_TYPE_MAP[toolName];
}

function extractReturnCode(resultObject: unknown): number | null {
    if (resultObject && typeof resultObject === 'object' && 'exitCode' in resultObject) {
        const code = (resultObject as { exitCode: unknown }).exitCode;
        return typeof code === 'number' && Number.isInteger(code) ? code : null;
    }
    return null;
}

export async function runPluginChatParams(
    input: PluginChatRequestInput,
    params: PluginChatParams = {}
): Promise<PluginChatParams> {
    return await getPluginHost().trigger('chat.params', input, { ...params });
}

export async function runPluginChatHeaders(
    input: PluginChatRequestInput,
    headers: Record<string, string> = {}
): Promise<Record<string, string>> {
    const output = await getPluginHost().trigger('chat.headers', input, {
        headers: { ...headers }
    });
    return output.headers;
}

function getTaskReviewMessages(task: TaskState, startMessageIndex: number): PluginTaskReviewMessage[] {
    const start = Math.max(0, Math.min(startMessageIndex, task.chat_context.messages.length));
    const messages: PluginTaskReviewMessage[] = [];

    for (const message of task.chat_context.messages.slice(start)) {
        let role: PluginTaskReviewMessage['role'];
        let content: string;
        if (message instanceof UserMessage) {
            if (message.internal) continue;
            role = 'user';
            content = message.getPlainText().trim();
        } else if (message instanceof AssistantMessage) {
            role = 'assistant';
            content = message.content
                .map((part) => (part.type === 'text' ? part.text : ''))
                .filter((text) => text.trim().length > 0)
                .join('\n')
                .trim();
        } else {
            continue;
        }
        if (content) messages.push({ role, content });
    }

    return messages;
}

export async function runPluginTaskReview(task: TaskState, startMessageIndex: number): Promise<void> {
    const messages = Object.freeze(
        getTaskReviewMessages(task, startMessageIndex).map((message) => Object.freeze({ ...message }))
    );
    try {
        await getPluginHost().trigger('task.review', Object.freeze({ taskId: task.task_id, messages }), {});
    } catch (error) {
        if (!(error instanceof PluginHookError)) {
            logger.error(`Plugin task-review hook failed: ${task.task_id}`, error);
        }
    }
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

export async function runPluginAfterSkillList(skills: readonly PluginSkillListItem[]): Promise<void> {
    try {
        const snapshot = Object.freeze(skills.map((skill) => Object.freeze({ ...skill })));
        await getPluginHost().trigger('skill.list.after', Object.freeze({ skills: snapshot }), {});
    } catch (error) {
        if (!(error instanceof PluginHookError)) {
            logger.error('Plugin after-skill-list hook failed', error);
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

export async function runPluginBeforeToolCallValidate(
    task: TaskState,
    toolCall: ToolCall
): Promise<BeforeToolCallValidateAction> {
    const output: {
        args: unknown;
        deny?: { message?: string; metadata?: Record<string, unknown> };
    } = { args: toolCall.args_object };
    try {
        await getPluginHost().trigger(
            'tool.validate.before',
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

    // ── shell.execute.before（工具级 hook 之后触发，仅针对三种 shell 工具） ──
    const shellType = getShellToolType(toolCall.tool_name);
    if (shellType) {
        const shellOutput: {
            args: unknown;
            deny?: { message?: string; metadata?: Record<string, unknown> };
        } = { args: toolCall.args_object };
        try {
            await getPluginHost().trigger(
                'shell.execute.before',
                {
                    tool: toolCall.tool_name,
                    taskId: task.task_id,
                    callId: toolCall.id,
                    workspace: task.getWorkspace(),
                    shellType
                },
                shellOutput
            );
        } catch (error) {
            if (error instanceof PluginHookError && error.failureMode === 'closed') {
                return { operation: 'deny', message: t('plugin.hook.beforeTool.failed') };
            }
            logger.error(`Plugin shell-before hook failed: ${toolCall.tool_name}`, error);
        }
        if (shellOutput.deny) {
            if (shellOutput.deny.metadata) {
                toolCall.result_object = shellOutput.deny.metadata;
            }
            return {
                operation: 'deny',
                message: shellOutput.deny.message || t('plugin.hook.beforeTool.denied')
            };
        }
        if (JSON.stringify(shellOutput.args) !== JSON.stringify(toolCall.args_object)) {
            toolCall.args_object = shellOutput.args as Record<string, unknown>;
        }
    }

    return { operation: 'allow' };
}

export async function runPluginBeforeToolCall(task: TaskState, toolCall: ToolCall): Promise<BeforeToolCallExecAction> {
    const output: {
        deny?: { message?: string; metadata?: Record<string, unknown> };
    } = {};
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
        logger.error(`Plugin before-execution hook failed: ${toolCall.tool_name}`, error);
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

    // ── shell.execute.after（工具级 hook 之后触发，仅针对三种 shell 工具） ──
    const shellType = getShellToolType(toolCall.tool_name);
    if (shellType) {
        const shellOutput = {
            status: toolCall.status === 'success' ? ('success' as const) : ('error' as const),
            result: toolCall.result ?? '',
            resultObject: toolCall.result_object
        };
        try {
            await getPluginHost().trigger(
                'shell.execute.after',
                {
                    tool: toolCall.tool_name,
                    taskId: task.task_id,
                    callId: toolCall.id,
                    workspace: task.getWorkspace(),
                    args: toolCall.args_object,
                    shellType,
                    returnCode: extractReturnCode(toolCall.result_object)
                },
                shellOutput
            );
            toolCall.status = shellOutput.status;
            toolCall.result = shellOutput.result;
            toolCall.result_object = shellOutput.resultObject;
        } catch (error) {
            if (!(error instanceof PluginHookError)) {
                logger.error(`Plugin shell-after hook failed: ${toolCall.tool_name}`, error);
            }
        }
    }
}

export async function runPluginBeforePermissionAsk(
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
