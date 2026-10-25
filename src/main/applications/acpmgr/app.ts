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

import { RequestError, type AuthMethod, type McpServer } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { BaseApplication, type EventDecl } from '../base.js';
import type { AgentDecl } from '../../aikernel/agents/common.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
import {
    createDefaultAcpConnectionFactory,
    getActiveAcpProfileIds,
    type AcpConnectionFactory
} from './runtime/connection.js';
import './runtime/task-extension.js';
import { getPlatform } from '../../../platforms/base.js';
import { t } from '../../../locale/index.js';
import { logger } from '../../utils/logger.js';
import type { McpMgrApplication } from '../mcpmgr/app.js';
import { createAcpAgentDeclarations, resolveAcpMcpServers } from './agent.js';
import { AcpAgentProfileSchema, AcpMgrConfigSchema, type AcpAgentProfile, type AcpMgrConfig } from './common.js';
import { ClientWorkspaceRuntime } from './runtime/client-workspace.js';
import { ClientHostedWorkspaceMcp } from './runtime/client-hosted-mcp.js';
import { resolveAcpWorkspace } from './runtime/workspace.js';
import { withAcpTimeout } from './runtime/timeout.js';

function parseConfig(value: unknown): AcpMgrConfig {
    return AcpMgrConfigSchema.parse(value ?? {});
}

function authMethodType(method: AuthMethod): string {
    return 'type' in method && typeof method.type === 'string' ? method.type : 'agent';
}

interface AcpMgrLog {
    info(message: string): unknown;
    error(message: string): unknown;
}

export interface AcpMgrApplicationDependencies {
    log?: AcpMgrLog;
    createConnection?: AcpConnectionFactory;
}

export class AcpMgrApplication extends BaseApplication {
    private agentsLoadedPromise?: Promise<void>;
    private agentRefreshTail: Promise<void> = Promise.resolve();
    private registeredAgentNames = new Set<string>();
    private readonly log: AcpMgrLog;
    private readonly createConnection: AcpConnectionFactory;

    constructor(dependencies: AcpMgrApplicationDependencies = {}) {
        super('acpmgr', false);
        this.log = dependencies.log ?? logger;
        this.createConnection = dependencies.createConnection ?? createDefaultAcpConnectionFactory();
    }

    getName(): string {
        return t('acpmgr.app.name');
    }

    static getConfigSchema(): z.ZodObject<any> {
        return AcpMgrConfigSchema;
    }

    async getAgents(): Promise<AgentDecl[]> {
        const config = parseConfig(this.getConfig());
        return createAcpAgentDeclarations(
            config.agents,
            (profile) => this.resolveMcpServers(profile),
            getActiveAcpProfileIds(),
            this.createConnection
        );
    }

    async ensureLoaded(): Promise<void> {
        if (!this.agentsLoadedPromise) {
            this.agentsLoadedPromise = this.enqueueAgentRefresh();
        }
        return this.agentsLoadedPromise;
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [{ eventName: 'agentsUpdated', eventDescription: 'ACP agent profiles changed' }];
    }

    onConfigChanged(): void {
        super.onConfigChanged();
        this.sendEventToSubscribers('agentsUpdated');
        void this.enqueueAgentRefresh().catch((error) => {
            this.log.error(`[ACP] registry refresh failed: ${error}`);
        });
    }

    listAgents(): AcpAgentProfile[] {
        return structuredClone(parseConfig(this.getConfig()).agents);
    }

    upsertAgent(input: unknown): AcpAgentProfile {
        const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        const profile = AcpAgentProfileSchema.parse({
            ...record,
            id: typeof record.id === 'string' && record.id ? record.id : crypto.randomUUID()
        });
        const config = parseConfig(this.getConfig());
        const index = config.agents.findIndex((candidate) => candidate.id === profile.id);
        if (index >= 0) {
            config.agents[index] = profile;
        } else {
            config.agents.push(profile);
        }
        this.setConfig(config);
        return structuredClone(profile);
    }

    deleteAgent(id: string): void {
        const config = parseConfig(this.getConfig());
        const nextAgents = config.agents.filter((profile) => profile.id !== id);
        if (nextAgents.length === config.agents.length) {
            throw new Error(t('acpmgr.error.agentNotFound'));
        }
        this.setConfig({ agents: nextAgents });
    }

