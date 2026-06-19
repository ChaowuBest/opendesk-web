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
import { MainAgentDecl } from '../../aikernel/agents/main/agent.js';
import type { ModeDecl } from '../../aikernel/agents/common.js';
import { AcpPermissionPromptProvider } from './permission.js';
import { AcpUpdateTranslator } from './updates.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

interface AcpSessionState {
    sessionId: string;
    cwd: string;
    task: TaskState;
    mode: ModeDecl;
    updates: AcpUpdateTranslator;
    runningPrompt?: Promise<void>;
    cancelled: boolean;
}

function sessionNotFound(sessionId: string): acp.RequestError {
    return acp.RequestError.resourceNotFound(`session:${sessionId}`);
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function getDefaultMode(agentDecl: MainAgentDecl): ModeDecl {
    const modes = agentDecl.supportedModes();
    return modes.find((mode) => mode.id === agentDecl.defaultModeId()) ?? modes[0];
}

function modeToAcp(mode: ModeDecl): acp.SessionMode {
    return {
        id: mode.id,
        name: mode.name,
        description: mode.description
    };
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
    private readonly agentDecl = new MainAgentDecl();
    private readonly sessions = new Map<string, AcpSessionState>();

    constructor(private readonly connection: AgentSideConnection) {}

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
                    close: {}
                }
            }
        };
    }

    async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
        return {};
    }

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        if (!path.isAbsolute(params.cwd)) {
            throw acp.RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be absolute');
        }

        const sessionId = crypto.randomUUID();
        const mode = getDefaultMode(this.agentDecl);
        const task = GlobalState.getInstance().taskManagerState.createTask();
        const session: AcpSessionState = {
            sessionId,
            cwd: params.cwd,
            task,
            mode,
            updates: new AcpUpdateTranslator(),
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
            modes: this.getModeState(mode)
        };
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

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
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

    private async configureTaskForSession(session: AcpSessionState, mode: ModeDecl): Promise<void> {
        session.mode = mode;
        const taskManagerState = GlobalState.getInstance().taskManagerState;
        await taskManagerState.initHarness(session.task, session.cwd, mode);
        session.task.harnessContext.permissionPrompt = new AcpPermissionPromptProvider(
            this.connection,
            session.sessionId
        );
        session.task.setSystemPrompt(await this.agentDecl.createSystemPrompt(mode, session.task));
        session.task.persistLater();
    }

    private async runPrompt(session: AcpSessionState, text: string): Promise<void> {
        try {
            let updateChain = Promise.resolve();
            await session.task.submitUserMessage(text);
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
