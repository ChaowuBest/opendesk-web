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

import * as acp from '@agentclientprotocol/sdk';
import crypto from 'crypto';
import path from 'path';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { GlobalState } from '../../aikernel/states/global.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ModeDecl } from '../../aikernel/agents/common.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
import { AcpPermissionPromptProvider } from './permission.js';
import { AcpAskUserProvider } from './askUser.js';
import { AcpExitPlanModeProvider } from './exitPlanMode.js';
import { AcpUpdateTranslator } from './updates.js';
import { AcpState } from './state.js';
import { createInteractionToolset } from '../../aikernel/interaction/tools.js';
import { logger } from '../../utils/logger.js';
import { Setting, type SettingData } from '../../utils/setting.js';
import { t } from '../../../locale/index.js';
import { switchTaskMode } from '../../aikernel/task/mode.js';

interface AcpSessionState {
    sessionId: string;
    cwd: string;
    task: TaskState;
    mode: ModeDecl;
    updates: AcpUpdateTranslator;
    createdAt: Date;
    runningPrompt?: Promise<void>;
    cancelled: boolean;
}

/**
 * OpenDesk 对 ACP 协议的本地扩展：会话支持模型选择（unstable_setSessionModel）与
 * prompt 消息回执 ID，上游 SDK 的 schema 尚未包含对应字段。
 */
type PromptRequestWithMessageId = acp.PromptRequest & { messageId?: string };

/**
 * unstable_setSessionModel 与 newSession.models 是 OpenDesk 对 ACP 的模型选择扩展，
 * 上游 SDK 仅有 mode 切换（SetSessionMode*），以下为该扩展的本地协议形状。
 */
interface SetSessionModelRequestExt {
    sessionId: string;
    modelId: string;
}
interface SessionModelStateExt {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string; description: string }>;
}
type NewSessionResponseWithModels = acp.NewSessionResponse & {
    models?: SessionModelStateExt | undefined;
};

