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

import {
    type AgentCapabilities,
    type AuthMethod,
    type ClientCapabilities,
    type ContentBlock,
    type CreateTerminalRequest,
    type CreateTerminalResponse,
    type KillTerminalRequest,
    type KillTerminalResponse,
    type McpServer,
    type ReadTextFileRequest,
    type ReadTextFileResponse,
    type ReleaseTerminalRequest,
    type ReleaseTerminalResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionConfigOption,
    type SessionNotification,
    type StopReason,
    type TerminalOutputRequest,
    type TerminalOutputResponse,
    type WaitForTerminalExitRequest,
    type WaitForTerminalExitResponse,
    type WriteTextFileRequest,
    type WriteTextFileResponse
} from '@agentclientprotocol/sdk';
import type {
    ConnectMcpRequest as ConnectMcpRequestV2,
    ConnectMcpResponse as ConnectMcpResponseV2,
    DisconnectMcpRequest as DisconnectMcpRequestV2,
    DisconnectMcpResponse as DisconnectMcpResponseV2,
    MessageMcpNotification as MessageMcpNotificationV2,
    MessageMcpRequest as MessageMcpRequestV2
} from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpTaskRuntimeTurnRequest, AcpTaskRuntimeTurnResult } from './types.js';
import { t } from '../../../../locale/index.js';
import type { AcpAgentProfile } from '../common.js';
import { createSafeAcpProfileSnapshot } from './profile.js';
import { getTaskArtifactDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { AcpEventJournal } from './journal.js';
import { AcpSessionUpdateMapper } from './mapper.js';
import {
    createDefaultAcpConnectionFactory,
    type AcpClientConnection,
    type AcpClientHandlers,
    type AcpConnectionFactory,
    type AcpConnectionHandle
} from './connection.js';
import { ClientWorkspaceRuntime, type ClientWorkspaceOperation } from './client-workspace.js';
import { ClientHostedWorkspaceMcp, type AcpMcpPeer } from './client-hosted-mcp.js';
import { createAcpExecutionFingerprint, resolveAcpWorkspace, type ResolvedAcpWorkspace } from './workspace.js';
import { AcpTimeoutError, withAcpTimeout } from './timeout.js';

type AcpPhase = 'connecting' | 'idle' | 'running' | 'uncertain' | 'cancelled';

interface AcpRuntimeCheckpoint extends Record<string, unknown> {
    schemaVersion: 1;
    profileId: string;
    safeProfile: ReturnType<typeof createSafeAcpProfileSnapshot>;
    phase: AcpPhase;
    lastSequence: number;
    executionLocation?: 'agent' | 'client';
    sessionCwd?: string;
    executionFingerprint?: string;
    sessionId?: string;
    protocolVersion?: number;
    agentInfo?: Record<string, unknown>;
    agentCapabilities?: Record<string, unknown>;
    activePrompt?: {
        promptId: string;
        startedAt: string;
    };
    lastStopReason?: StopReason;
    lastMetadata?: Record<string, unknown>;
}

export interface AcpTaskRuntimeDependencies {
    artifactDirectory?(taskId: string): string;
    createConnection?: AcpConnectionFactory;
    resolveMcpServers?(profile: AcpAgentProfile): Promise<McpServer[]>;
    sleep?(milliseconds: number): Promise<void>;
    scheduleIdleTimer?(milliseconds: number, callback: () => void): () => void;
    log?: {
        info(message: string): unknown;
        warn(message: string): unknown;
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * ACP 客户端连接的会话方法在 OpenDesk 侧是「必然实现」的方法，但 AcpClientConnection 取自
 * @agentclientprotocol/sdk 的 `Agent` 接口（node_modules/@agentclientprotocol/sdk/dist/acp.d.ts:1530），
 * 该接口把 loadSession(1577) / resumeSession(1623) / setSessionMode(1648) / setSessionConfigOption(1655)
 * 声明为可选 —— 因为它是「agent 侧能力门控处理器」的抽象，允许只实现一部分。
 * OpenDesk 实际使用的两个实现都完整实现了这四个方法：
 *  - v1：`ClientSideConnection implements Agent`，其声明在 acp.d.ts:1063 / 1109 / 1134 / 1141 均为必选方法；
 *  - v2：./connection-v2.ts 里的 `normalized: AcpClientConnection` 适配层逐一实现了四个方法。
 * 因此这属于「类型比真实契约更宽」。这里用显式校验把宽度收掉：一旦真的缺失就抛出明确的
 * 内部不变量错误（而不是用 `connection.loadSession?.(...)` 静默跳过，那会变成
 * 「会话没建立但流程继续」的静默错误）。
 */
type AcpSessionMethodName = 'loadSession' | 'resumeSession' | 'setSessionMode' | 'setSessionConfigOption';

function assertSessionMethod<M extends AcpSessionMethodName>(
    connection: AcpClientConnection,
    method: M
): asserts connection is AcpClientConnection & Required<Pick<AcpClientConnection, M>> {
    if (typeof connection[method] !== 'function') {
        // 内部不变量：连接由 OpenDesk 自己的 connection 工厂创建，四个会话方法必然存在
        throw new Error(`ACP connection does not implement ${method}`);
    }
}

function restoreCheckpoint(profile: AcpAgentProfile, value: unknown, lastSequence: number): AcpRuntimeCheckpoint {
    const base: AcpRuntimeCheckpoint = {
        schemaVersion: 1,
        profileId: profile.id,
        safeProfile: createSafeAcpProfileSnapshot(profile),
        phase: 'connecting',
        lastSequence
    };
    if (!isRecord(value) || value.profileId !== profile.id) return base;
    const phase =
        value.phase === 'idle' ||
        value.phase === 'running' ||
        value.phase === 'uncertain' ||
        value.phase === 'cancelled'
            ? value.phase
            : 'connecting';
    return {
        ...base,
        phase,
        ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
        ...(typeof value.protocolVersion === 'number' ? { protocolVersion: value.protocolVersion } : {}),
        ...(value.executionLocation === 'agent' || value.executionLocation === 'client'
            ? { executionLocation: value.executionLocation }
            : {}),
        ...(typeof value.sessionCwd === 'string' ? { sessionCwd: value.sessionCwd } : {}),
        ...(typeof value.executionFingerprint === 'string' ? { executionFingerprint: value.executionFingerprint } : {}),
        ...(isRecord(value.agentInfo) ? { agentInfo: value.agentInfo } : {}),
        ...(isRecord(value.agentCapabilities) ? { agentCapabilities: value.agentCapabilities } : {})
    };
}

function mapStopReason(stopReason: StopReason): AcpTaskRuntimeTurnResult['stopReason'] {
    switch (stopReason) {
        case 'cancelled':
            return 'cancelled';
        case 'max_tokens':
        case 'max_turn_requests':
            return 'max_tokens';
        case 'refusal':
            return 'refusal';
        default:
            return 'completed';
    }
}

function imageContentBlock(dataUri: string): ContentBlock | undefined {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUri);
    if (!match) return undefined;
    return { type: 'image', mimeType: match[1], data: match[2] };
}

export class AcpTaskRuntime implements AcpClientHandlers {
    private readonly createConnection: AcpConnectionFactory;
    private readonly artifactDirectory: (taskId: string) => string;
    private readonly resolveMcpServers: (profile: AcpAgentProfile) => Promise<McpServer[]>;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly scheduleIdleTimer: NonNullable<AcpTaskRuntimeDependencies['scheduleIdleTimer']>;
    private cancelIdleTimer?: () => void;
    private readonly log: NonNullable<AcpTaskRuntimeDependencies['log']>;
    private handle?: AcpConnectionHandle;
    private connection?: AcpClientConnection;
    private activeRequest?: AcpTaskRuntimeTurnRequest;
    private checkpoint?: AcpRuntimeCheckpoint;
    private journal?: AcpEventJournal;
    private mapper = new AcpSessionUpdateMapper();
    private capabilities?: AgentCapabilities;
    private authMethods: AuthMethod[] = [];
    private sessionConfigOptions?: SessionConfigOption[];
    private sessionId?: string;
    private replaying = false;
    private resolvedWorkspace?: ResolvedAcpWorkspace;
    private executionFingerprint?: string;
    private clientWorkspaceRuntime?: ClientWorkspaceRuntime;
    private clientHostedMcp?: ClientHostedWorkspaceMcp;

    constructor(
        private readonly profile: AcpAgentProfile,
        dependencies: AcpTaskRuntimeDependencies = {}
    ) {
        this.createConnection = dependencies.createConnection ?? createDefaultAcpConnectionFactory();
        this.artifactDirectory = dependencies.artifactDirectory ?? ((taskId) => getTaskArtifactDirectory(taskId));
        this.resolveMcpServers = dependencies.resolveMcpServers ?? (async () => []);
        this.sleep =
            dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
        this.scheduleIdleTimer =
            dependencies.scheduleIdleTimer ??
            ((milliseconds, callback) => {
                const timer = setTimeout(callback, milliseconds);
                // 空闲释放定时器不应阻止进程退出
                if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();
                return () => clearTimeout(timer);
            });
        this.log = dependencies.log ?? logger;
    }

    async runTurn(request: AcpTaskRuntimeTurnRequest): Promise<AcpTaskRuntimeTurnResult> {
        if (!this.profile.enabled) {
            throw new Error(t('acpmgr.error.agentDisabled', { name: this.profile.name }));
        }
        if (this.activeRequest) {
            throw new Error(t('acpmgr.error.concurrentTurn'));
        }

        this.activeRequest = request;
        this.journal = this.journal ?? new AcpEventJournal(this.artifactDirectory(request.taskId));
        this.checkpoint = restoreCheckpoint(this.profile, request.persistedState, this.journal.lastSequence);
        let recoveryPhase = this.checkpoint.phase;
        try {
            await this.prepareWorkspace(request.workspace);
            recoveryPhase = this.checkpoint.phase;
            if (
                this.checkpoint.sessionId &&
                this.checkpoint.executionFingerprint &&
                this.checkpoint.executionFingerprint !== this.executionFingerprint
            ) {
                this.record('lifecycle', 'session/execution_changed', {
                    previous: this.checkpoint.executionFingerprint,
                    current: this.executionFingerprint
                });
                this.checkpoint.sessionId = undefined;
                this.checkpoint.phase = 'connecting';
                recoveryPhase = 'connecting';
            }
            this.checkpoint.executionLocation = this.resolvedWorkspace?.executionLocation;
            this.checkpoint.sessionCwd = this.resolvedWorkspace?.sessionCwd;
            this.checkpoint.executionFingerprint = this.executionFingerprint;
            const sessionStrategy = this.checkpoint.sessionId ? 'restore' : 'new';
            this.log.info(
                `[ACP] dispatch started: task=${request.taskId} profile=${this.profile.id} ` +
                    `name=${JSON.stringify(this.profile.name)} transport=${this.profile.transport.type} ` +
                    `session=${sessionStrategy}`
            );
            await this.saveCheckpoint();
            try {
                await this.ensureConnected(request, recoveryPhase);
            } catch (error) {
                this.record('lifecycle', 'session/setup_failed', {
                    error: error instanceof Error ? error.message : String(error)
                });
                await this.resetConnection();
                throw error;
            }
            const connection = this.requireConnection();
            const sessionId = this.requireSessionId();
            const promptId = crypto.randomUUID();
            await this.saveCheckpoint({
                phase: 'running',
                activePrompt: { promptId, startedAt: new Date().toISOString() }
            });
            const prompt = this.buildPrompt(request);
            this.record('outbound', 'session/prompt', { sessionId, prompt, promptId });
            try {
                const response = await withAcpTimeout(
                    Promise.resolve(connection.prompt({ sessionId, prompt })),
                    this.profile.timeouts.promptMs,
                    t('acpmgr.error.promptTimeout', { milliseconds: this.profile.timeouts.promptMs })
                );
                this.record('inbound', 'session/prompt/result', response);
                await this.saveCheckpoint({
                    phase: response.stopReason === 'cancelled' ? 'cancelled' : 'idle',
                    activePrompt: undefined,
                    lastStopReason: response.stopReason
                });
                this.scheduleIdleRelease();
                const stopReason = mapStopReason(response.stopReason);
                this.log.info(
                    `[ACP] dispatch completed: task=${request.taskId} profile=${this.profile.id} stopReason=${stopReason}`
                );
                return {
                    stopReason,
                    state: this.snapshot()
                };
            } catch (error) {
                if (error instanceof AcpTimeoutError) {
                    this.record('outbound', 'session/cancel', { sessionId, reason: 'prompt_timeout' });
                    await Promise.race([
                        Promise.resolve(connection.cancel({ sessionId })).catch(() => undefined),
                        this.sleep(1_000)
                    ]);
                }
                this.record('lifecycle', 'prompt/uncertain', {
                    promptId,
                    error: error instanceof Error ? error.message : String(error)
                });
                await this.saveCheckpoint({ phase: 'uncertain' });
                await this.resetConnection();
                throw error;
            }
        } catch (error) {
            const errorType = error instanceof Error ? error.name : typeof error;
            this.log.warn(
                `[ACP] dispatch failed: task=${request.taskId} profile=${this.profile.id} ` +
                    `phase=${this.checkpoint?.phase ?? recoveryPhase} errorType=${errorType}`
            );
            throw error;
        } finally {
            this.activeRequest = undefined;
        }
    }

    async sessionUpdate(params: SessionNotification): Promise<void> {
        this.record('inbound', 'session/update', params);
        if (!this.activeRequest || (this.sessionId && params.sessionId !== this.sessionId)) return;
        for (const update of this.mapper.map(params.update)) {
            if (update.type === 'metadata') {
                await this.saveCheckpoint({ lastMetadata: update.data });
            } else if (update.type === 'plan') {
                await this.saveCheckpoint({ lastMetadata: { sessionUpdate: 'plan', entries: update.entries } });
            } else {
                await this.saveCheckpoint();
            }
            if (!this.replaying) {
                await this.activeRequest.onUpdate(update);
            }
        }
    }

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        this.record('inbound', 'session/request_permission', params);
        if (!this.activeRequest || this.activeRequest.signal.aborted) {
            return { outcome: { outcome: 'cancelled' } };
        }
        const outcome = await this.activeRequest.requestPermission(params);
        this.record('outbound', 'session/request_permission/result', outcome);
        return outcome;
    }

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        return this.requireClientWorkspaceRuntime().readTextFile(params);
    }

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        return this.requireClientWorkspaceRuntime().writeTextFile(params);
    }

    async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
        return this.requireClientWorkspaceRuntime().createTerminal(params);
    }

    async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
        return this.requireClientWorkspaceRuntime().terminalOutput(params);
    }

    async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
        return this.requireClientWorkspaceRuntime().releaseTerminal(params);
    }

    async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
        return this.requireClientWorkspaceRuntime().waitForTerminalExit(params);
    }

    async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
        return this.requireClientWorkspaceRuntime().killTerminal(params);
    }

    get clientMcpServer(): { name: string; serverId: string } | undefined {
        return this.clientHostedMcp?.descriptor;
    }

    async connectMcp(params: ConnectMcpRequestV2, peer: AcpMcpPeer): Promise<ConnectMcpResponseV2> {
        return this.requireClientHostedMcp().connect(params, peer);
    }

    async messageMcp(params: MessageMcpRequestV2): Promise<unknown> {
        return this.requireClientHostedMcp().message(params);
    }

    async notifyMcp(params: MessageMcpNotificationV2): Promise<void> {
        return this.requireClientHostedMcp().notify(params);
    }

    async disconnectMcp(params: DisconnectMcpRequestV2): Promise<DisconnectMcpResponseV2> {
        return this.requireClientHostedMcp().disconnect(params);
    }

    async cancel(_reason: 'user' | 'system'): Promise<void> {
        if (!this.connection || !this.sessionId) return;
        this.record('outbound', 'session/cancel', { sessionId: this.sessionId });
        await this.connection.cancel({ sessionId: this.sessionId });
        await this.saveCheckpoint({ phase: 'cancelled' });
    }

    async dispose(): Promise<void> {
        this.cancelIdleTimer?.();
        this.cancelIdleTimer = undefined;
        await this.resetConnection();
        await this.clientHostedMcp?.close();
        this.clientHostedMcp = undefined;
        await this.clientWorkspaceRuntime?.close();
        this.clientWorkspaceRuntime = undefined;
    }

    /**
     * turn 结束后调度空闲释放：超时后关闭连接（DELETE /acp + abort SSE 流），
     * 会话上下文保留在 checkpoint 中，下一 turn 通过 loadSession/resumeSession 恢复。
     */
    private scheduleIdleRelease(): void {
        this.cancelIdleTimer?.();
        this.cancelIdleTimer = undefined;
        const milliseconds = this.profile.timeouts.idleReleaseMs;
        if (milliseconds <= 0) return;
        this.cancelIdleTimer = this.scheduleIdleTimer(milliseconds, () => {
            this.cancelIdleTimer = undefined;
            void this.releaseIdleConnection();
        });
    }

    private async releaseIdleConnection(): Promise<void> {
        if (this.activeRequest || !this.handle || !this.sessionId) return;
        const canResume = !!(this.capabilities?.loadSession || this.capabilities?.sessionCapabilities?.resume);
        if (!canResume) {
            // 无法恢复会话时释放连接会丢失上下文，保持连接复用
            this.log.warn(
                `[ACP] idle release skipped: profile=${this.profile.id} session=${this.sessionId} resume unsupported`
            );
            return;
        }
        this.record('lifecycle', 'session/idle_release', { sessionId: this.sessionId });
        this.log.info(`[ACP] idle release: profile=${this.profile.id} session=${this.sessionId}`);
        await this.resetConnection();
    }

    private async ensureConnected(request: AcpTaskRuntimeTurnRequest, recoveryPhase: AcpPhase): Promise<void> {
        if (this.connection && this.sessionId) return;
        const workspace = this.requireResolvedWorkspace();
        await this.connectWithRetry(request.workspace);
        const connection = this.requireConnection();
        const mcpServers = await this.resolveMcpServers(this.profile);
        const savedSessionId = this.checkpoint?.sessionId;
        if (savedSessionId) {
            this.sessionId = savedSessionId;
            if (recoveryPhase === 'uncertain' || recoveryPhase === 'running') {
                if (!this.capabilities?.loadSession) {
                    throw new Error(t('acpmgr.error.reconcileUnsupported'));
                }
                assertSessionMethod(connection, 'loadSession');
                this.record('outbound', 'session/load', { sessionId: savedSessionId, cwd: workspace.sessionCwd });
                this.replaying = true;
                try {
                    const response = await connection.loadSession({
                        sessionId: savedSessionId,
                        cwd: workspace.sessionCwd,
                        mcpServers
                    });
                    this.record('inbound', 'session/load/result', response);
                    this.sessionConfigOptions = response ? (response.configOptions ?? undefined) : undefined;
                } finally {
                    this.replaying = false;
                }
            } else if (this.capabilities?.sessionCapabilities?.resume) {
                assertSessionMethod(connection, 'resumeSession');
                this.record('outbound', 'session/resume', { sessionId: savedSessionId, cwd: workspace.sessionCwd });
                const response = await connection.resumeSession({
                    sessionId: savedSessionId,
                    cwd: workspace.sessionCwd,
                    mcpServers
                });
                this.record('inbound', 'session/resume/result', response);
                this.sessionConfigOptions = response?.configOptions ?? undefined;
            } else if (this.capabilities?.loadSession) {
                assertSessionMethod(connection, 'loadSession');
                this.record('outbound', 'session/load', { sessionId: savedSessionId, cwd: workspace.sessionCwd });
                this.replaying = true;
                try {
                    const response = await connection.loadSession({
                        sessionId: savedSessionId,
                        cwd: workspace.sessionCwd,
                        mcpServers
                    });
                    this.record('inbound', 'session/load/result', response);
                    this.sessionConfigOptions = response ? (response.configOptions ?? undefined) : undefined;
                } finally {
                    this.replaying = false;
                }
            } else {
                throw new Error(t('acpmgr.error.resumeUnsupported'));
            }
        } else {
            this.record('outbound', 'session/new', { cwd: workspace.sessionCwd, mcpServers });
            const response = await connection.newSession({ cwd: workspace.sessionCwd, mcpServers });
            this.record('inbound', 'session/new/result', response);
            this.sessionId = response.sessionId;
            this.sessionConfigOptions = response.configOptions ?? undefined;
        }
        if (this.profile.protocolVersion === 1) {
            this.clientWorkspaceRuntime?.setSessionId(this.requireSessionId());
        }
        await this.saveCheckpoint({ sessionId: this.sessionId, phase: 'idle' });
        await this.applySessionSettings();
    }

    private async connectWithRetry(workspace: string): Promise<void> {
        const attempts = this.profile.reconnect.enabled ? this.profile.reconnect.maxAttempts + 1 : 1;
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                if (attempt > 0) await this.prepareWorkspace(workspace);
                if (!this.checkpoint?.sessionId) {
                    await this.saveCheckpoint({ phase: 'connecting' });
                }
                this.handle = await withAcpTimeout(
                    this.createConnection(this.profile, this, workspace),
                    this.profile.timeouts.connectMs,
                    t('acpmgr.error.connectTimeout', { milliseconds: this.profile.timeouts.connectMs })
                );
                this.watchConnectionClosure(this.handle);
                this.connection = this.handle.connection;
                const clientCapabilities = this.clientCapabilities();
                this.record('outbound', 'initialize', {
                    protocolVersion: this.profile.protocolVersion,
                    clientCapabilities
                });
                const response = await withAcpTimeout(
                    Promise.resolve(
                        this.connection.initialize({
                            protocolVersion: this.profile.protocolVersion,
                            clientCapabilities,
                            clientInfo: { name: 'OpenDesk', version: '0.3.4' }
                        })
                    ),
                    this.profile.timeouts.connectMs,
                    t('acpmgr.error.connectTimeout', { milliseconds: this.profile.timeouts.connectMs })
                );
                if (response.protocolVersion !== this.profile.protocolVersion) {
                    throw new Error(
                        t('acpmgr.error.protocolVersionMismatch', {
                            expected: this.profile.protocolVersion,
                            actual: response.protocolVersion
                        })
                    );
                }
                this.record('inbound', 'initialize/result', response);
                this.capabilities = response.agentCapabilities;
                this.authMethods = response.authMethods ?? [];
                await this.authenticateIfConfigured();
                await this.saveCheckpoint({
                    protocolVersion: response.protocolVersion,
                    agentInfo: isRecord(response.agentInfo) ? response.agentInfo : undefined,
                    agentCapabilities: isRecord(response.agentCapabilities) ? response.agentCapabilities : undefined
                });
                return;
            } catch (error) {
                lastError = error;
                this.record('lifecycle', 'connect/failed', {
                    attempt: attempt + 1,
                    error: error instanceof Error ? error.message : String(error)
                });
                await this.resetConnection();
                if (attempt + 1 < attempts) {
                    const delay = Math.min(
                        this.profile.reconnect.initialDelayMs * 2 ** attempt,
                        this.profile.reconnect.maxDelayMs
                    );
                    await this.sleep(delay);
                }
            }
        }
        throw lastError;
    }

    private watchConnectionClosure(handle: AcpConnectionHandle): void {
        void handle.closed.then(
            () => this.invalidateConnectionHandle(handle),
            () => this.invalidateConnectionHandle(handle)
        );
    }

    private invalidateConnectionHandle(handle: AcpConnectionHandle): void {
        if (this.handle !== handle) return;
        this.handle = undefined;
        this.connection = undefined;
        this.capabilities = undefined;
        this.authMethods = [];
        this.sessionConfigOptions = undefined;
        const clientHostedMcp = this.clientHostedMcp;
        this.clientHostedMcp = undefined;
        const clientWorkspaceRuntime = this.clientWorkspaceRuntime;
        this.clientWorkspaceRuntime = undefined;
        void clientHostedMcp?.close();
        void clientWorkspaceRuntime?.close();
    }

    private async applySessionSettings(): Promise<void> {
        const connection = this.requireConnection();
        const sessionId = this.requireSessionId();
        if (this.profile.session.modeId) {
            assertSessionMethod(connection, 'setSessionMode');
            const params = { sessionId, modeId: this.profile.session.modeId };
            this.record('outbound', 'session/set_mode', params);
            const response = await connection.setSessionMode(params);
            this.record('inbound', 'session/set_mode/result', response);
        }
        for (const [configId, value] of Object.entries(this.profile.session.configOptions)) {
            assertSessionMethod(connection, 'setSessionConfigOption');
            this.validateSessionConfigOption(configId, value);
            const params =
                typeof value === 'boolean'
                    ? ({ sessionId, configId, type: 'boolean', value } as const)
                    : ({ sessionId, configId, value: String(value) } as const);
            this.record('outbound', 'session/set_config_option', params);
            const response = await connection.setSessionConfigOption(params);
            this.record('inbound', 'session/set_config_option/result', response);
            if (response.configOptions?.length) this.sessionConfigOptions = response.configOptions;
        }
        await this.saveCheckpoint();
    }

    private validateSessionConfigOption(configId: string, value: string | boolean): void {
        const options = this.sessionConfigOptions;
        if (!options?.length) return;
        const option = options.find((candidate) => candidate.id === configId);
        if (!option) {
            throw new Error(t('acpmgr.error.configOptionUnsupported', { id: configId }));
        }
        if (option.type === 'boolean') {
            if (typeof value !== 'boolean') {
                throw new Error(t('acpmgr.error.configOptionTypeMismatch', { id: configId }));
            }
            return;
        }
        if (typeof value !== 'string') {
            throw new Error(t('acpmgr.error.configOptionTypeMismatch', { id: configId }));
        }
        const values = option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
        if (!values.some((entry) => entry.value === value)) {
            throw new Error(t('acpmgr.error.configOptionValueUnsupported', { id: configId, value }));
        }
    }

    private buildPrompt(request: AcpTaskRuntimeTurnRequest): ContentBlock[] {
        const prompt: ContentBlock[] = [{ type: 'text', text: request.prompt }];
        for (const dataUri of request.imageDataUris ?? []) {
            const image = imageContentBlock(dataUri);
            if (image && this.capabilities?.promptCapabilities?.image) {
                prompt.push(image);
            }
        }
        return prompt;
    }

    private record(direction: 'inbound' | 'outbound' | 'lifecycle', method: string, payload: unknown): void {
        const entry = this.journal?.append(direction, method, payload);
        if (entry && this.checkpoint) this.checkpoint.lastSequence = entry.sequence;
    }

    private async saveCheckpoint(update: Partial<AcpRuntimeCheckpoint> = {}): Promise<void> {
        if (!this.checkpoint || !this.activeRequest) return;
        this.checkpoint = {
            ...this.checkpoint,
            ...update,
            lastSequence: this.journal?.lastSequence ?? this.checkpoint.lastSequence
        };
        for (const [key, value] of Object.entries(this.checkpoint)) {
            if (value === undefined) delete (this.checkpoint as Record<string, unknown>)[key];
        }
        await this.activeRequest.checkpoint(this.snapshot());
    }

    private snapshot(): Record<string, unknown> {
        return structuredClone(this.checkpoint ?? {});
    }

    private requireConnection(): AcpClientConnection {
        if (!this.connection) throw new Error(t('acpmgr.error.connectionNotInitialized'));
        return this.connection;
    }

    private requireResolvedWorkspace(): ResolvedAcpWorkspace {
        if (!this.resolvedWorkspace) throw new Error(t('acpmgr.error.workspaceNotResolved'));
        return this.resolvedWorkspace;
    }

    private requireClientWorkspaceRuntime(): ClientWorkspaceRuntime {
        if (!this.clientWorkspaceRuntime) throw new Error(t('acpmgr.error.clientRuntimeUnavailable'));
        return this.clientWorkspaceRuntime;
    }

    private requireClientHostedMcp(): ClientHostedWorkspaceMcp {
        if (!this.clientHostedMcp) throw new Error(t('acpmgr.error.clientMcpUnavailable'));
        return this.clientHostedMcp;
    }

    private clientCapabilities(): ClientCapabilities {
        if (this.profile.protocolVersion !== 1) return {};
        return {
            session: { configOptions: { boolean: {} } },
            ...(this.profile.execution.location === 'client'
                ? { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
                : {})
        };
    }

    private async authenticateIfConfigured(): Promise<void> {
        const methodId = this.profile.session.authMethodId;
        if (!methodId) return;
        const method = this.authMethods.find((candidate) => candidate.id === methodId);
        if (!method) throw new Error(t('acpmgr.error.authMethodUnavailable', { id: methodId }));
        const methodType = 'type' in method && typeof method.type === 'string' ? method.type : 'agent';
        if (methodType !== 'agent') {
            throw new Error(t('acpmgr.error.authMethodInteractiveUnsupported', { type: methodType }));
        }
        this.record('outbound', 'authenticate', { methodId });
        await withAcpTimeout(
            Promise.resolve(this.requireConnection().authenticate({ methodId })),
            this.profile.timeouts.connectMs,
            t('acpmgr.error.connectTimeout', { milliseconds: this.profile.timeouts.connectMs })
        );
        this.record('inbound', 'authenticate/result', {});
    }

    private async prepareWorkspace(taskWorkspace: string): Promise<void> {
        const resolved = resolveAcpWorkspace(this.profile, taskWorkspace);
        const fingerprint = createAcpExecutionFingerprint(this.profile, resolved);
        if (
            this.clientWorkspaceRuntime &&
            (resolved.executionLocation !== 'client' || this.resolvedWorkspace?.sessionCwd !== resolved.sessionCwd)
        ) {
            await this.clientWorkspaceRuntime.close();
            this.clientWorkspaceRuntime = undefined;
        }
        this.resolvedWorkspace = resolved;
        this.executionFingerprint = fingerprint;
        if (resolved.executionLocation === 'client' && !this.clientWorkspaceRuntime) {
            this.clientWorkspaceRuntime = new ClientWorkspaceRuntime({
                root: resolved.clientWorkspace ?? resolved.sessionCwd,
                authorize: (operation) => this.authorizeClientOperation(operation)
            });
        }
        if (
            resolved.executionLocation === 'client' &&
            this.profile.protocolVersion === 2 &&
            this.clientWorkspaceRuntime &&
            !this.clientHostedMcp
        ) {
            const localSessionId = `client-mcp:${crypto.randomUUID()}`;
            this.clientWorkspaceRuntime.setSessionId(localSessionId);
            this.clientHostedMcp = new ClientHostedWorkspaceMcp({
                serverId: `opendesk-workspace:${this.profile.id}:${crypto.randomUUID()}`,
                workspace: this.clientWorkspaceRuntime,
                sessionId: localSessionId
            });
        }
        if (resolved.legacy) {
            this.log.warn(
                `[ACP] legacy HTTP workspace path passthrough: profile=${this.profile.id} cwd=${JSON.stringify(resolved.sessionCwd)}`
            );
        }
    }

    private async authorizeClientOperation(operation: ClientWorkspaceOperation): Promise<boolean> {
        if (!this.activeRequest || this.activeRequest.signal.aborted || !this.sessionId) return false;
        const kind = operation.kind === 'read' ? 'read' : operation.kind === 'write' ? 'edit' : 'execute';
        const title =
            operation.kind === 'read'
                ? t('acpmgr.permission.localRead')
                : operation.kind === 'write'
                  ? t('acpmgr.permission.localWrite')
                  : t('acpmgr.permission.localExecute');
        const response = await this.activeRequest.requestPermission({
            sessionId: this.sessionId,
            toolCall: {
                toolCallId: crypto.randomUUID(),
                title,
                kind,
                ...(operation.path ? { locations: [{ path: operation.path }] } : {}),
                rawInput: {
                    ...(operation.path ? { path: operation.path } : {}),
                    ...(operation.command ? { command: operation.command, args: operation.args ?? [] } : {})
                }
            },
            options: [
                {
                    optionId: 'opendesk-local-allow-once',
                    name: t('acpmgr.permission.allowOnce'),
                    kind: 'allow_once'
                },
                {
                    optionId: 'opendesk-local-allow-always',
                    name: t('acpmgr.permission.allowAlways'),
                    kind: 'allow_always'
                },
                {
                    optionId: 'opendesk-local-reject-once',
                    name: t('acpmgr.permission.rejectOnce'),
                    kind: 'reject_once'
                },
                {
                    optionId: 'opendesk-local-reject-always',
                    name: t('acpmgr.permission.rejectAlways'),
                    kind: 'reject_always'
                }
            ]
        });
        if (response.outcome.outcome !== 'selected') return false;
        return (
            response.outcome.optionId === 'opendesk-local-allow-once' ||
            response.outcome.optionId === 'opendesk-local-allow-always'
        );
    }

    private requireSessionId(): string {
        if (!this.sessionId) throw new Error(t('acpmgr.error.sessionNotInitialized'));
        return this.sessionId;
    }

    private async resetConnection(): Promise<void> {
        const handle = this.handle;
        this.handle = undefined;
        this.connection = undefined;
        this.capabilities = undefined;
        this.authMethods = [];
        this.sessionConfigOptions = undefined;
        const clientHostedMcp = this.clientHostedMcp;
        this.clientHostedMcp = undefined;
        const clientWorkspaceRuntime = this.clientWorkspaceRuntime;
        this.clientWorkspaceRuntime = undefined;
        await Promise.allSettled([
            clientHostedMcp?.close() ?? Promise.resolve(),
            clientWorkspaceRuntime?.close() ?? Promise.resolve(),
            handle?.close() ?? Promise.resolve()
        ]);
    }
}
