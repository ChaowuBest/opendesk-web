/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { SpeechKit, PeekResult } from '../common.js';
import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../../main/utils/logger.js';
import type { ChildProcessWithoutNullStreams } from 'child_process';

const HELPER_RELATIVE_DIR = path.join('native', 'darwin', 'speech-helper');
const HELPER_BINARY_FILE = 'opendesk-speech-helper';
// TCC on macOS 26+ requires the helper to be inside an .app bundle so that
// privacy usage descriptions in Contents/Info.plist are recognised.
const HELPER_APP_BINARY = path.join('opendesk-speech-helper.app', 'Contents', 'MacOS', HELPER_BINARY_FILE);

interface HelperResponse {
    id?: number;
    ok?: boolean;
    data?: unknown;
    message?: string;
    available?: boolean;
}

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

type HelperPayload = Record<string, unknown>;

class DarwinSpeechHelperClient {
    private proc: ChildProcessWithoutNullStreams;
    private pendingCalls = new Map<number, PendingCall>();
    private nextId = 1;
    private stdoutBuffer = '';
    private disposed = false;

    constructor(private readonly binaryPath: string) {
        this.proc = spawn(binaryPath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env
        });

        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (chunk) => this.handleStdout(chunk));
        this.proc.stderr.setEncoding('utf8');
        this.proc.stderr.on('data', (chunk) => {
            const text = chunk.trim();
            if (text) {
                logger.warn(`[darwin-speech] helper stderr: ${text}`);
            }
        });
        this.proc.on('error', (err) => this.rejectAll(err));
        this.proc.on('exit', (code, signal) => {
            if (!this.disposed) {
                this.rejectAll(new Error(`Darwin speech helper exited with code=${code} signal=${signal}`));
            }
        });
    }

    call(method: string, timeoutMs = 10000, payload: HelperPayload = {}): Promise<unknown> {
        if (this.disposed || this.proc.killed) {
            return Promise.reject(new Error('Darwin speech helper is not running'));
        }

        const id = this.nextId++;
        const command = JSON.stringify({ id, method, ...payload }) + '\n';

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCalls.delete(id);
                reject(new Error(`Darwin speech helper timed out while handling ${method}`));
            }, timeoutMs);
            this.pendingCalls.set(id, { resolve, reject, timer });
            this.proc.stdin.write(command, 'utf8', (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingCalls.delete(id);
                    reject(err);
                }
            });
        });
    }

    dispose(): void {
        this.disposed = true;
        for (const [id, pending] of this.pendingCalls) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Darwin speech helper was disposed'));
            this.pendingCalls.delete(id);
        }
        if (!this.proc.killed) {
            this.proc.kill();
        }
    }

    private handleStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        let newlineIndex = this.stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            if (line) {
                this.handleLine(line);
            }
            newlineIndex = this.stdoutBuffer.indexOf('\n');
        }
    }

    private handleLine(line: string): void {
        let response: HelperResponse;
        try {
            response = JSON.parse(line);
        } catch {
            logger.warn(`[darwin-speech] invalid helper response: ${line}`);
            return;
        }

        if (typeof response.id !== 'number') {
            return;
        }
        const pending = this.pendingCalls.get(response.id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pendingCalls.delete(response.id);

        if (response.ok) {
            pending.resolve(response.data);
        } else {
            pending.reject(new Error(response.message || 'Darwin speech helper call failed'));
        }
    }

    private rejectAll(err: Error): void {
        for (const [id, pending] of this.pendingCalls) {
            clearTimeout(pending.timer);
            pending.reject(err);
            this.pendingCalls.delete(id);
        }
    }
}

export class DarwinSpeechKit implements SpeechKit {
    private helperClient: DarwinSpeechHelperClient | null = null;
    private availabilityCache: boolean | null = null;
    private initialized = false;
    private initializedLocale: string | null = null;
    private initializePromise: Promise<void> | null = null;
    private initializingLocale: string | null = null;

    async available(): Promise<boolean> {
        if (process.platform !== 'darwin') {
            return false;
        }
        if (this.availabilityCache !== null) {
            return this.availabilityCache;
        }

        try {
            const helperPath = await this.ensureHelperBinary();
            this.availabilityCache = await runHelperAvailabilityCheck(helperPath);
        } catch (err) {
            logger.warn('[darwin-speech] helper availability check failed', err);
            this.availabilityCache = false;
        }
        return this.availabilityCache;
    }

