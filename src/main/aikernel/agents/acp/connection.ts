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
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification
} from '@agentclientprotocol/sdk';
import {
    createHttpStream,
    MemoryAcpCookieStore,
    type AcpCookieStore
} from '@agentclientprotocol/sdk/experimental/http-client';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import {
    AcpEnvironmentVariableError,
    resolveAcpTemplate,
    resolveAcpTemplateRecord,
    type AcpAgentProfile
} from '../../../../common/acp.js';
import { t } from '../../../../locale/index.js';
import { getPlatform } from '../../../../platforms/base.js';
import { logger } from '../../../utils/logger.js';

export interface AcpClientHandlers {
    sessionUpdate(params: SessionNotification): Promise<void>;
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
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

function createLegacyClient(handlers: AcpClientHandlers): Client {
    return {
        sessionUpdate: (params) => handlers.sessionUpdate(params),
        requestPermission: (params) => handlers.requestPermission(params)
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

    const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = new ClientSideConnection(() => createLegacyClient(handlers), stream);
    const processClosed = new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.once('error', () => resolve());
    });
    return {
        connection,
        closed: Promise.race([connection.closed, processClosed]),
        close: async () => {
            try {
                await stream.writable.close();
            } catch {
                // The stream may already be closed after an agent disconnect.
            }
            if (child.exitCode === null && child.signalCode === null) {
                child.kill();
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
    const connection = new ClientSideConnection(() => createLegacyClient(handlers), stream);
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
