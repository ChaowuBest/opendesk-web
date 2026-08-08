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
import { createDefaultAcpConnectionFactory } from '../../aikernel/agents/acp/connection.js';
import { getPlatform } from '../../../platforms/base.js';
import { t } from '../../../locale/index.js';
import type { McpMgrApplication } from '../mcpmgr/app.js';
import { createAcpAgentDeclarations, resolveAcpMcpServers } from './agent.js';
import { AcpAgentProfileSchema, AcpMgrConfigSchema, type AcpAgentProfile, type AcpMgrConfig } from './common.js';

function parseConfig(value: unknown): AcpMgrConfig {
    return AcpMgrConfigSchema.parse(value ?? {});
}

export class AcpMgrApplication extends BaseApplication {
    constructor() {
        super('acpmgr', false);
    }

    getName(): string {
        return t('acpmgr.app.name');
    }

    static getConfigSchema(): z.ZodObject<any> {
        return AcpMgrConfigSchema;
    }

    async getAgents(): Promise<AgentDecl[]> {
        const config = parseConfig(this.getConfig());
        return createAcpAgentDeclarations(config.agents, (profile) => this.resolveMcpServers(profile));
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [{ eventName: 'agentsUpdated', description: 'ACP agent profiles changed' }];
    }

    onConfigChanged(): void {
        super.onConfigChanged();
        this.sendEventToSubscribers('agentsUpdated');
        void this.registry?.loadAvailableAgents?.();
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
        const factory = createDefaultAcpConnectionFactory();
        const effectiveWorkspace = workspace || getPlatform().getEffectiveWorkspace();
        const handle = await factory(
            profile,
            {
                sessionUpdate: async () => undefined,
                requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
            },
            effectiveWorkspace
        );
        try {
            const response = await handle.connection.initialize({
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
                clientInfo: { name: 'OpenDesk', version: '0.3.3' }
            });
            return {
                protocolVersion: response.protocolVersion,
                agentInfo: response.agentInfo ?? null,
                agentCapabilities: response.agentCapabilities ?? {}
            };
        } finally {
            await handle.close();
        }
    }

    private async resolveMcpServers(profile: AcpAgentProfile): Promise<McpServer[]> {
        if (profile.session.mcpServerIds.length === 0) return [];
        const mcpManager = this.registry?.getApplication?.('mcpmgr') as McpMgrApplication | undefined;
        if (!mcpManager) throw new Error(t('acpmgr.error.mcpManagerUnavailable'));
        const environ = {
            ...process.env,
            ...Object.fromEntries(getPlatform().getInjectedEnviron())
        };
        return resolveAcpMcpServers(profile, mcpManager.getServersFromConfig(), environ);
    }
}