    async initialize(locale?: string | null): Promise<void> {
        const normalizedLocale = normalizeSpeechLocale(locale);
        if (this.initialized && this.initializedLocale === normalizedLocale) {
            return;
        }
        if (!this.initializePromise || this.initializingLocale !== normalizedLocale) {
            this.initializingLocale = normalizedLocale;
            this.initializePromise = (async () => {
                const helper = await this.ensureHelperClient();
                await helper.call('initialize', 60000, normalizedLocale ? { locale: normalizedLocale } : {});
                this.initialized = true;
                this.initializedLocale = normalizedLocale;
            })().finally(() => {
                this.initializePromise = null;
                this.initializingLocale = null;
            });
        }
        return this.initializePromise;
    }

    async start(): Promise<void> {
        await this.initialize();
        const helper = await this.ensureHelperClient();
        await helper.call('start', 10000);
    }

    async peek(): Promise<PeekResult> {
        const helper = await this.ensureHelperClient();
        const result = await helper.call('peek', 1000);
        if (!isPeekResult(result)) {
            throw new Error('Invalid peek result from Darwin speech helper');
        }
        return result;
    }

    async stop(): Promise<string> {
        const helper = await this.ensureHelperClient();
        try {
            const result = await helper.call('stop', 3000);
            return typeof result === 'string' ? result : '';
        } catch (err) {
            logger.warn('[darwin-speech] stop failed, disposing helper', err);
            this.helperClient = null;
            this.initialized = false;
            this.initializedLocale = null;
            this.initializePromise = null;
            this.initializingLocale = null;
            helper.dispose();
            return '';
        }
    }

    async release(): Promise<void> {
        const helper = this.helperClient;
        this.helperClient = null;
        if (!helper) {
            return;
        }
        try {
            await helper.call('release', 1500);
        } finally {
            this.initialized = false;
            this.initializedLocale = null;
            this.initializePromise = null;
            this.initializingLocale = null;
            helper.dispose();
        }
    }

    private async ensureHelperClient(): Promise<DarwinSpeechHelperClient> {
        if (this.helperClient) {
            return this.helperClient;
        }
        const helperPath = await this.ensureHelperBinary();
        this.helperClient = new DarwinSpeechHelperClient(helperPath);
        return this.helperClient;
    }

    private async ensureHelperBinary(): Promise<string> {
        return resolveHelperBinaryPath();
    }
}

function normalizeSpeechLocale(locale?: string | null): string | null {
    if (typeof locale !== 'string') {
        return null;
    }
    const normalized = locale.trim();
    return normalized && normalized !== 'auto' ? normalized : null;
}

function resolveHelperBinaryPath(): string {
    const candidates = app.isPackaged
        ? [
              path.join(process.resourcesPath, HELPER_RELATIVE_DIR, HELPER_APP_BINARY),
              path.join(process.resourcesPath, HELPER_RELATIVE_DIR, HELPER_BINARY_FILE)
          ]
        : [
              path.join(process.cwd(), HELPER_RELATIVE_DIR, HELPER_APP_BINARY),
              path.join(app.getAppPath(), HELPER_RELATIVE_DIR, HELPER_APP_BINARY),
              path.join(process.cwd(), HELPER_RELATIVE_DIR, HELPER_BINARY_FILE),
              path.join(app.getAppPath(), HELPER_RELATIVE_DIR, HELPER_BINARY_FILE)
          ];

    for (const candidate of candidates) {
        if (isExecutable(candidate)) {
            return candidate;
        }
    }
    throw new Error(
        `Darwin speech helper binary was not found. Run node scripts/build-darwin-speech-helper.cjs before starting OpenDesk. Checked: ${candidates.join(', ')}`
    );
}

function isExecutable(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function runHelperAvailabilityCheck(helperPath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const child = spawn(helperPath, ['--check'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Darwin speech helper availability check timed out'));
        }, 5000);

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `Darwin speech helper exited with code ${code}`));
                return;
            }
            try {
                const response = JSON.parse(stdout.trim()) as HelperResponse;
                resolve(response.available === true);
            } catch (err) {
                reject(err instanceof Error ? err : new Error('Invalid availability response'));
            }
        });
    });
}

function isPeekResult(value: unknown): value is PeekResult {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<PeekResult>;
    return typeof candidate.content === 'string' && typeof candidate.finished === 'boolean';
}
