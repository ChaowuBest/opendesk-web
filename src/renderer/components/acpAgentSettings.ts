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

export type AcpAgentFormErrorCode =
    | 'nameRequired'
    | 'commandRequired'
    | 'argsInvalid'
    | 'envInvalid'
    | 'fixedCwdRequired'
    | 'urlInvalid'
    | 'headersInvalid'
    | 'remoteCwdRequired'
    | 'mappingRootsRequired'
    | 'clientFixedCwdRequired'
    | 'workspacePathInvalid'
    | 'configOptionsInvalid'
    | 'reconnectInvalid';

export class AcpAgentFormError extends Error {
    constructor(public readonly code: AcpAgentFormErrorCode) {
        super(code);
        this.name = 'AcpAgentFormError';
    }
}

export type AcpAgentFormValues = {
    id?: string;
    name: string;
    enabled: boolean;
    dispatchable: boolean;
    whenToUse: string;
    transportType: string;
    command: string;
    argsJson: string;
    cwd: string;
    fixedCwd: string;
    envJson: string;
    inheritEnv: boolean;
    url: string;
    headersJson: string;
    cookies: string;
    modeId: string;
    configOptionsJson: string;
    mcpServerIds: string;
    executionLocation: string;
    agentWorkspaceStrategy: string;
    remotePlatform: string;
    remoteCwd: string;
    mappingLocalRoot: string;
    mappingRemoteRoot: string;
    clientWorkspaceStrategy: string;
    clientFixedCwd: string;
    clientCompatibility: string;
    reconnectEnabled: boolean;
    maxAttempts: string;
    initialDelayMs: string;
    maxDelayMs: string;
};

export type AcpAgentSettingsProfile = {
    id: string;
    name: string;
    enabled: boolean;
    dispatchable: boolean;
    whenToUse: string;
    transport:
        | {
              type: 'stdio';
              command: string;
              args: string[];
              cwd: 'workspace' | 'fixed';
              fixedCwd?: string;
              env: Record<string, string>;
              inheritEnv: boolean;
          }
        | {
              type: 'streamableHttp';
              url: string;
              headers: Record<string, string>;
              cookies: 'include' | 'omit';
          };
    session: {
        modeId?: string;
        configOptions: Record<string, string | boolean>;
        mcpBindings: Array<{ serverId: string; location: 'agent' | 'client' }>;
    };
    execution:
        | {
              location: 'agent';
              workspace:
                  | { strategy: 'fixed'; path: string; platform: 'posix' | 'windows' }
                  | {
                        strategy: 'mapped';
                        localRoot: string;
                        remoteRoot: string;
                        platform: 'posix' | 'windows';
                    };
          }
        | {
              location: 'client';
              workspace: { strategy: 'task' } | { strategy: 'fixed'; path: string };
              compatibility: 'preferred' | 'required';
          };
    reconnect: {
        enabled: boolean;
        maxAttempts: number;
        initialDelayMs: number;
        maxDelayMs: number;
    };
};

function parseJson(value: string, errorCode: AcpAgentFormErrorCode): unknown {
    try {
        return JSON.parse(value.trim() || '{}');
    } catch {
        throw new AcpAgentFormError(errorCode);
    }
}

function parseStringRecord(value: string, errorCode: AcpAgentFormErrorCode): Record<string, string> {
    const parsed = parseJson(value, errorCode);
    if (
        !parsed ||
        Array.isArray(parsed) ||
        typeof parsed !== 'object' ||
        Object.values(parsed).some((entry) => typeof entry !== 'string')
    ) {
        throw new AcpAgentFormError(errorCode);
    }
    return parsed as Record<string, string>;
}

function parseConfigOptions(value: string): Record<string, string | boolean> {
    const parsed = parseJson(value, 'configOptionsInvalid');
    if (
        !parsed ||
        Array.isArray(parsed) ||
        typeof parsed !== 'object' ||
        Object.values(parsed).some((entry) => typeof entry !== 'string' && typeof entry !== 'boolean')
    ) {
        throw new AcpAgentFormError('configOptionsInvalid');
    }
    return parsed as Record<string, string | boolean>;
}

function parseReconnectInteger(value: string, minimum: number, maximum: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new AcpAgentFormError('reconnectInvalid');
    }
    return parsed;
}

