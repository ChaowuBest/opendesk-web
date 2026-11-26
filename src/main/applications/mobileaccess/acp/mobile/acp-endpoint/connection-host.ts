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
import type { Agent, AgentSideConnection } from '@agentclientprotocol/sdk';
import {
    MobileAcpAgentAdapter,
    type MobileAcpDiagnosticSink,
    type MobileInteractionAgentServices
} from './agent-adapter.js';
import type { RemoteSessionService } from '../remote-session-service/service.js';
import {
    AcpConnectionClosedError,
    createAcpMessageStream,
    type AcpMessageChannel,
    type AcpMessageStreamBinding
} from '../transport/acp-message-stream.js';

export interface MobileAcpAdapterFactoryArgs<TTrustedContext extends object> {
    connection: AgentSideConnection;
    trustedContext: TTrustedContext;
    signal: AbortSignal;
    failClosed(): void;
    registerCleanup(callback: () => void): void;
}

export type MobileAcpAdapterFactory<TTrustedContext extends object> = (
    args: MobileAcpAdapterFactoryArgs<TTrustedContext>
) => Agent;

export interface HostedAcpConnection {
    readonly closed: Promise<void>;
    close(): Promise<void>;
}

export interface MobileAcpConnectionHostOptions<TTrustedContext extends object> {
    remoteSessionService: RemoteSessionService;
    diagnose: MobileAcpDiagnosticSink;
    agentVersion?: string;
    adapterFactory?: MobileAcpAdapterFactory<TTrustedContext>;
    mobileInteractions?: MobileInteractionAgentServices;
}

interface HostedRecord {
    channel: AcpMessageChannel;
    scope: AbortController;
    binding: AcpMessageStreamBinding;
    connection: AgentSideConnection;
}

export class MobileAcpConnectionHost<TTrustedContext extends object = object> {
    private readonly handles = new Set<HostedAcpConnection>();
    private readonly adapterFactory: MobileAcpAdapterFactory<TTrustedContext>;

    constructor(options: MobileAcpConnectionHostOptions<TTrustedContext>) {
        this.adapterFactory =
            options.adapterFactory ??
            ((args) =>
                new MobileAcpAgentAdapter(
                    args.connection,
                    args.signal,
                    options.remoteSessionService,
                    options.diagnose,
                    args.failClosed,
                    args.registerCleanup,
                    options.agentVersion,
                    undefined,
                    options.mobileInteractions
                ));
    }

    open(channel: AcpMessageChannel, trustedContext: TTrustedContext): HostedAcpConnection {
        const scope = new AbortController();
        const cleanups = new Set<() => void>();
        let binding: AcpMessageStreamBinding | undefined;
        let closing = false;
        let channelClosed = false;
        const closeChannel = (): void => {
            if (channelClosed) return;
            channelClosed = true;
            channel.close();
        };
        const runCleanups = (): void => {
            for (const cleanup of cleanups) {
                try {
                    cleanup();
                } catch {}
            }
            cleanups.clear();
        };
        // The caller never receives a handle when construction fails, so every resource this scope already
        // acquired is released here; each step is attempted independently and none may replace the cause.
        const abandonConstruction = (cause: unknown): void => {
            closing = true;
            runCleanups();
            const failure = cause instanceof Error ? cause : new AcpConnectionClosedError(String(cause));
            try {
                scope.abort(failure);
            } catch {}
            try {
                binding?.disconnect(failure);
            } catch {}
            try {
                closeChannel();
            } catch {}
        };

        try {
            binding = createAcpMessageStream(channel, scope);
        } catch (error) {
            abandonConstruction(error);
            throw error;
        }
        const failClosed = (): void => {
            if (closing) return;
            closing = true;
            runCleanups();
            const error = new AcpConnectionClosedError('ACP feed unavailable');
            scope.abort(error);
            binding.disconnect(error);
            closeChannel();
        };
        const registerCleanup = (callback: () => void): void => {
            if (closing) {
                try {
                    callback();
                } catch {}
                return;
            }
            cleanups.add(callback);
        };
        let connection: AgentSideConnection;
        try {
            connection = new acp.AgentSideConnection(
                (sdkConnection) =>
                    this.adapterFactory({
                        connection: sdkConnection,
                        trustedContext,
                        signal: scope.signal,
                        failClosed,
                        registerCleanup
                    }),
                binding.stream
            );
        } catch (error) {
            abandonConstruction(error);
            throw error;
        }
        const record: HostedRecord = { channel, scope, binding, connection };
        let closePromise: Promise<void> | undefined;
        const closed = connection.closed.then(() => {
            closing = true;
            runCleanups();
            const error =
                connection.signal.reason instanceof Error ? connection.signal.reason : new AcpConnectionClosedError();
            record.binding.disconnect(error);
            closeChannel();
            this.handles.delete(handle);
        });

        const handle: HostedAcpConnection = {
            closed,
            close: () => {
                closePromise ??= (async () => {
                    closing = true;
                    runCleanups();
                    record.binding.disconnect(new AcpConnectionClosedError('ACP host closed'));
                    closeChannel();
                    await closed;
                })();
                return closePromise;
            }
        };
        this.handles.add(handle);
        return handle;
    }

    async close(): Promise<void> {
        await Promise.all(Array.from(this.handles, (handle) => handle.close()));
    }
}
