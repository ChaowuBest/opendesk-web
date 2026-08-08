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
    PROTOCOL_VERSION,
    type AgentCapabilities,
    type ContentBlock,
    type McpServer,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type StopReason
} from '@agentclientprotocol/sdk';
import type {
    AgentRuntimePermissionRequest,
    AgentTaskRuntime,
    AgentTaskRuntimeTurnRequest,
    AgentTaskRuntimeTurnResult
} from '../common.js';
import { getTaskArtifactDirectory } from '../../../utils/setting.js';
import { AcpEventJournal } from './journal.js';
import { AcpSessionUpdateMapper } from './mapper.js';
import {
    createDefaultAcpConnectionFactory,
    type AcpClientConnection,
    type AcpClientHandlers,
    type AcpConnectionFactory,
    type AcpConnectionHandle
} from './connection.js';
import { createSafeAcpProfileSnapshot, type AcpAgentProfile } from '../../../applications/acpmgr/common.js';

type AcpPhase = 'connecting' | 'idle' | 'running' | 'uncertain' | 'cancelled';

interface AcpRuntimeCheckpoint extends Record<string, unknown> {
    schemaVersion: 1;
    profileId: string;
    safeProfile: ReturnType<typeof createSafeAcpProfileSnapshot>;
    phase: AcpPhase;
    lastSequence: number;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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
        ...(isRecord(value.agentInfo) ? { agentInfo: value.agentInfo } : {}),
        ...(isRecord(value.agentCapabilities) ? { agentCapabilities: value.agentCapabilities } : {})
    };
}

function permissionAccess(
    request: RequestPermissionRequest
): Pick<AgentRuntimePermissionRequest, 'resourceType' | 'action'> {
    switch (request.toolCall.kind) {
        case 'read':
        case 'search':
            return { resourceType: 'file', action: 'read' };
        case 'edit':
        case 'delete':
        case 'move':
            return { resourceType: 'file', action: 'write' };
        case 'execute':
            return { resourceType: 'file', action: 'execute' };
        case 'fetch':
            return { resourceType: 'network', action: 'access' };
        default:
            return { resourceType: '*', action: '*' };
    }
}

