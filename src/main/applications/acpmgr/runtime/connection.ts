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
    ClientSideConnection,
    ndJsonStream,
    type Agent,
    type Client,
    type CreateTerminalRequest,
    type CreateTerminalResponse,
    type KillTerminalRequest,
    type KillTerminalResponse,
    type ReadTextFileRequest,
    type ReadTextFileResponse,
    type ReleaseTerminalRequest,
    type ReleaseTerminalResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type TerminalOutputRequest,
    type TerminalOutputResponse,
    type WaitForTerminalExitRequest,
    type WaitForTerminalExitResponse,
    type WriteTextFileRequest,
    type WriteTextFileResponse
} from '@agentclientprotocol/sdk';
import {
    createHttpStream,
    MemoryAcpCookieStore,
    type AcpCookieStore
} from '@agentclientprotocol/sdk/experimental/http-client';
import {
    ndJsonStream as ndJsonStreamV2,
    type ConnectMcpRequest as ConnectMcpRequestV2,
    type ConnectMcpResponse as ConnectMcpResponseV2,
    type DisconnectMcpRequest as DisconnectMcpRequestV2,
    type DisconnectMcpResponse as DisconnectMcpResponseV2,
    type MessageMcpNotification as MessageMcpNotificationV2,
    type MessageMcpRequest as MessageMcpRequestV2
} from '@agentclientprotocol/sdk/experimental/v2';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { AcpEnvironmentVariableError, resolveAcpTemplate, resolveAcpTemplateRecord } from './profile.js';
import type { AcpAgentProfile } from '../common.js';
import { t } from '../../../../locale/index.js';
import { getPlatform } from '../../../../platforms/base.js';
import { logger } from '../../../utils/logger.js';
import type { AcpMcpPeer } from './client-hosted-mcp.js';
import { createV2ConnectionHandle } from './connection-v2.js';