function isAbsolutePath(value: string): boolean {
    return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isAbsoluteRemotePath(value: string, platform: 'posix' | 'windows'): boolean {
    return platform === 'windows' ? /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/');
}

export function buildAcpAgentProfile(
    form: AcpAgentFormValues,
    idFactory: () => string = () => crypto.randomUUID()
): AcpAgentSettingsProfile {
    const name = form.name.trim();
    if (!name) throw new AcpAgentFormError('nameRequired');

    let transport: AcpAgentSettingsProfile['transport'];
    if (form.transportType === 'streamableHttp') {
        let url: URL;
        try {
            url = new URL(form.url.trim());
        } catch {
            throw new AcpAgentFormError('urlInvalid');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new AcpAgentFormError('urlInvalid');
        }
        transport = {
            type: 'streamableHttp',
            url: url.toString(),
            headers: parseStringRecord(form.headersJson, 'headersInvalid'),
            cookies: form.cookies === 'omit' ? 'omit' : 'include'
        };
    } else {
        const command = form.command.trim();
        if (!command) throw new AcpAgentFormError('commandRequired');
        const args = parseJson(form.argsJson, 'argsInvalid');
        if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
            throw new AcpAgentFormError('argsInvalid');
        }
        const cwd = form.cwd === 'fixed' ? 'fixed' : 'workspace';
        const fixedCwd = form.fixedCwd.trim();
        if (cwd === 'fixed' && !fixedCwd) throw new AcpAgentFormError('fixedCwdRequired');
        transport = {
            type: 'stdio',
            command,
            args,
            cwd,
            ...(cwd === 'fixed' ? { fixedCwd } : {}),
            env: parseStringRecord(form.envJson, 'envInvalid'),
            inheritEnv: form.inheritEnv
        };
    }

    const modeId = form.modeId.trim();
    let execution: AcpAgentSettingsProfile['execution'];
    if (form.executionLocation === 'agent') {
        const platform = form.remotePlatform === 'windows' ? 'windows' : 'posix';
        if (form.agentWorkspaceStrategy === 'mapped') {
            const localRoot = form.mappingLocalRoot.trim();
            const remoteRoot = form.mappingRemoteRoot.trim();
            if (!localRoot || !remoteRoot) throw new AcpAgentFormError('mappingRootsRequired');
            if (!isAbsolutePath(localRoot) || !isAbsoluteRemotePath(remoteRoot, platform)) {
                throw new AcpAgentFormError('workspacePathInvalid');
            }
            execution = {
                location: 'agent',
                workspace: { strategy: 'mapped', localRoot, remoteRoot, platform }
            };
        } else {
            const remoteCwd = form.remoteCwd.trim();
            if (!remoteCwd) throw new AcpAgentFormError('remoteCwdRequired');
            if (!isAbsoluteRemotePath(remoteCwd, platform)) throw new AcpAgentFormError('workspacePathInvalid');
            execution = {
                location: 'agent',
                workspace: { strategy: 'fixed', path: remoteCwd, platform }
            };
        }
    } else {
        const strategy = form.clientWorkspaceStrategy === 'fixed' ? 'fixed' : 'task';
        const fixedPath = form.clientFixedCwd.trim();
        if (strategy === 'fixed' && !fixedPath) throw new AcpAgentFormError('clientFixedCwdRequired');
        if (strategy === 'fixed' && !isAbsolutePath(fixedPath)) {
            throw new AcpAgentFormError('workspacePathInvalid');
        }
        execution = {
            location: 'client',
            workspace: strategy === 'fixed' ? { strategy, path: fixedPath } : { strategy },
            compatibility: form.clientCompatibility === 'required' ? 'required' : 'preferred'
        };
    }
    return {
        id: form.id?.trim() || idFactory(),
        name,
        enabled: form.enabled,
        dispatchable: form.dispatchable,
        whenToUse: form.whenToUse.trim(),
        transport,
        execution,
        session: {
            ...(modeId ? { modeId } : {}),
            configOptions: parseConfigOptions(form.configOptionsJson),
            mcpBindings: form.mcpServerIds
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean)
                .map((serverId) => ({ serverId, location: 'agent' }))
        },
        reconnect: {
            enabled: form.reconnectEnabled,
            maxAttempts: parseReconnectInteger(form.maxAttempts, 0, 20),
            initialDelayMs: parseReconnectInteger(form.initialDelayMs, 0, 60_000),
            maxDelayMs: parseReconnectInteger(form.maxDelayMs, 0, 300_000)
        }
    };
}
