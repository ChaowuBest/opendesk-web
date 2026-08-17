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

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type {
    ExitPlanModeProvider,
    ExitPlanModeResponse,
    ExitPlanModeAction
} from '../../aikernel/interaction/exitPlanMode.js';
import { logger } from '../../utils/logger.js';

/**
 * ACP 环境下的 ExitPlanModeProvider 实现。
 *
 * 采用双重策略：
 * 1. 优先使用 unstable_createElicitation（支持 form 表单展示计划并选择动作）
 * 2. 失败时 fallback 到 requestPermission（ACP 稳定 API，所有客户端都支持）
 */
export class AcpExitPlanModeProvider implements ExitPlanModeProvider {
    private modeSwitcher: ((modeId: string) => Promise<void>) | null = null;
    private pendingResolve: ((response: ExitPlanModeResponse) => void) | null = null;

    constructor(
        private readonly connection: AgentSideConnection,
        private readonly sessionId: string
    ) {}

    setModeSwitcher(fn: (modeId: string) => Promise<void>): void {
        this.modeSwitcher = fn;
    }

    isPrompting(): boolean {
        return this.pendingResolve !== null;
    }

    cancelCurrent(): void {
        const resolve = this.pendingResolve;
        if (!resolve) return;
        this.pendingResolve = null;
        resolve({ action: 'continue-editing' });
    }

    async promptAndSwitch(
        planContent: string,
        planFilePath: string,
        _taskId?: string,
        _taskName?: string
    ): Promise<ExitPlanModeResponse> {
        return new Promise<ExitPlanModeResponse>((resolve) => {
            this.pendingResolve = resolve;
            this.doPrompt(planContent, planFilePath).then(
                async (response) => {
                    if (this.pendingResolve !== resolve) return;
                    this.pendingResolve = null;
                    await this.switchModeIfNeeded(response.action);
                    resolve(response);
                },
                () => {
                    if (this.pendingResolve !== resolve) return;
                    this.pendingResolve = null;
                    resolve({ action: 'continue-editing' });
                }
            );
        });
    }

    private async doPrompt(planContent: string, planFilePath: string): Promise<ExitPlanModeResponse> {
        // 策略1：尝试 unstable_createElicitation
        try {
            return await this.tryElicitation(planContent, planFilePath);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.debug(
                `AcpExitPlanModeProvider: elicitation not supported (${reason}), falling back to requestPermission`
            );
        }

        // 策略2：fallback 到 requestPermission
        try {
            return await this.promptViaPermission(planContent, planFilePath);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.warn(`AcpExitPlanModeProvider: requestPermission fallback also failed: ${reason}`);
            return { action: 'continue-editing' };
        }
    }

    private async tryElicitation(planContent: string, planFilePath: string): Promise<ExitPlanModeResponse> {
        const response = await this.connection.unstable_createElicitation({
            mode: 'form',
            sessionId: this.sessionId,
            message: '请审批以下实施计划',
            requestedSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        title: '选择操作',
                        description: `计划文件: ${planFilePath}\n\n${planContent.slice(0, 500)}${planContent.length > 500 ? '...' : ''}`,
                        oneOf: [
                            { const: 'execute-standard', title: '标准模式执行（需确认操作）' },
                            { const: 'execute-solo', title: '效率模式执行（全自动）' },
                            { const: 'continue-editing', title: '继续编辑计划' }
                        ]
                    }
                },
                required: ['action']
            } as any
        });

        if (response.action === 'accept' && response.content?.action) {
            const action = response.content.action as ExitPlanModeAction;
            return { action };
        }

        return { action: 'continue-editing' };
    }

    private async promptViaPermission(planContent: string, planFilePath: string): Promise<ExitPlanModeResponse> {
        const response = await this.connection.requestPermission({
            sessionId: this.sessionId,
            toolCall: {
                toolCallId: `exitPlanMode-${Date.now()}`,
                title: '计划审批',
                kind: 'other' as const,
                status: 'pending' as const,
                rawInput: {
                    planFilePath,
                    planContentPreview: planContent.slice(0, 200)
                }
            },
            options: [
                { optionId: 'execute-standard', name: '标准模式执行', kind: 'allow_once' as const },
                { optionId: 'execute-solo', name: '效率模式执行', kind: 'allow_once' as const },
                { optionId: 'continue-editing', name: '继续编辑', kind: 'allow_once' as const }
            ]
        });

        if (response.outcome.outcome === 'selected') {
            return { action: response.outcome.optionId as ExitPlanModeAction };
        }

        return { action: 'continue-editing' };
    }

    private async switchModeIfNeeded(action: ExitPlanModeAction): Promise<void> {
        if (!this.modeSwitcher) return;

        if (action === 'execute-standard') {
            await this.modeSwitcher('standard');
        } else if (action === 'execute-solo') {
            await this.modeSwitcher('solo');
        }
    }
}