export interface AcpClientHandlers {
    sessionUpdate(params: SessionNotification): Promise<void>;
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
    readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
    createTerminal?(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
    terminalOutput?(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
    releaseTerminal?(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse>;
    waitForTerminalExit?(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
    killTerminal?(params: KillTerminalRequest): Promise<KillTerminalResponse>;
    clientMcpServer?: { name: string; serverId: string };
    connectMcp?(params: ConnectMcpRequestV2, peer: AcpMcpPeer): Promise<ConnectMcpResponseV2>;
    messageMcp?(params: MessageMcpRequestV2): Promise<unknown>;
    notifyMcp?(params: MessageMcpNotificationV2): Promise<void>;
    disconnectMcp?(params: DisconnectMcpRequestV2): Promise<DisconnectMcpResponseV2>;
}

export type AcpClientConnection = Pick<
    Agent,
    | 'initialize'
    | 'newSession'
    | 'loadSession'
    | 'resumeSession'
    | 'setSessionMode'
    | 'setSessionConfigOption'
    | 'prompt'
    | 'cancel'
> &
    Partial<Pick<Agent, 'closeSession'>>;

export interface AcpConnectionHandle {
    connection: AcpClientConnection;
    closed: Promise<void>;
    close(): Promise<void>;
}

export type AcpConnectionFactory = (
    profile: AcpAgentProfile,
    handlers: AcpClientHandlers,
    workspace: string
) => Promise<AcpConnectionHandle>;

export const ACP_ACTIVE_PROFILE_IDS_ENV = 'OPENDESK_ACP_ACTIVE_PROFILE_IDS';

// stdio ACP servers inherit this chain so an OpenDesk-backed agent cannot dispatch itself recursively.
export function getActiveAcpProfileIds(environ: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const value = environ[ACP_ACTIVE_PROFILE_IDS_ENV];
    if (!value) return new Set();
    try {
        const parsed = JSON.parse(value);
        return new Set(
            Array.isArray(parsed)
                ? parsed.filter(
                      (profileId): profileId is string => typeof profileId === 'string' && profileId.length > 0
                  )
                : []
        );
    } catch {
        return new Set();
    }
}

export function addActiveAcpProfile(environ: NodeJS.ProcessEnv, profileId: string): NodeJS.ProcessEnv {
    const activeProfileIds = [...getActiveAcpProfileIds(environ)];
    if (!activeProfileIds.includes(profileId)) {
        activeProfileIds.push(profileId);
    }
    return {
        ...environ,
        [ACP_ACTIVE_PROFILE_IDS_ENV]: JSON.stringify(activeProfileIds)
    };
}

function mergedProcessEnvironment(profile: AcpAgentProfile): NodeJS.ProcessEnv {
    const injected = Object.fromEntries(getPlatform().getInjectedEnviron());
    if (profile.transport.type !== 'stdio') return { ...process.env, ...injected };
    const base = profile.transport.inheritEnv ? process.env : {};
    const templateEnvironment = { ...process.env, ...injected };
    return {
        ...base,
        ...injected,
        ...resolveAcpTemplateRecord(profile.transport.env, templateEnvironment)
    };
}

function createLegacyClient(profile: AcpAgentProfile, handlers: AcpClientHandlers): Client {
    const exposeWorkspaceRuntime = profile.execution.location === 'client';
    return {
        sessionUpdate: (params) => handlers.sessionUpdate(params),
        requestPermission: (params) => handlers.requestPermission(params),
        ...(exposeWorkspaceRuntime && handlers.readTextFile
            ? { readTextFile: (params) => handlers.readTextFile!(params) }
            : {}),
        ...(exposeWorkspaceRuntime && handlers.writeTextFile
            ? { writeTextFile: (params) => handlers.writeTextFile!(params) }
            : {}),
        ...(exposeWorkspaceRuntime && handlers.createTerminal
            ? { createTerminal: (params) => handlers.createTerminal!(params) }
            : {}),
        ...(exposeWorkspaceRuntime && handlers.terminalOutput
            ? { terminalOutput: (params) => handlers.terminalOutput!(params) }
            : {}),
        ...(exposeWorkspaceRuntime && handlers.releaseTerminal
            ? { releaseTerminal: (params) => handlers.releaseTerminal!(params) }
            : {}),
        ...(exposeWorkspaceRuntime && handlers.waitForTerminalExit
            ? { waitForTerminalExit: (params) => handlers.waitForTerminalExit!(params) }
            : {}),
        ...(exposeWorkspaceRuntime && handlers.killTerminal
            ? { killTerminal: (params) => handlers.killTerminal!(params) }
            : {})
    };
}

function createStdioHandle(
    profile: AcpAgentProfile,
    handlers: AcpClientHandlers,
    workspace: string
): AcpConnectionHandle {
    if (profile.transport.type !== 'stdio') {
        throw new Error('Expected an ACP stdio profile');
    }
    const environ = addActiveAcpProfile(mergedProcessEnvironment(profile), profile.id);
    const command = resolveAcpTemplate(profile.transport.command, environ);
    const args = profile.transport.args.map((argument) => resolveAcpTemplate(argument, environ));
    const cwd = path.resolve(
        profile.transport.cwd === 'fixed' ? (profile.transport.fixedCwd as string) : workspace || process.cwd()
    );
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
        cwd,
        env: environ,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        const message = chunk.trim();
        if (message) logger.warn(`[ACP ${profile.name}] ${message.slice(0, 4_096)}`);
    });

    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    let protocolHandle: AcpConnectionHandle;
    if (profile.protocolVersion === 2) {
        protocolHandle = createV2ConnectionHandle(profile, handlers, ndJsonStreamV2(output, input));
    } else {
        const stream = ndJsonStream(output, input);
        const connection = new ClientSideConnection(() => createLegacyClient(profile, handlers), stream);
        protocolHandle = {
            connection,
            closed: connection.closed,
            close: async () => {
                try {
                    await stream.writable.close();
                } catch {
                    // The stream may already be closed after an agent disconnect.
                }
            }
        };
    }
    const processClosed = new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.once('error', () => resolve());
    });
    return {
        connection: protocolHandle.connection,
        closed: Promise.race([protocolHandle.closed, processClosed]),
        close: async () => {
            try {
                await protocolHandle.close();
            } finally {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill();
                }
            }
        }
    };
}

function createHttpHandle(
    profile: AcpAgentProfile,
    handlers: AcpClientHandlers,
    cookieStore: AcpCookieStore
): AcpConnectionHandle {
    if (profile.transport.type !== 'streamableHttp') {
        throw new Error('Expected an ACP Streamable HTTP profile');
    }
    const environ = { ...process.env, ...Object.fromEntries(getPlatform().getInjectedEnviron()) };
    const headers = resolveAcpTemplateRecord(profile.transport.headers, environ);
    const stream = createHttpStream(profile.transport.url, {
        headers,
        cookies: profile.transport.cookies,
        cookieStore,
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
            const target = input instanceof Request ? input.url : input;
            return getPlatform().fetch(target, init, { forceEnvironmentProxy: true });
        }) as typeof globalThis.fetch
    });
    if (profile.protocolVersion === 2) {
        return createV2ConnectionHandle(profile, handlers, stream);
    }
    const connection = new ClientSideConnection(() => createLegacyClient(profile, handlers), stream);
    return {
        connection,
        closed: connection.closed,
        close: async () => {
            try {
                await stream.writable.close();
            } catch {
                // The stream may already be closed after an agent disconnect.
            }
        }
    };
}

export function createDefaultAcpConnectionFactory(): AcpConnectionFactory {
    const cookieStore = new MemoryAcpCookieStore();
    return async (profile, handlers, workspace) => {
        try {
            return profile.transport.type === 'stdio'
                ? createStdioHandle(profile, handlers, workspace)
                : createHttpHandle(profile, handlers, cookieStore);
        } catch (error) {
            if (error instanceof AcpEnvironmentVariableError) {
                throw new Error(t('acpmgr.error.missingEnvironment', { name: error.variableName }));
            }
            throw error;
        }
    };
}
