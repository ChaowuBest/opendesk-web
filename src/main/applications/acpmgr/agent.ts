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

import type { McpServer } from '@agentclientprotocol/sdk';
import { AgentDecl, type AgentType, type ModeDecl, type TaskContext } from '../../aikernel/agents/common.js';
import { AcpTaskRuntime } from './runtime/session.js';
import { createDefaultAcpConnectionFactory, type AcpConnectionFactory } from './runtime/connection.js';
import { t } from '../../../locale/index.js';
import type { McpServerConfig } from '../mcpmgr/common.js';
import {
    AcpEnvironmentVariableError,
    resolveAcpTemplate,
    resolveAcpTemplateRecord,
    type AcpAgentProfile
} from './common.js';

export type AcpMcpResolver = (profile: AcpAgentProfile) => Promise<McpServer[]>;

const ACP_MODE: ModeDecl = {
    id: 'acp',
    name: 'ACP',
    description: 'Run tasks through the configured ACP agent and workspace runtime.',
    displayNameKey: 'acpmgr.mode.name',
    descriptionKey: 'acpmgr.mode.description',
    icon: '🔌',
    color: '#6366f1',
    permissionFactory: () => []
};

export class AcpAgentDecl extends AgentDecl {
    readonly agentName: string;
    readonly agentType: AgentType = 'custom';
    readonly dispatchable: boolean;
    readonly whenToUse: string;

    constructor(
        readonly profile: AcpAgentProfile,
        private readonly resolveMcpServers: AcpMcpResolver,
        private readonly createConnection: AcpConnectionFactory,
        dispatchBlocked: boolean = false
    ) {
        super();
        this.agentName = profile.id;
        this.dispatchable = profile.enabled && profile.dispatchable && !dispatchBlocked;
        this.whenToUse = profile.whenToUse || t('acpmgr.agent.whenToUse', { name: profile.name });
    }

    supportedModes(): ModeDecl[] {
        return [ACP_MODE];
    }

    protected defaultModeId(): string {
        return ACP_MODE.id;
    }

    async createSystemPrompt(_activeMode: ModeDecl | undefined, _taskCtx: TaskContext): Promise<string> {
        return '';
    }

    createAcpTaskRuntime(): AcpTaskRuntime {
        return new AcpTaskRuntime(this.profile, {
            createConnection: this.createConnection,
            resolveMcpServers: this.resolveMcpServers
        });
    }
}

export function createAcpAgentDeclarations(
    profiles: AcpAgentProfile[],
    resolveMcpServers: AcpMcpResolver,
    blockedProfileIds: ReadonlySet<string> = new Set(),
    createConnection: AcpConnectionFactory = createDefaultAcpConnectionFactory()
): AcpAgentDecl[] {
    return profiles.map(
        (profile) => new AcpAgentDecl(profile, resolveMcpServers, createConnection, blockedProfileIds.has(profile.id))
    );
}

export function resolveAcpMcpServers(
    profile: AcpAgentProfile,
    configuredServers: McpServerConfig[],
    environ: NodeJS.ProcessEnv = process.env
): McpServer[] {
    if (profile.session.mcpPolicy === 'none') return [];
    const clientBindings = profile.session.mcpBindings.filter((binding) => binding.location === 'client');
    if (clientBindings.length > 0) {
        throw new Error(t('acpmgr.error.mcpClientProxyUnsupported'));
    }
    const selectedIds = new Set(
        profile.session.mcpBindings.filter((binding) => binding.location === 'agent').map((binding) => binding.serverId)
    );
    try {
        return configuredServers
            .filter(
                (server) => server.enabled && (profile.session.mcpPolicy === 'enabled' || selectedIds.has(server.id))
            )
            .map((server): McpServer => {
                if (server.transport === 'stdio') {
                    if (!server.command) {
                        throw new Error(t('acpmgr.error.mcpCommandMissing', { name: server.name }));
                    }
                    const resolvedEnvironment = resolveAcpTemplateRecord(server.env ?? {}, environ);
                    return {
                        name: server.name,
                        command: resolveAcpTemplate(server.command, environ),
                        args: (server.args ?? []).map((argument) => resolveAcpTemplate(argument, environ)),
                        env: Object.entries(resolvedEnvironment).map(([name, value]) => ({ name, value }))
                    };
                }
                if (!server.url) throw new Error(t('acpmgr.error.mcpUrlMissing', { name: server.name }));
                const headers = Object.entries(resolveAcpTemplateRecord(server.headers ?? {}, environ)).map(
                    ([name, value]) => ({ name, value })
                );
                return {
                    type: server.transport === 'sse' ? 'sse' : 'http',
                    name: server.name,
                    url: resolveAcpTemplate(server.url, environ),
                    headers
                };
            });
    } catch (error) {
        if (error instanceof AcpEnvironmentVariableError) {
            throw new Error(t('acpmgr.error.missingEnvironment', { name: error.variableName }));
        }
        throw error;
    }
}
