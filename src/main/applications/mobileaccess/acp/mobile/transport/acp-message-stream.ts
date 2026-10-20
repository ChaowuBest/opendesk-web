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

import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';

export type AcpMessageListener = (message: string) => void;
export type AcpMessageChannelCloseListener = (error?: Error) => void;

export interface AcpMessageChannel {
    send(message: string): void | Promise<void>;
    onMessage(listener: AcpMessageListener): () => void;
    onClose(listener: AcpMessageChannelCloseListener): () => void;
    close(): void;
}

export class AcpConnectionClosedError extends Error {
    constructor(message = 'ACP connection closed') {
        super(message);
        this.name = 'AcpConnectionClosedError';
    }
}

export class AcpProtocolMessageError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'AcpProtocolMessageError';
    }
}

export interface AcpStreamConstructors {
    ReadableStream: typeof ReadableStream;
    WritableStream: typeof WritableStream;
}

export interface AcpMessageStreamBinding {
    readonly stream: Stream;
    disconnect(error?: Error): void;
}

function isAcpEnvelope(value: unknown): value is AnyMessage {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        'jsonrpc' in value &&
        value.jsonrpc === '2.0'
    );
}

export function createAcpMessageStream(
    channel: AcpMessageChannel,
    scope: AbortController,
    constructors: AcpStreamConstructors = { ReadableStream, WritableStream }
): AcpMessageStreamBinding {
    let controller!: ReadableStreamDefaultController<AnyMessage>;
    let ended = false;
    let detached = false;
    let removeMessageListener = (): void => undefined;
    let removeCloseListener = (): void => undefined;

    const detach = (): void => {
        if (detached) return;
        detached = true;
        removeMessageListener();
        removeCloseListener();
    };
    // Construction never hands a binding back, so a throwing unsubscribe must not strand the other listener.
    const detachAfterConstructionFailure = (): void => {
        if (detached) return;
        detached = true;
        for (const remove of [removeMessageListener, removeCloseListener]) {
            try {
                remove();
            } catch {}
        }
    };
    const abortScope = (error: Error): void => {
        if (!scope.signal.aborted) scope.abort(error);
    };
    const endReadable = (error?: Error): void => {
        if (ended) return;
        ended = true;
        if (error) controller.error(error);
        else controller.close();
    };
    const failProtocol = (message: string, cause?: unknown): void => {
        const error = new AcpProtocolMessageError(message, { cause });
        detach();
        abortScope(error);
        endReadable(error);
        channel.close();
    };

    let readable: ReadableStream<AnyMessage>;
    let writable: WritableStream<AnyMessage>;
    try {
        readable = new constructors.ReadableStream<AnyMessage>({
            start(readableController) {
                controller = readableController;
                removeMessageListener = channel.onMessage((text) => {
                    if (ended) return;
                    try {
                        const message: unknown = JSON.parse(text);
                        if (!isAcpEnvelope(message)) {
                            failProtocol('Text message is not an ACP JSON-RPC 2.0 envelope');
                            return;
                        }
                        controller.enqueue(message);
                    } catch (error) {
                        failProtocol('Text message is not valid JSON', error);
                    }
                });
                removeCloseListener = channel.onClose((error) => {
                    detach();
                    abortScope(error ?? new AcpConnectionClosedError('ACP transport closed'));
                    endReadable(error);
                });
            }
        });

        writable = new constructors.WritableStream<AnyMessage>({
            async write(message) {
                if (ended || scope.signal.aborted) {
                    throw scope.signal.reason ?? new AcpConnectionClosedError();
                }
                try {
                    await channel.send(JSON.stringify(message));
                } catch (error) {
                    const failure = error instanceof Error ? error : new Error(String(error));
                    detach();
                    abortScope(failure);
                    endReadable(failure);
                    throw failure;
                }
            },
            abort(reason) {
                const failure = reason instanceof Error ? reason : new AcpConnectionClosedError(String(reason));
                detach();
                abortScope(failure);
                endReadable(failure);
                channel.close();
            }
        });
    } catch (error) {
        detachAfterConstructionFailure();
        throw error;
    }

    return {
        stream: { readable, writable },
        disconnect(error = new AcpConnectionClosedError()) {
            detach();
            abortScope(error);
            endReadable(error);
        }
    };
}