function sessionNotFound(sessionId: string): acp.RequestError {
    return acp.RequestError.resourceNotFound(`session:${sessionId}`);
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function modeToAcp(mode: ModeDecl): acp.SessionMode {
    return {
        id: mode.id,
        name: mode.name,
        description: mode.description
    };
}

export interface AcpAgentOptions {
    /**
     * 通过 serve --model 指定的固定模型别名。
     * 设置后所有会话使用该模型，且客户端无法通过 setSessionModel 切换。
     */
    model?: string;
}

function getChatModels(data: SettingData): SettingData['models'] {
    return (data.models ?? []).filter((model) => model.model_type === 'chat');
}

function getCurrentModelId(task: TaskState, data: SettingData): string | undefined {
    const chatModels = getChatModels(data);
    if (chatModels.length === 0) {
        return undefined;
    }

    const taskModel = task.ensureValidModelOrFallback();
    if (taskModel && chatModels.some((model) => model.alias === taskModel)) {
        return taskModel;
    }

    if (data.default_model && chatModels.some((model) => model.alias === data.default_model)) {
        return data.default_model;
    }

    return chatModels[0]?.alias;
}

function contentBlockToText(block: acp.ContentBlock): string | null {
    if (block.type === 'text') {
        return block.text;
    }

    if (block.type === 'resource_link') {
        const title = block.title || block.name || block.uri;
        return `Referenced resource: ${title}\n${block.uri}`;
    }

    if (block.type === 'resource') {
        const resource = block.resource;
        if ('text' in resource) {
            return `Embedded resource: ${resource.uri}\n${resource.text}`;
        }
        return `Embedded binary resource omitted: ${resource.uri}`;
    }

    if (block.type === 'image') {
        return block.uri ? `Image omitted: ${block.uri}` : 'Image omitted.';
    }

    if (block.type === 'audio') {
        return 'Audio omitted.';
    }

    return null;
}

export function promptBlocksToText(blocks: acp.ContentBlock[]): string {
    return blocks
        .map((block) => contentBlockToText(block))
        .filter((text): text is string => typeof text === 'string' && text.length > 0)
        .join('\n\n')
        .trim();
}

export class OpenDeskAcpAgent implements acp.Agent {
    private readonly agentDecl = AgentRegistry.getMainAgent();
    private readonly sessions = new Map<string, AcpSessionState>();

    private readonly fixedModel?: string;

    constructor(
        private readonly connection: AgentSideConnection,
        options?: AcpAgentOptions
    ) {
        this.fixedModel = options?.model;
    }

    async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
        return {
            protocolVersion:
                params.protocolVersion === acp.PROTOCOL_VERSION ? params.protocolVersion : acp.PROTOCOL_VERSION,
            agentInfo: {
                name: 'opendesk',
                title: 'OpenDesk',
                version: process.env.npm_package_version || 'unknown'
            },
            agentCapabilities: {
                loadSession: false,
                promptCapabilities: {
                    image: false,
                    audio: false,
                    embeddedContext: true
                },
                sessionCapabilities: {
                    close: {},
                    list: {}
                }
            }
        };
    }

    async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
        return {};
    }

    async newSession(params: acp.NewSessionRequest): Promise<NewSessionResponseWithModels> {
        if (!path.isAbsolute(params.cwd)) {
            throw acp.RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be absolute');
        }

        const sessionId = crypto.randomUUID();
        const mode = this.agentDecl.getDefaultMode();
        const task = GlobalState.getInstance().taskManagerState.createTask();

        // 指定固定模型时直接使用；否则从 ACP 持久化默认（回退到 OpenDesk 默认）解析
        const settingData = Setting.getInstance().getData();
        const chatModels = getChatModels(settingData).map((m) => m.alias);
        const resolvedModel =
            this.fixedModel ?? AcpState.getInstance().resolveDefaultModel(settingData.default_model, chatModels);
        if (resolvedModel) {
            task.model = resolvedModel;
        }

        const session: AcpSessionState = {
            sessionId,
            cwd: params.cwd,
            task,
            mode,
            updates: new AcpUpdateTranslator(),
            createdAt: new Date(),
            cancelled: false
        };
        this.sessions.set(sessionId, session);

        try {
            await mode.onEnterMode?.(params.cwd);
            await this.configureTaskForSession(session, mode);
        } catch (err) {
            this.sessions.delete(sessionId);
            this.safeStopTask(session, 'system', 'newSession cleanup');
            throw err;
        }

        return {
            sessionId,
            modes: this.getModeState(mode),
            models: this.getModelState(session)
        };
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        if (params.cwd && !path.isAbsolute(params.cwd)) {
            throw acp.RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be absolute');
        }

        const sessions = Array.from(this.sessions.values())
            .filter((session) => !params.cwd || session.cwd === params.cwd)
            .sort((a, b) => {
                const aTime = a.task.updated_at?.getTime() ?? a.createdAt.getTime();
                const bTime = b.task.updated_at?.getTime() ?? b.createdAt.getTime();
                return bTime - aTime;
            })
            .map((session): acp.SessionInfo => ({
                sessionId: session.sessionId,
                cwd: session.cwd,
                title: session.task.task_name || t('acp.session.default_title'),
                updatedAt: (session.task.updated_at ?? session.createdAt).toISOString()
            }));

        return { sessions };
    }

    async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw sessionNotFound(params.sessionId);
        }
        session.cancelled = true;
        this.safeStopTask(session, 'user', 'closeSession');
        try {
            await session.runningPrompt;
        } catch (err) {
            logger.warn(`ACP closeSession ignored prompt error for session ${session.sessionId}: ${errorMessage(err)}`);
        }
        try {
            await session.mode.onExitMode?.(session.cwd);
        } catch (err) {
            logger.warn(
                `ACP closeSession ignored mode exit error for session ${session.sessionId}: ${errorMessage(err)}`
            );
        } finally {
            this.sessions.delete(params.sessionId);
        }
        return {};
    }

    async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw sessionNotFound(params.sessionId);
        }

        const nextMode = this.agentDecl.supportedModes().find((mode) => mode.id === params.modeId);
        if (!nextMode) {
            throw acp.RequestError.invalidParams({ modeId: params.modeId }, `unknown mode: ${params.modeId}`);
        }

        if (session.mode.id !== nextMode.id) {
            await session.mode.onExitMode?.(session.cwd);
            await nextMode.onEnterMode?.(session.cwd);
            await this.configureTaskForSession(session, nextMode);
        }

        await this.safeSessionUpdate(
            {
                sessionId: session.sessionId,
                update: {
                    sessionUpdate: 'current_mode_update',
                    currentModeId: nextMode.id
                }
            },
            'current_mode_update'
        );

        return {};
    }

    async unstable_setSessionModel(params: SetSessionModelRequestExt): Promise<Record<string, unknown>> {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw sessionNotFound(params.sessionId);
        }

        // 固定模型（serve --model）模式下拒绝切换，模型不可被客户端修改
        if (this.fixedModel) {
            if (params.modelId !== this.fixedModel) {
                throw acp.RequestError.invalidParams(
                    { modelId: params.modelId },
                    `model is locked to: ${this.fixedModel}`
                );
            }
            return {};
        }

        const setting = Setting.getInstance();
        if (!setting.getModelInstance(params.modelId, 'chat')) {
            throw acp.RequestError.invalidParams({ modelId: params.modelId }, `unknown chat model: ${params.modelId}`);
        }

        session.task.model = params.modelId;
        session.task.persistLater();

        // Persist as ACP's default model for future sessions
        AcpState.getInstance().setDefaultModel(params.modelId);
        return {};
    }

    async prompt(params: PromptRequestWithMessageId): Promise<acp.PromptResponse> {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw sessionNotFound(params.sessionId);
        }

        if (session.runningPrompt) {
            await session.runningPrompt;
        }

        const text = promptBlocksToText(params.prompt);
        if (!text) {
            throw acp.RequestError.invalidParams(undefined, 'prompt must contain text');
        }

        session.cancelled = false;
        const run = this.runPrompt(session, text);
        session.runningPrompt = run;
        try {
            await run;
        } finally {
            session.runningPrompt = undefined;
        }

        return {
            stopReason: session.cancelled || session.task.stop_requested_by_user ? 'cancelled' : 'end_turn',
            ...(params.messageId ? { userMessageId: params.messageId } : {})
        };
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        const session = this.sessions.get(params.sessionId);
        if (!session) return;
        session.cancelled = true;
        this.safeStopTask(session, 'user', 'cancel');
    }

    private getModeState(currentMode: ModeDecl): acp.SessionModeState {
        return {
            currentModeId: currentMode.id,
            availableModes: this.agentDecl.supportedModes().map(modeToAcp)
        };
    }

    private getModelState(session: AcpSessionState): SessionModelStateExt | undefined {
        const data = Setting.getInstance().getData();
        const chatModels = getChatModels(data);
        const currentModelId = getCurrentModelId(session.task, data);
        if (chatModels.length === 0 || !currentModelId) {
            return undefined;
        }

        return {
            currentModelId,
            availableModels: chatModels.map((model) => ({
                modelId: model.alias,
                name: model.alias || model.model_name,
                description: `${model.provider_name}/${model.model_name}`
            }))
        };
    }

    private async configureTaskForSession(session: AcpSessionState, mode: ModeDecl): Promise<void> {
        session.mode = mode;
        const taskManagerState = GlobalState.getInstance().taskManagerState;
        await taskManagerState.initHarness(session.task, session.cwd, mode);
        session.task.harnessContext.permissionPrompt = new AcpPermissionPromptProvider(
            this.connection,
            session.sessionId
        );
        const exitPlanModeProvider = new AcpExitPlanModeProvider(this.connection, session.sessionId);
        exitPlanModeProvider.setModeSwitcher(async (targetModeId: string) => {
            const switched = await switchTaskMode(session.task, targetModeId, () => {
                return new AcpPermissionPromptProvider(this.connection, session.sessionId);
            });
            if (!switched) return;
            session.mode = session.task.getAgentMode();

            await this.safeSessionUpdate(
                {
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: 'current_mode_update',
                        currentModeId: targetModeId
                    }
                },
                'current_mode_update'
            );
        });
        session.task.interactionToolset = createInteractionToolset(
            new AcpAskUserProvider(this.connection, session.sessionId),
            exitPlanModeProvider
        );
        await session.task.rebuildSystemPrompt();
    }

    private async runPrompt(session: AcpSessionState, text: string): Promise<void> {
        try {
            let updateChain = Promise.resolve();
            await session.task.submitUserMessage(text, { interactive: true });
            await session.task.waitUntilFinished((chunk) => {
                updateChain = updateChain
                    .then(() => session.updates.publish(this.connection, session.sessionId, chunk))
                    .catch((err) => {
                        logger.warn(`failed to publish ACP session update: ${errorMessage(err)}`);
                    });
            }, true);
            await updateChain;
        } catch (err) {
            if (session.cancelled || session.task.stop_requested_by_user) {
                return;
            }

            const message = errorMessage(err);
            logger.error(`ACP prompt failed for session ${session.sessionId}: ${message}`);
            await this.safeSessionUpdate(
                {
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: {
                            type: 'text',
                            text: `${t('headless.error')}: ${message}`
                        }
                    }
                },
                'prompt_error'
            );
            throw err;
        }
    }

    private safeStopTask(session: AcpSessionState, reason: 'user' | 'system', action: string): void {
        try {
            session.task.stop(reason);
        } catch (err) {
            logger.warn(`ACP ${action} ignored task stop error for session ${session.sessionId}: ${errorMessage(err)}`);
        }
    }

    private async safeSessionUpdate(params: acp.SessionNotification, action: string): Promise<boolean> {
        try {
            await this.connection.sessionUpdate(params);
            return true;
        } catch (err) {
            logger.warn(`ACP ${action} session/update failed for session ${params.sessionId}: ${errorMessage(err)}`);
            return false;
        }
    }
}