    async testAgent(input: unknown, workspace?: string): Promise<Record<string, unknown>> {
        const profile = AcpAgentProfileSchema.parse(input);
        const effectiveWorkspace = workspace || getPlatform().getEffectiveWorkspace();
        const resolvedWorkspace = resolveAcpWorkspace(profile, effectiveWorkspace);
        const clientWorkspaceRuntime =
            resolvedWorkspace.executionLocation === 'client'
                ? new ClientWorkspaceRuntime({
                      root: resolvedWorkspace.clientWorkspace ?? resolvedWorkspace.sessionCwd,
                      authorize: async () => false
                  })
                : undefined;
        const localMcpSessionId = `client-mcp-test:${crypto.randomUUID()}`;
        if (profile.protocolVersion === 2) clientWorkspaceRuntime?.setSessionId(localMcpSessionId);
        const clientHostedMcp =
            profile.protocolVersion === 2 && clientWorkspaceRuntime
                ? new ClientHostedWorkspaceMcp({
                      serverId: `opendesk-workspace-test:${profile.id}:${crypto.randomUUID()}`,
                      workspace: clientWorkspaceRuntime,
                      sessionId: localMcpSessionId
                  })
                : undefined;
        const handle = await this.createConnection(
            profile,
            {
                sessionUpdate: async () => undefined,
                requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
                ...(clientWorkspaceRuntime
                    ? {
                          readTextFile: (params) => clientWorkspaceRuntime.readTextFile(params),
                          writeTextFile: (params) => clientWorkspaceRuntime.writeTextFile(params),
                          createTerminal: (params) => clientWorkspaceRuntime.createTerminal(params),
                          terminalOutput: (params) => clientWorkspaceRuntime.terminalOutput(params),
                          releaseTerminal: (params) => clientWorkspaceRuntime.releaseTerminal(params),
                          waitForTerminalExit: (params) => clientWorkspaceRuntime.waitForTerminalExit(params),
                          killTerminal: (params) => clientWorkspaceRuntime.killTerminal(params)
                      }
                    : {}),
                ...(clientHostedMcp
                    ? {
                          clientMcpServer: clientHostedMcp.descriptor,
                          connectMcp: (params, peer) => clientHostedMcp.connect(params, peer),
                          messageMcp: (params) => clientHostedMcp.message(params),
                          notifyMcp: (params) => clientHostedMcp.notify(params),
                          disconnectMcp: (params) => clientHostedMcp.disconnect(params)
                      }
                    : {})
            },
            effectiveWorkspace
        );
        let sessionId: string | undefined;
        let initializeResponse: Awaited<ReturnType<typeof handle.connection.initialize>> | undefined;
        try {
            initializeResponse = await withAcpTimeout(
                Promise.resolve(
                    handle.connection.initialize({
                        protocolVersion: profile.protocolVersion,
                        clientCapabilities:
                            profile.protocolVersion === 1
                                ? {
                                      session: { configOptions: { boolean: {} } },
                                      ...(resolvedWorkspace.executionLocation === 'client'
                                          ? { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
                                          : {})
                                  }
                                : {},
                        clientInfo: { name: 'OpenDesk', version: '0.3.4' }
                    })
                ),
                profile.timeouts.connectMs,
                t('acpmgr.error.connectTimeout', { milliseconds: profile.timeouts.connectMs })
            );
            if (initializeResponse.protocolVersion !== profile.protocolVersion) {
                throw new Error(
                    t('acpmgr.error.protocolVersionMismatch', {
                        expected: profile.protocolVersion,
                        actual: initializeResponse.protocolVersion
                    })
                );
            }
            const authMethods = initializeResponse.authMethods ?? [];
            if (profile.session.authMethodId) {
                const method = authMethods.find((candidate) => candidate.id === profile.session.authMethodId);
                if (!method)
                    throw new Error(t('acpmgr.error.authMethodUnavailable', { id: profile.session.authMethodId }));
                const type = authMethodType(method);
                if (type !== 'agent') throw new Error(t('acpmgr.error.authMethodInteractiveUnsupported', { type }));
                await withAcpTimeout(
                    Promise.resolve(handle.connection.authenticate({ methodId: profile.session.authMethodId })),
                    profile.timeouts.connectMs,
                    t('acpmgr.error.connectTimeout', { milliseconds: profile.timeouts.connectMs })
                );
            }
            const mcpServers = await this.resolveMcpServers(profile);
            let sessionResponse: Awaited<ReturnType<typeof handle.connection.newSession>>;
            try {
                sessionResponse = await withAcpTimeout(
                    Promise.resolve(
                        handle.connection.newSession({
                            cwd: resolvedWorkspace.sessionCwd,
                            mcpServers
                        })
                    ),
                    profile.timeouts.connectMs,
                    t('acpmgr.error.connectTimeout', { milliseconds: profile.timeouts.connectMs })
                );
            } catch (error) {
                if (error instanceof RequestError && error.code === -32_000 && authMethods.length > 0) {
                    return {
                        protocolVersion: initializeResponse.protocolVersion,
                        agentInfo: initializeResponse.agentInfo ?? null,
                        agentCapabilities: initializeResponse.agentCapabilities ?? {},
                        authMethods,
                        authenticationRequired: true,
                        sessionId: null,
                        modes: null,
                        configOptions: []
                    };
                }
                throw error;
            }
            sessionId = sessionResponse.sessionId;
            if (profile.protocolVersion === 1) clientWorkspaceRuntime?.setSessionId(sessionId);
            return {
                protocolVersion: initializeResponse.protocolVersion,
                agentInfo: initializeResponse.agentInfo ?? null,
                agentCapabilities: initializeResponse.agentCapabilities ?? {},
                authMethods: initializeResponse.authMethods ?? [],
                sessionId,
                modes: sessionResponse.modes ?? null,
                configOptions: sessionResponse.configOptions ?? []
            };
        } finally {
            const supportsClose =
                profile.protocolVersion === 2 || !!initializeResponse?.agentCapabilities?.sessionCapabilities?.close;
            const cleanupResults =
                sessionId && supportsClose && handle.connection.closeSession
                    ? await Promise.allSettled([
                          Promise.resolve(handle.connection.closeSession({ sessionId })).then(() => undefined)
                      ])
                    : [];
            cleanupResults.push(
                ...(await Promise.allSettled([
                    handle.close(),
                    clientHostedMcp?.close() ?? Promise.resolve(),
                    clientWorkspaceRuntime?.close() ?? Promise.resolve()
                ]))
            );
            for (const result of cleanupResults) {
                if (result.status === 'rejected') {
                    this.log.error(`[ACP] test cleanup failed: ${result.reason}`);
                }
            }
        }
    }

    private enqueueAgentRefresh(): Promise<void> {
        const refresh = this.agentRefreshTail.then(() => this.refreshRegisteredAgents());
        this.agentRefreshTail = refresh.catch(() => undefined);
        return refresh;
    }

    private async refreshRegisteredAgents(): Promise<void> {
        const agents = await this.getAgents();
        const nextAgentNames = new Set(agents.map((agent) => agent.agentName));
        const profilesById = new Map(parseConfig(this.getConfig()).agents.map((profile) => [profile.id, profile]));

        for (const agentName of this.registeredAgentNames) {
            if (!nextAgentNames.has(agentName)) {
                const registered = AgentRegistry.getApplicationAgent(this.bundleName, agentName);
                await AgentRegistry.removeApplicationAgent(this.bundleName, agentName);
                this.log.info(
                    `[ACP] agent removed: profile=${agentName} name=${JSON.stringify(registered?.agentName ?? agentName)}`
                );
            }
        }
        for (const agent of agents) {
            const profile = profilesById.get(agent.agentName);
            const isNew = !this.registeredAgentNames.has(agent.agentName);
            if (isNew && profile) {
                this.log.info(
                    `[ACP] agent added: profile=${profile.id} name=${JSON.stringify(profile.name)} ` +
                        `transport=${profile.transport.type}`
                );
            }
            await AgentRegistry.replaceApplicationAgent(this.bundleName, agent);
            this.log.info(
                `[ACP] agent registration completed: agent=${agent.agentId} name=${JSON.stringify(profile?.name ?? agent.agentName)} ` +
                    `enabled=${profile?.enabled ?? true} dispatchable=${agent.dispatchable}`
            );
        }
        this.registeredAgentNames = nextAgentNames;
        this.log.info(
            `[ACP] registry refresh completed: total=${agents.length} ` +
                `dispatchable=${agents.filter((agent) => agent.dispatchable).length}`
        );
    }

    private async resolveMcpServers(profile: AcpAgentProfile): Promise<McpServer[]> {
        if (
            profile.session.mcpPolicy === 'none' ||
            (profile.session.mcpPolicy === 'custom' && profile.session.mcpBindings.length === 0)
        ) {
            return [];
        }
        const mcpManager = this.registry?.getApplication?.('mcpmgr') as McpMgrApplication | undefined;
        if (!mcpManager) throw new Error(t('acpmgr.error.mcpManagerUnavailable'));
        const environ = {
            ...process.env,
            ...Object.fromEntries(getPlatform().getInjectedEnviron())
        };
        return resolveAcpMcpServers(profile, mcpManager.getServersFromConfig(), environ);
    }
}
