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

import type { AccountChange, AccountCredentialSnapshot } from '../../account/types.js';

export interface RegistrationRuntimeOptions {
    signal: AbortSignal;
    getCredential: () => AccountCredentialSnapshot | null;
    subscribe: (listener: (change: AccountChange) => void) => () => void;
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
    deviceId: string;
    hostType: 'electron' | 'cli';
    name: string;
    runId?: string;
    now?: () => number;
    setTimeout?: (callback: () => void, delay: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    subscribePower?: (handlers: { suspend: () => void; resume: () => void }) => () => void;
    diagnose?: (event: { kind: 'failure' | 'recovered'; category?: string; count: number }) => void;
}

export interface RegistrationQualification {
    deviceId: string;
    runId: string;
    accountScope?: string;
    role: 'current' | 'standby' | null;
    generation: number;
    expiresAt: number | null;
    reason: string;
}

export interface RegistrationRuntime {
    getCredential(): RegistrationCredential | null;
    subscribeCredential(listener: () => void): () => void;
    reportCredentialFailure(credential: RegistrationCredential): void;
    getQualification(): RegistrationQualification;
    subscribeQualification(listener: (value: RegistrationQualification) => void): () => void;
    close(): Promise<void>;
    suspend(): void;
    resume(): void;
}

export interface RegistrationCredential {
    accountScope: string;
    baseUrl: string;
    accessToken: string;
    version: number;
}

export function createRegistrationRuntime(options: RegistrationRuntimeOptions): RegistrationRuntime {
    let closed = false;
    let session: AccountCredentialSnapshot | null = null;
    let epoch = 0;
    let accountGeneration = 0;
    let credentialVersion = 0;
    let closePromise: Promise<void> | undefined;
    let expiryTimer: unknown;
    let suspended = false;
    const cleanups = new Set<Promise<void>>();
    let requestController: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let runId = options.runId ?? crypto.randomUUID();
    let unregisterSession: AccountCredentialSnapshot | null = null;
    let ended = false;
    let consecutiveFailureCategory: string | undefined;
    let consecutiveFailureCount = 0;
    let qualification: RegistrationQualification = {
        deviceId: options.deviceId,
        runId,
        role: null,
        generation: 0,
        expiresAt: null,
        reason: 'unconfirmed'
    };
    const qualificationListeners = new Set<(value: RegistrationQualification) => void>();
    const credentialListeners = new Set<() => void>();
    const accountScope = () =>
        session ? `${session.baseUrl.replace(/\/+$/, '')}:${session.user.id}:${accountGeneration}` : undefined;
    const getCredential = (): RegistrationCredential | null =>
        !closed && !ended && session
            ? {
                  accountScope: accountScope()!,
                  baseUrl: session.baseUrl,
                  accessToken: session.accessToken,
                  version: credentialVersion
              }
            : null;
    const emitCredential = () => {
        credentialVersion += 1;
        for (const listener of credentialListeners) listener();
    };
    const now = options.now ?? (() => performance.now());
    const cancelTimeout =
        options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const publish = (value: RegistrationQualification) => {
        cancelTimeout(expiryTimer);
        expiryTimer = undefined;
        qualification = {
            ...value,
            accountScope: accountScope()
        };
        if (value.role !== null && value.expiresAt !== null) {
            expiryTimer = (options.setTimeout ?? setTimeout)(
                () => revoke('expired', true),
                Math.max(0, value.expiresAt - now())
            );
        }
        for (const listener of qualificationListeners) listener({ ...qualification });
    };

    const revoke = (reason: string, retainDeadline = false) => {
        publish({
            ...qualification,
            runId,
            role: null,
            generation: qualification.generation + 1,
            expiresAt: retainDeadline ? qualification.expiresAt : null,
            reason
        });
    };

    const clearTimer = () => {
        if (timer !== undefined) {
            cancelTimeout(timer);
            timer = undefined;
        }
    };

    const abortRequest = () => {
        epoch += 1;
        requestController?.abort();
        requestController = undefined;
    };

    const terminateUnauthorized = () => {
        ended = true;
        unregisterSession = null;
        abortRequest();
        clearTimer();
        revoke('unauthorized');
        emitCredential();
    };

    const request = async (
        path: string,
        body: unknown,
        token: string
    ): Promise<{ response: Response; body: unknown }> => {
        const controller = new AbortController();
        requestController = controller;
        const onAbort = () => controller.abort();
        options.signal.addEventListener('abort', onAbort, { once: true });
        const timeoutHandle = (options.setTimeout ?? setTimeout)(() => controller.abort(), 10_000);
        try {
            const aborted = new Promise<never>((_resolve, reject) =>
                controller.signal.addEventListener('abort', () => reject(new Error('registration:aborted')), {
                    once: true
                })
            );
            const operation = (async () => {
                const response = await options.fetch(`${session?.baseUrl.replace(/\/+$/, '') ?? ''}${path}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                const text = await response.text();
                let parsed: unknown = null;
                try {
                    parsed = text ? JSON.parse(text) : null;
                } catch {
                    parsed = null;
                }
                return { response, body: parsed };
            })();
            return await Promise.race([operation, aborted]);
        } finally {
            cancelTimeout(timeoutHandle);
            options.signal.removeEventListener('abort', onAbort);
            if (requestController === controller) requestController = undefined;
        }
    };

    const recordFailure = (category: string) => {
        if (consecutiveFailureCategory === category) {
            consecutiveFailureCount += 1;
            return;
        }
        consecutiveFailureCategory = category;
        consecutiveFailureCount = 1;
        options.diagnose?.({ kind: 'failure', category, count: 1 });
    };
    const recordSuccess = () => {
        if (consecutiveFailureCount > 0) {
            options.diagnose?.({ kind: 'recovered', count: consecutiveFailureCount });
        }
        consecutiveFailureCategory = undefined;
        consecutiveFailureCount = 0;
    };

    const acceptConfirmation = (requestStartedAt: number, timeoutSeconds: number) => {
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return null;
        const receivedAt = now();
        const newDeadline = requestStartedAt + timeoutSeconds * 1_000;
        if (receivedAt >= newDeadline) return null;
        if (
            qualification.expiresAt !== null &&
            receivedAt >= qualification.expiresAt &&
            requestStartedAt < qualification.expiresAt
        )
            return null;
        return newDeadline;
    };

    const schedule = (delay: number, fn: () => void) => {
        clearTimer();
        if (!closed) {
            timer = (options.setTimeout ?? setTimeout)(fn, delay) as ReturnType<typeof setTimeout>;
            (timer as unknown as { unref?: () => void }).unref?.();
        }
    };

    const register = async (expected: AccountCredentialSnapshot) => {
        if (closed || suspended || ended || requestController || session !== expected || options.signal.aborted) return;
        const requestEpoch = epoch;
        const requestStartedAt = now();
        let result: { response: Response; body: unknown };
        try {
            result = await request(
                '/devices/register',
                { device_id: options.deviceId, run_id: runId, host_type: options.hostType, name: options.name },
                expected.accessToken
            );
        } catch {
            if (closed || requestEpoch !== epoch || session !== expected) return;
            recordFailure('request');
            if (!closed && !ended && session === expected)
                schedule(30_000, () => {
                    void register(expected);
                });
            return;
        }
        if (closed || requestEpoch !== epoch || session !== expected) return;
        const { response, body: responseBody } = result;
        if (response.ok) {
            const body = responseBody as {
                device_id?: string;
                run_id?: string;
                role?: 'current' | 'standby';
                server_time?: string;
                heartbeat_interval_seconds?: number;
                registration_timeout_seconds?: number;
            };
            if (
                !body ||
                typeof body.server_time !== 'string' ||
                !/(Z|\+00:00)$/.test(body.server_time) ||
                !Number.isFinite(Date.parse(body.server_time)) ||
                body.heartbeat_interval_seconds !== 30 ||
                body.registration_timeout_seconds !== 90 ||
                body.device_id !== options.deviceId ||
                body.run_id !== runId ||
                (body.role !== 'current' && body.role !== 'standby')
            ) {
                recordFailure('protocol');
                schedule(30_000, () => {
                    void register(expected);
                });
                return;
            }
            const expiresAt = acceptConfirmation(requestStartedAt, body.registration_timeout_seconds);
            if (expiresAt === null) {
                revoke('expired', true);
                schedule(0, () => {
                    void register(expected);
                });
                return;
            }
            const generation =
                qualification.role === body.role ? qualification.generation : qualification.generation + 1;
            publish({ deviceId: options.deviceId, runId, role: body.role, generation, expiresAt, reason: 'confirmed' });
            recordSuccess();
            schedule(30_000, () => {
                void heartbeat(expected);
            });
        } else if (
            response.status === 401 ||
            (response.status === 403 && (responseBody as { detail?: unknown })?.detail === 'Account is disabled')
        ) {
            terminateUnauthorized();
        } else if (response.status === 409) {
            ended = true;
            unregisterSession = null;
            publish({
                deviceId: options.deviceId,
                runId,
                role: null,
                generation: qualification.generation + 1,
                expiresAt: null,
                reason: 'registration_ended'
            });
        } else {
            recordFailure(`http_${response.status}`);
            if (response.status >= 500 || response.status === 408 || response.status === 429)
                schedule(30_000, () => {
                    void register(expected);
                });
            else {
                ended = true;
                revoke('configuration');
            }
        }
    };

    const heartbeat = async (expected: AccountCredentialSnapshot) => {
        if (closed || suspended || ended || requestController || session !== expected || options.signal.aborted) return;
        const requestEpoch = epoch;
        const requestStartedAt = now();
        let result: { response: Response; body: unknown };
        try {
            result = await request(
                '/devices/heartbeat',
                { device_id: options.deviceId, run_id: runId },
                expected.accessToken
            );
        } catch {
            if (closed || requestEpoch !== epoch || session !== expected) return;
            recordFailure('request');
            if (!closed && !ended && session === expected)
                schedule(30_000, () => {
                    void heartbeat(expected);
                });
            return;
        }
        if (closed || requestEpoch !== epoch || session !== expected) return;
        const { response, body: responseBody } = result;
        if (response.ok) {
            const body = responseBody as {
                device_id?: string;
                run_id?: string;
                role?: 'current' | 'standby';
                server_time?: string;
                heartbeat_interval_seconds?: number;
                registration_timeout_seconds?: number;
            };
            if (
                !body ||
                typeof body.server_time !== 'string' ||
                !/(Z|\+00:00)$/.test(body.server_time) ||
                !Number.isFinite(Date.parse(body.server_time)) ||
                body.heartbeat_interval_seconds !== 30 ||
                body.registration_timeout_seconds !== 90 ||
                body.device_id !== options.deviceId ||
                body.run_id !== runId ||
                (body.role !== 'current' && body.role !== 'standby')
            ) {
                recordFailure('protocol');
                schedule(30_000, () => {
                    void heartbeat(expected);
                });
                return;
            }
            const expiresAt = acceptConfirmation(requestStartedAt, body.registration_timeout_seconds);
            if (expiresAt === null) {
                revoke('expired', true);
                schedule(0, () => {
                    void register(expected);
                });
                return;
            }
            publish({
                deviceId: options.deviceId,
                runId,
                role: body.role,
                generation: qualification.role === body.role ? qualification.generation : qualification.generation + 1,
                expiresAt,
                reason: 'confirmed'
            });
            recordSuccess();
            schedule(30_000, () => {
                void heartbeat(expected);
            });
        } else if (
            response.status === 401 ||
            (response.status === 403 && (responseBody as { detail?: unknown })?.detail === 'Account is disabled')
        ) {
            terminateUnauthorized();
        } else if (
            response.status === 404 &&
            (responseBody as { detail?: unknown })?.detail === 'registration_not_found'
        ) {
            publish({
                deviceId: options.deviceId,
                runId,
                role: null,
                generation: qualification.generation + 1,
                expiresAt: null,
                reason: 'registration_not_found'
            });
            void register(expected);
        } else if (response.status === 409) {
            ended = true;
            unregisterSession = null;
            publish({
                deviceId: options.deviceId,
                runId,
                role: null,
                generation: qualification.generation + 1,
                expiresAt: null,
                reason: 'registration_ended'
            });
        } else if (response.status >= 500 || response.status === 408 || response.status === 429) {
            recordFailure(`http_${response.status}`);
            schedule(30_000, () => {
                void heartbeat(expected);
            });
        } else {
            recordFailure(`http_${response.status}`);
            ended = true;
            revoke('configuration');
        }
    };

    const start = (next: AccountCredentialSnapshot | null) => {
        abortRequest();
        clearTimer();
        session = next;
        if (next) {
            ended = false;
            unregisterSession = next;
            void register(next);
        }
    };

    const unregister = async (old: AccountCredentialSnapshot) => {
        const oldRun = runId;
        const baseUrl = old.baseUrl.replace(/\/+$/, '');
        const controller = new AbortController();
        const timeout = (options.setTimeout ?? setTimeout)(() => controller.abort(), 1_000);
        try {
            const aborted = new Promise<never>((_resolve, reject) =>
                controller.signal.addEventListener('abort', () => reject(new Error('registration:cleanup_timeout')), {
                    once: true
                })
            );
            await Promise.race([
                (async () => {
                    const response = await options.fetch(`${baseUrl}/devices/unregister`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${old.accessToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ device_id: options.deviceId, run_id: oldRun }),
                        signal: controller.signal
                    });
                    await response.text();
                })(),
                aborted
            ]);
        } catch {
            // best-effort cleanup
        } finally {
            cancelTimeout(timeout);
        }
    };

    const cleanup = (old: AccountCredentialSnapshot) => {
        const promise = unregister(old);
        cleanups.add(promise);
        void promise.finally(() => cleanups.delete(promise));
        return promise;
    };

    const suspend = () => {
        if (closed) return;
        suspended = true;
        abortRequest();
        clearTimer();
        revoke('suspended');
    };
    const resume = () => {
        if (closed) return;
        suspended = false;
        if (!session || ended) return;
        void register(session);
    };

    const unsubscribe = options.subscribe((change) => {
        if (closed) return;
        if (change.kind === 'stopped') {
            const old = change.credential;
            unregisterSession = null;
            start(null);
            publish({
                deviceId: options.deviceId,
                runId,
                role: null,
                generation: qualification.generation + 1,
                expiresAt: null,
                reason: 'account_stopped'
            });
            void cleanup(old);
        } else if (change.kind === 'committed') {
            accountGeneration += 1;
            runId = options.runId ?? crypto.randomUUID();
            consecutiveFailureCategory = undefined;
            consecutiveFailureCount = 0;
            revoke('account_changed');
            start(change.credential);
        } else if (change.kind === 'token-updated' && session) {
            abortRequest();
            clearTimer();
            session = change.credential;
            unregisterSession = change.credential;
            if (!ended) void heartbeat(change.credential);
        }
        emitCredential();
    });
    const unsubscribePower = options.subscribePower?.({ suspend, resume }) ?? (() => undefined);

    const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        closed = true;
        unsubscribe();
        unsubscribePower();
        options.signal.removeEventListener('abort', onParentAbort);
        abortRequest();
        clearTimer();
        revoke('closed');
        qualificationListeners.clear();
        emitCredential();
        credentialListeners.clear();
        const old = unregisterSession;
        unregisterSession = null;
        if (old?.accessToken) void cleanup(old);
        closePromise = Promise.all([...cleanups]).then(() => undefined);
        return closePromise;
    };
    const onParentAbort = () => {
        void close();
    };
    options.signal.addEventListener('abort', onParentAbort, { once: true });
    // 先订阅再读，账号源负责快照；同一事件循环内不会漏掉提交。
    if (!session) {
        session = options.getCredential();
        if (session) {
            accountGeneration += 1;
            unregisterSession = session;
        }
    }
    if (options.signal.aborted) void close();
    else if (session) void register(session);

    return {
        getCredential,
        subscribeCredential(listener) {
            credentialListeners.add(listener);
            return () => credentialListeners.delete(listener);
        },
        reportCredentialFailure(credential) {
            const current = getCredential();
            if (
                current &&
                current.accountScope === credential.accountScope &&
                current.version === credential.version &&
                current.accessToken === credential.accessToken
            ) {
                terminateUnauthorized();
            }
        },
        getQualification() {
            if (qualification.role !== null && qualification.expiresAt !== null && now() >= qualification.expiresAt) {
                publish({
                    deviceId: options.deviceId,
                    runId: qualification.runId,
                    role: null,
                    generation: qualification.generation + 1,
                    expiresAt: qualification.expiresAt,
                    reason: 'expired'
                });
            }
            return { ...qualification };
        },
        subscribeQualification(listener) {
            qualificationListeners.add(listener);
            return () => qualificationListeners.delete(listener);
        },
        suspend,
        resume,
        close
    };
}
