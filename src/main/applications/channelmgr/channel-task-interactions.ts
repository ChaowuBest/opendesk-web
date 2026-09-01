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

/**
 * 渠道任务的交互 provider 注入。
 *
 * 对于 origin.type === 'channel' 的任务，根据渠道是否支持结构化交互决定：
 * - 渠道支持交互（capabilities.interactive + sendInteraction）：
 *   permissionPrompt 替换为 ChannelPermissionPromptProvider，askUser 走 ChannelAskUserProvider，
 *   权限审批与提问结构化透传到用户侧（如飞书确认卡片）；
 * - 渠道不支持交互：
 *   permissionPrompt 替换为自动拒绝 provider（无确认界面，不允许悬浮等待），
 *   且不挂载交互工具集（askUser / exitPlanMode 不暴露给模型）。
 */

import type { AskUserProvider, AskUserRequest, AskUserResponse } from '../../aikernel/interaction/tools.js';
import type {
    PermissionPromptProvider,
    PermissionRequest,
    PermissionTaskInfo,
    PermissionPromptContext,
    PermissionUserResponse
} from '../../aikernel/security/permission.js';
import { logger } from '../../utils/logger.js';
import type { Participant } from '../../plugins/types.js';
import { ChannelInteractionService, type ChannelAskUserQuestion, type ChannelAskUserRequest } from './interactions.js';
import { t as tLocal } from './locale/index.js';

/** 把服务层拒绝原因映射为 permission 系统的 PermissionDenyReason。 */
function mapDenyReason(
    reason: 'user_denied' | 'timeout' | 'no_interaction' | 'send_failed' | undefined
): 'user_denied' | 'timeout' | 'no_prompt_provider' {
    if (reason === 'timeout') return 'timeout';
    if (reason === 'user_denied') return 'user_denied';
    // 渠道不支持交互 / 发送失败：等同于「无权限确认界面」
    return 'no_prompt_provider';
}

/**
 * 权限审批透传 provider：把 permission 系统的 ask 请求转成渠道审批卡片。
 * 仅用于渠道支持交互的任务；否则请使用 createChannelDenyPermissionProvider。
 */
export class ChannelPermissionPromptProvider implements PermissionPromptProvider {
    constructor(
        private readonly service: ChannelInteractionService,
        private readonly origin: Participant
    ) {}

    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        _prefixOptions: { label: string; pattern: string }[],
        taskInfo?: PermissionTaskInfo,
        _context?: PermissionPromptContext
    ): Promise<PermissionUserResponse> {
        const summary = requests.map((r) => `${r.action} ${r.resourcePath}`).join('；');
        const prompt =
            (taskInfo?.taskName ? `任务「${taskInfo.taskName}」` : '') +
            `请求执行敏感操作，是否允许？\n\n**${toolName}**\n\n${summary}`;

        const outcome = await this.service.requestApproval(
            this.origin,
            {
                prompt,
                tool: toolName,
                requests,
                confirmLabel: tLocal('channel.permission.confirm'),
                cancelLabel: tLocal('channel.permission.deny')
            },
            undefined,
            taskInfo?.sourceTaskId ?? taskInfo?.taskId
        );

        if (outcome.decision === 'deny' && outcome.error) {
            logger.warn(`[channel-permission] approval via ${this.origin.channel} failed to deliver: ${outcome.error}`);
        }

        return {
            decision: outcome.decision,
            rememberScope: 'none',
            denyReason: outcome.decision === 'deny' ? mapDenyReason(outcome.denyReason) : undefined
        };
    }

    /** 渠道卡片不支持规则持久化，权限规则变更无需通知。 */
    notifyPermissionRulesChanged?(): void {
        /* no-op */
    }

    cancelTaskPrompts(taskIds: string[]): void {
        this.service.cancelTaskPrompts(taskIds);
    }
}

/** 渠道 askUser provider：把 askUser 提问转成渠道交互卡片。 */
export class ChannelAskUserProvider implements AskUserProvider {
    constructor(
        private readonly service: ChannelInteractionService,
        private readonly origin: Participant
    ) {}

    async prompt(request: AskUserRequest): Promise<AskUserResponse> {
        const questions: ChannelAskUserQuestion[] = request.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options.map((opt) => ({ label: opt.label, description: opt.description })),
            multiple: q.multiple ?? false
        }));
        const channelRequest: ChannelAskUserRequest = { questions };
        const outcome = await this.service.askUser(this.origin, channelRequest, undefined, request.taskId);
        return { answers: outcome.answers, cancelled: outcome.cancelled };
    }

    isPrompting(): boolean {
        return false;
    }

    cancelCurrent(): void {
        this.service.cancelChannelInteractions(this.origin.channel, this.origin.accountId, this.origin.recipientId);
    }
}

/** 渠道不支持交互时的权限 provider：直接拒绝，避免无界面悬挂等待。 */
export function createChannelDenyPermissionProvider(
    reason: 'no_prompt_provider' | 'task_stopped' = 'no_prompt_provider'
): PermissionPromptProvider {
    return {
        async prompt(): Promise<PermissionUserResponse> {
            return { decision: 'deny', rememberScope: 'none', denyReason: reason };
        },
        notifyPermissionRulesChanged(): void {
            /* no-op */
        },
        cancelTaskPrompts(): void {
            /* no-op */
        }
    };
}
