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

import { PROTOCOL_VERSION, type McpServer } from '@agentclientprotocol/sdk';
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
import { resolveAcpWorkspace } from './runtime/workspace.js';

function parseConfig(value: unknown): AcpMgrConfig {
    return AcpMgrConfigSchema.parse(value ?? {});
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
        return [{ eventName: 'agentsUpdated', description: 'ACP agent profiles changed' }];
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
                ? new ClientWorkspaceRuntime({ root: resolvedWorkspace.sessionCwd, authorize: async () => false })
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
                    : {})
            },
            effectiveWorkspace
        );
        let sessionId: string | undefined;
        try {
            const initializeResponse = await handle.connection.initialize({
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities:
                    resolvedWorkspace.executionLocation === 'client'
                        ? { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
                        : {},
                clientInfo: { name: 'OpenDesk', version: '0.3.4' }
            });
            const sessionResponse = await handle.connection.newSession({
                cwd: resolvedWorkspace.sessionCwd,
                mcpServers: []
            });
            sessionId = sessionResponse.sessionId;
            clientWorkspaceRuntime?.setSessionId(sessionId);
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
            if (sessionId && handle.connection.closeSession) {
                await handle.connection.closeSession({ sessionId });
            }
            await handle.close();
            await clientWorkspaceRuntime?.close();
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
        if (profile.session.mcpBindings.length === 0) return [];
        const mcpManager = this.registry?.getApplication?.('mcpmgr') as McpMgrApplication | undefined;
        if (!mcpManager) throw new Error(t('acpmgr.error.mcpManagerUnavailable'));
        const environ = {
            ...process.env,
            ...Object.fromEntries(getPlatform().getInjectedEnviron())
        };
        return resolveAcpMcpServers(profile, mcpManager.getServersFromConfig(), environ);
    }
}
