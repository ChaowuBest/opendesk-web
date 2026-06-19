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

import process from 'process';

type StdoutWrite = typeof process.stdout.write;
type WriteCallback = (err?: Error | null) => void;

let originalStdoutWrite: StdoutWrite | null = null;
let stdoutGuardInstalled = false;
let processErrorHandlersInstalled = false;

function getOriginalStdoutWrite(): StdoutWrite {
    if (!originalStdoutWrite) {
        originalStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;
    }
    return originalStdoutWrite;
}

function toText(chunk: unknown, encoding?: BufferEncoding): string {
    if (typeof chunk === 'string') {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk).toString(encoding || 'utf8');
    }
    return String(chunk);
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}

export function installAcpStdoutGuard(): void {
    if (stdoutGuardInstalled) {
        return;
    }

    getOriginalStdoutWrite();
    const stderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = ((
        chunk: unknown,
        encodingOrCallback?: BufferEncoding | WriteCallback,
        callback?: WriteCallback
    ) => {
        const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
        const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        const text = toText(chunk, encoding);
        if (!text) {
            cb?.();
            return true;
        }

        const suffix = text.endsWith('\n') ? '' : '\n';
        return stderrWrite(`[acp stdout redirected] ${text}${suffix}`, encoding, cb);
    }) as StdoutWrite;

    stdoutGuardInstalled = true;
}

export function installAcpProcessErrorHandlers(): void {
    if (processErrorHandlersInstalled) {
        return;
    }

    process.on('unhandledRejection', (reason) => {
        process.stderr.write(`[acp] unhandled rejection: ${formatError(reason)}\n`);
    });
    process.on('uncaughtException', (err) => {
        process.stderr.write(`[acp] uncaught exception: ${formatError(err)}\n`);
        process.exit(1);
    });

    processErrorHandlersInstalled = true;
}

export function createAcpProtocolOutput(): WritableStream<Uint8Array> {
    const write = getOriginalStdoutWrite();
    return new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                try {
                    write(chunk, (err?: Error | null) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                } catch (err) {
                    reject(err);
                }
            });
        }
    });
}