function mapStopReason(stopReason: StopReason): AgentTaskRuntimeTurnResult['stopReason'] {
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

export class AcpTaskRuntime implements AgentTaskRuntime, AcpClientHandlers {
    readonly kind = 'acp';
    private readonly createConnection: AcpConnectionFactory;
    private readonly artifactDirectory: (taskId: string) => string;
    private readonly resolveMcpServers: (profile: AcpAgentProfile) => Promise<McpServer[]>;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private handle?: AcpConnectionHandle;
    private connection?: AcpClientConnection;
    private activeRequest?: AgentTaskRuntimeTurnRequest;
    private checkpoint?: AcpRuntimeCheckpoint;
    private journal?: AcpEventJournal;
    private mapper = new AcpSessionUpdateMapper();
    private capabilities?: AgentCapabilities;
    private sessionId?: string;
    private replaying = false;

    constructor(
        private readonly profile: AcpAgentProfile,
        dependencies: AcpTaskRuntimeDependencies = {}
    ) {
        this.createConnection = dependencies.createConnection ?? createDefaultAcpConnectionFactory();
        this.artifactDirectory = dependencies.artifactDirectory ?? ((taskId) => getTaskArtifactDirectory(taskId));
        this.resolveMcpServers = dependencies.resolveMcpServers ?? (async () => []);
        this.sleep =
            dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    }

    async runTurn(request: AgentTaskRuntimeTurnRequest): Promise<AgentTaskRuntimeTurnResult> {
        if (!this.profile.enabled) {
            throw new Error(`ACP agent "${this.profile.name}" is disabled`);
        }
        if (this.activeRequest) {
            throw new Error('ACP runtime does not support concurrent turns for one task');
        }

        this.activeRequest = request;
        this.journal = this.journal ?? new AcpEventJournal(this.artifactDirectory(request.taskId));
        this.checkpoint = restoreCheckpoint(this.profile, request.persistedState, this.journal.lastSequence);
        const recoveryPhase = this.checkpoint.phase;
        try {
            await this.ensureConnected(request, recoveryPhase);
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
                const response = await connection.prompt({ sessionId, prompt });
                this.record('inbound', 'session/prompt/result', response);
                await this.saveCheckpoint({
                    phase: response.stopReason === 'cancelled' ? 'cancelled' : 'idle',
                    activePrompt: undefined,
                    lastStopReason: response.stopReason
                });
                return {
                    stopReason: mapStopReason(response.stopReason),
                    state: this.snapshot()
                };
            } catch (error) {
                this.record('lifecycle', 'prompt/uncertain', {
                    promptId,
                    error: error instanceof Error ? error.message : String(error)
                });
                await this.saveCheckpoint({ phase: 'uncertain' });
                await this.resetConnection();
                throw error;
            }
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
        const rawInput = isRecord(params.toolCall.rawInput) ? params.toolCall.rawInput : undefined;
        const response = await this.activeRequest.requestPermission({
            toolCallId: params.toolCall.toolCallId,
            title: params.toolCall.title ?? params.toolCall.name ?? params.toolCall.toolCallId,
            rawInput,
            locations: params.toolCall.locations?.map((location) => ({
                path: location.path,
                ...(typeof location.line === 'number' ? { line: location.line } : {})
            })),
            options: params.options.map((option) => ({
                id: option.optionId,
                label: option.name,
                kind: option.kind
            })),
            ...permissionAccess(params)
        });
        const outcome: RequestPermissionResponse =
            response.outcome === 'selected' && response.optionId
                ? { outcome: { outcome: 'selected', optionId: response.optionId } }
                : { outcome: { outcome: 'cancelled' } };
        this.record('outbound', 'session/request_permission/result', outcome);
        return outcome;
    }

    async cancel(_reason: 'user' | 'system'): Promise<void> {
        if (!this.connection || !this.sessionId) return;
        this.record('outbound', 'session/cancel', { sessionId: this.sessionId });
        await this.connection.cancel({ sessionId: this.sessionId });
        await this.saveCheckpoint({ phase: 'cancelled' });
    }

    async dispose(): Promise<void> {
        await this.resetConnection();
    }

    private async ensureConnected(request: AgentTaskRuntimeTurnRequest, recoveryPhase: AcpPhase): Promise<void> {
        if (this.connection && this.sessionId) return;
        await this.connectWithRetry(request.workspace);
        const connection = this.requireConnection();
        const mcpServers = await this.resolveMcpServers(this.profile);
        const savedSessionId = this.checkpoint?.sessionId;
        if (savedSessionId) {
            this.sessionId = savedSessionId;
            if (recoveryPhase === 'uncertain' || recoveryPhase === 'running') {
                if (!this.capabilities?.loadSession) {
                    throw new Error('The ACP agent cannot reconcile the interrupted session');
                }
                this.record('outbound', 'session/load', { sessionId: savedSessionId, cwd: request.workspace });
                this.replaying = true;
                try {
                    const response = await connection.loadSession({
                        sessionId: savedSessionId,
                        cwd: request.workspace,
                        mcpServers
                    });
                    this.record('inbound', 'session/load/result', response);
                } finally {
                    this.replaying = false;
                }
            } else if (this.capabilities?.sessionCapabilities?.resume) {
                this.record('outbound', 'session/resume', { sessionId: savedSessionId, cwd: request.workspace });
                const response = await connection.resumeSession({
                    sessionId: savedSessionId,
                    cwd: request.workspace,
                    mcpServers
                });
                this.record('inbound', 'session/resume/result', response);
            } else if (this.capabilities?.loadSession) {
                this.record('outbound', 'session/load', { sessionId: savedSessionId, cwd: request.workspace });
                this.replaying = true;
                try {
                    const response = await connection.loadSession({
                        sessionId: savedSessionId,
                        cwd: request.workspace,
                        mcpServers
                    });
                    this.record('inbound', 'session/load/result', response);
                } finally {
                    this.replaying = false;
                }
            } else {
                throw new Error('The ACP agent cannot resume the saved session');
            }
        } else {
            this.record('outbound', 'session/new', { cwd: request.workspace, mcpServers });
            const response = await connection.newSession({ cwd: request.workspace, mcpServers });
            this.record('inbound', 'session/new/result', response);
            this.sessionId = response.sessionId;
        }
        await this.saveCheckpoint({ sessionId: this.sessionId, phase: 'idle' });
        await this.applySessionSettings();
    }

    private async connectWithRetry(workspace: string): Promise<void> {
        const attempts = this.profile.reconnect.enabled ? this.profile.reconnect.maxAttempts + 1 : 1;
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                await this.saveCheckpoint({ phase: 'connecting' });
                this.handle = await this.createConnection(this.profile, this, workspace);
                this.connection = this.handle.connection;
                this.record('outbound', 'initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
                const response = await this.connection.initialize({
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: {},
                    clientInfo: { name: 'OpenDesk', version: '0.3.3' }
                });
                this.record('inbound', 'initialize/result', response);
                this.capabilities = response.agentCapabilities;
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

    private async applySessionSettings(): Promise<void> {
        const connection = this.requireConnection();
        const sessionId = this.requireSessionId();
        if (this.profile.session.modeId) {
            const params = { sessionId, modeId: this.profile.session.modeId };
            this.record('outbound', 'session/set_mode', params);
            const response = await connection.setSessionMode(params);
            this.record('inbound', 'session/set_mode/result', response);
        }
        for (const [configId, value] of Object.entries(this.profile.session.configOptions)) {
            const params =
                typeof value === 'boolean'
                    ? ({ sessionId, configId, type: 'boolean', value } as const)
                    : ({ sessionId, configId, value: String(value) } as const);
            this.record('outbound', 'session/set_config_option', params);
            const response = await connection.setSessionConfigOption(params);
            this.record('inbound', 'session/set_config_option/result', response);
        }
        await this.saveCheckpoint();
    }

    private buildPrompt(request: AgentTaskRuntimeTurnRequest): ContentBlock[] {
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
        if (!this.connection) throw new Error('ACP connection is not initialized');
        return this.connection;
    }

    private requireSessionId(): string {
        if (!this.sessionId) throw new Error('ACP session is not initialized');
        return this.sessionId;
    }

    private async resetConnection(): Promise<void> {
        const handle = this.handle;
        this.handle = undefined;
        this.connection = undefined;
        if (handle) await handle.close();
    }
}
