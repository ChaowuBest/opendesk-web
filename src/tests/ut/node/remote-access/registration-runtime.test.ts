import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationRuntime } from '../../../../main/applications/mobileaccess/remote-access/registration-runtime.js';
import type { AccountChange, AccountCredentialSnapshot } from '../../../../main/applications/account/types.js';

test('external auth failure is scoped to the current owner credential, including token ABA', async () => {
    let change!: (value: AccountChange) => void;
    const session: AccountCredentialSnapshot = {
        backendId: 'opendesk',
        kind: 'enterprise',
        baseUrl: 'https://example.test/api/v1',
        accessToken: 'test-token',
        tokenType: 'bearer',
        user: { id: '1', username: 'test' }
    };
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => session,
        subscribe: (listener) => {
            change = listener;
            return () => undefined;
        },
        fetch: async () =>
            new Response(
                JSON.stringify({
                    device_id: 'pc',
                    run_id: '00000000-0000-4000-8000-000000000000',
                    role: 'current',
                    server_time: '2026-09-14T00:00:00Z',
                    heartbeat_interval_seconds: 30,
                    registration_timeout_seconds: 90
                })
            ),
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000000'
    });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        const original = runtime.getCredential();
        assert.ok(original, 'the registration owner exposes its committed credential');
        let updates = 0;
        const remove = runtime.subscribeCredential(() => updates++);
        change({ kind: 'token-updated', credential: { ...session, accessToken: 'refreshed' } });
        const refreshed = runtime.getCredential()!;
        assert.ok(refreshed.version > original.version);
        assert.equal(refreshed.accountScope, original.accountScope);
        assert.equal(updates, 1);
        runtime.reportCredentialFailure(original);
        assert.equal(runtime.getQualification().role, 'current');
        change({ kind: 'stopped', credential: session });
        change({ kind: 'committed', credential: session });
        await new Promise((resolve) => setImmediate(resolve));
        const relogged = runtime.getCredential()!;
        assert.notEqual(relogged.accountScope, original.accountScope);
        runtime.reportCredentialFailure(original);
        assert.equal(runtime.getQualification().role, 'current');
        runtime.reportCredentialFailure(relogged);
        assert.equal(runtime.getQualification().reason, 'unauthorized');
        assert.equal(runtime.getQualification().role, null);
        remove();
    } finally {
        await runtime.close();
    }
});

test('waits for login and uses the committed account base URL', async () => {
    let listener: ((change: AccountChange) => void) | undefined;
    const calls: string[] = [];
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => null,
        subscribe: (value) => {
            listener = value;
            return () => undefined;
        },
        fetch: async (input) => {
            calls.push(input);
            return new Response('{}', { status: 200 });
        },
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000000'
    });
    assert.deepEqual(calls, []);
    const session: AccountCredentialSnapshot = {
        backendId: 'opendesk',
        kind: 'enterprise',
        baseUrl: 'https://example.test/api/v1/',
        accessToken: 'token',
        tokenType: 'bearer',
        user: { id: '1', username: 'u' }
    };
    listener?.({ kind: 'committed', credential: session });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls[0], 'https://example.test/api/v1/devices/register');
    await runtime.close();
    assert.equal(calls[1], 'https://example.test/api/v1/devices/unregister');
});

test('publishes current qualification until the request-time 90 second deadline', async () => {
    let listener: ((change: AccountChange) => void) | undefined;
    let now = 1_000;
    const changes: Array<{ role: string | null; reason: string; generation: number }> = [];
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => null,
        subscribe: (value) => {
            listener = value;
            return () => undefined;
        },
        fetch: async (input) =>
            input.endsWith('/register')
                ? new Response(
                      JSON.stringify({
                          device_id: 'pc',
                          run_id: '00000000-0000-4000-8000-000000000000',
                          role: 'current',
                          server_time: '2026-09-11T00:00:00Z',
                          heartbeat_interval_seconds: 30,
                          registration_timeout_seconds: 90
                      }),
                      { status: 200 }
                  )
                : new Response('{}', { status: 200 }),
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000000',
        now: () => now
    });
    runtime.subscribeQualification((value) =>
        changes.push({ role: value.role, reason: value.reason, generation: value.generation })
    );
    const session: AccountCredentialSnapshot = {
        backendId: 'opendesk',
        kind: 'enterprise',
        baseUrl: 'https://example.test/api/v1',
        accessToken: 'token',
        tokenType: 'bearer',
        user: { id: '1', username: 'u' }
    };
    listener?.({ kind: 'committed', credential: session });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(changes.at(-1), { role: 'current', reason: 'confirmed', generation: 2 });
    now = 91_000;
    assert.equal(runtime.getQualification().role, null);
    assert.equal(runtime.getQualification().reason, 'expired');
    await runtime.close();
});

test('drops a response that arrives after its request-time deadline', async () => {
    let listener: ((change: AccountChange) => void) | undefined;
    let now = 1_000;
    let resolveFetch!: (value: Response) => void;
    let callCount = 0;
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => null,
        subscribe: (value) => {
            listener = value;
            return () => undefined;
        },
        fetch: async () => {
            callCount += 1;
            if (callCount > 1) return new Response('{}', { status: 200 });
            return new Promise((resolve) => {
                resolveFetch = resolve;
            });
        },
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000000',
        now: () => now
    });
    listener?.({
        kind: 'committed',
        credential: {
            backendId: 'opendesk',
            kind: 'enterprise',
            baseUrl: 'https://example.test/api/v1',
            accessToken: 'token',
            tokenType: 'bearer',
            user: { id: '1', username: 'u' }
        }
    });
    now = 91_000;
    resolveFetch(
        new Response(
            JSON.stringify({
                device_id: 'pc',
                run_id: '00000000-0000-4000-8000-000000000000',
                role: 'current',
                server_time: '2026-09-11T00:00:00Z',
                heartbeat_interval_seconds: 30,
                registration_timeout_seconds: 90
            }),
            { status: 200 }
        )
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.getQualification().role, null);
    await runtime.close();
});

test('close prevents a late register response from restoring qualification', async () => {
    let listener: ((change: AccountChange) => void) | undefined;
    let resolveFetch!: (value: Response) => void;
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => null,
        subscribe: (value) => {
            listener = value;
            return () => undefined;
        },
        fetch: async () =>
            new Promise((resolve) => {
                resolveFetch = resolve;
            }),
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000000'
    });
    const session: AccountCredentialSnapshot = {
        backendId: 'opendesk',
        kind: 'enterprise',
        baseUrl: 'https://example.test/api/v1',
        accessToken: 'token',
        tokenType: 'bearer',
        user: { id: '1', username: 'u' }
    };
    listener?.({ kind: 'committed', credential: session });
    const closing = runtime.close();
    resolveFetch(
        new Response(
            JSON.stringify({
                device_id: 'pc',
                run_id: '00000000-0000-4000-8000-000000000000',
                role: 'current',
                server_time: '2026-09-11T00:00:00Z',
                heartbeat_interval_seconds: 30,
                registration_timeout_seconds: 90
            }),
            { status: 200 }
        )
    );
    await closing;
    assert.equal(runtime.getQualification().role, null);
});

test('409 registration ended permanently revokes qualification', async () => {
    let listener: ((change: AccountChange) => void) | undefined;
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => null,
        subscribe: (value) => {
            listener = value;
            return () => undefined;
        },
        fetch: async () => new Response(JSON.stringify({ detail: 'registration_ended' }), { status: 409 }),
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000000'
    });
    listener?.({
        kind: 'committed',
        credential: {
            backendId: 'opendesk',
            kind: 'enterprise',
            baseUrl: 'https://example.test/api/v1',
            accessToken: 'token',
            tokenType: 'bearer',
            user: { id: '1', username: 'u' }
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.getQualification().role, null);
    assert.equal(runtime.getQualification().reason, 'registration_ended');
    await runtime.close();
});

test('suspend revokes qualification and resume starts a fresh confirmation', async () => {
    let listener: ((change: AccountChange) => void) | undefined;
    let registerCalls = 0;
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => null,
        subscribe: (value) => {
            listener = value;
            return () => undefined;
        },
        fetch: async (input) => {
            if (input.endsWith('/register')) {
                registerCalls += 1;
                return new Response(
                    JSON.stringify({
                        device_id: 'pc',
                        run_id: '00000000-0000-4000-8000-000000000000',
                        role: 'current',
                        server_time: '2026-09-11T00:00:00Z',
                        heartbeat_interval_seconds: 30,
                        registration_timeout_seconds: 90
                    }),
                    { status: 200 }
                );
            }
            return new Response('{}', { status: 200 });
        },
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000000'
    });
    listener?.({
        kind: 'committed',
        credential: {
            backendId: 'opendesk',
            kind: 'enterprise',
            baseUrl: 'https://example.test/api/v1',
            accessToken: 'token',
            tokenType: 'bearer',
            user: { id: '1', username: 'u' }
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    runtime.suspend();
    assert.equal(runtime.getQualification().reason, 'suspended');
    runtime.resume();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registerCalls, 2);
    await runtime.close();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class ManualClock {
    time = 0;
    sequence = 0;
    timers = new Map<number, { at: number; callback: () => void }>();
    setTimeout = (callback: () => void, delay: number) => {
        const id = ++this.sequence;
        this.timers.set(id, { at: this.time + delay, callback });
        return id;
    };
    clearTimeout = (id: unknown) => {
        this.timers.delete(id as number);
    };
    async advance(ms: number) {
        const end = this.time + ms;
        while (true) {
            const next = [...this.timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            this.time = next[1].at;
            this.timers.delete(next[0]);
            next[1].callback();
            await tick();
        }
        this.time = end;
        await tick();
    }
}
function pending<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function runtimeFixture(
    options: {
        hostType?: 'electron' | 'cli';
        clock?: ManualClock;
        runId?: string;
        fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    } = {}
) {
    const clock = options.clock ?? new ManualClock();
    const parent = new AbortController();
    const accounts = new Set<(change: AccountChange) => void>();
    const powers = new Set<{ suspend: () => void; resume: () => void }>();
    const calls: Array<{ url: string; init?: RequestInit; at: number }> = [];
    const logs: Array<{ kind: string; category?: string; count: number }> = [];
    const runId = options.runId ?? '00000000-0000-4000-8000-000000000001';
    const session: AccountCredentialSnapshot = {
        backendId: 'opendesk',
        kind: 'enterprise',
        baseUrl: 'https://server.test/api/v1',
        accessToken: 'one',
        tokenType: 'bearer',
        user: { id: '1', username: 'one' }
    };
    const confirmation = (init?: RequestInit, role: 'current' | 'standby' = 'current') =>
        new Response(
            JSON.stringify({
                ...JSON.parse(init?.body as string),
                role,
                server_time: '2026-09-11T00:00:00Z',
                heartbeat_interval_seconds: 30,
                registration_timeout_seconds: 90
            })
        );
    const runtime = createRegistrationRuntime({
        hostType: options.hostType ?? 'electron',
        signal: parent.signal,
        getCredential: () => null,
        subscribe: (listener) => {
            accounts.add(listener);
            return () => {
                accounts.delete(listener);
            };
        },
        subscribePower: (handlers) => {
            powers.add(handlers);
            return () => {
                powers.delete(handlers);
            };
        },
        deviceId: 'pc',
        name: 'Desk',
        runId,
        now: () => clock.time,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        diagnose: (event) => logs.push(event),
        fetch: async (url, init) => {
            calls.push({ url, init, at: clock.time });
            return options.fetch ? options.fetch(url, init) : confirmation(init);
        }
    });
    const emit = (change: AccountChange) => {
        for (const listener of accounts) listener(change);
    };
    const login = async () => {
        emit({ kind: 'committed', credential: session });
        await tick();
    };
    return { clock, parent, accounts, powers, calls, logs, session, confirmation, runtime, emit, login };
}

test('login after waking without credentials registers and starts heartbeats', async () => {
    const f = runtimeFixture();
    const power = [...f.powers][0];
    try {
        power.suspend();
        await f.clock.advance(12 * 60 * 60 * 1000);
        power.resume();
        await tick();
        assert.equal(f.calls.length, 0);
        assert.equal(f.runtime.getQualification().role, null);

        await f.login();
        assert.equal(f.calls.length, 1);
        assert.ok(f.calls[0].url.endsWith('/register'));
        assert.equal(f.runtime.getQualification().role, 'current');

        await f.clock.advance(30_000);
        assert.equal(f.calls.length, 2);
        assert.ok(f.calls[1].url.endsWith('/heartbeat'));
        assert.equal(f.runtime.getQualification().role, 'current');
    } finally {
        await f.runtime.close();
    }
});

test('login during suspension waits until resume before registering', async () => {
    const f = runtimeFixture();
    const power = [...f.powers][0];
    try {
        power.suspend();
        await f.login();
        await f.clock.advance(30_000);
        assert.equal(f.calls.length, 0);
        assert.equal(f.runtime.getQualification().role, null);

        power.resume();
        await tick();
        assert.equal(f.calls.length, 1);
        assert.ok(f.calls[0].url.endsWith('/register'));
        assert.equal(f.runtime.getQualification().role, 'current');
    } finally {
        await f.runtime.close();
    }
});

test('waking after authorization failure allows a later login to register', async () => {
    let authorized = false;
    const f = runtimeFixture({
        fetch: async (url, init) =>
            url.endsWith('/register') && !authorized ? new Response('{}', { status: 401 }) : f.confirmation(init)
    });
    const power = [...f.powers][0];
    try {
        await f.login();
        assert.equal(f.runtime.getQualification().reason, 'unauthorized');
        power.suspend();
        power.resume();
        await f.clock.advance(30_000);
        assert.equal(f.calls.length, 1);
        assert.equal(f.runtime.getQualification().role, null);

        f.emit({ kind: 'stopped', credential: f.session });
        authorized = true;
        await f.login();
        assert.equal(f.calls.filter((call) => call.url.endsWith('/register')).length, 2);
        assert.equal(f.runtime.getQualification().role, 'current');
    } finally {
        await f.runtime.close();
    }
});

test('restores an existing session and registers immediately during construction', async () => {
    const clock = new ManualClock();
    const session: AccountCredentialSnapshot = {
        backendId: 'opendesk',
        kind: 'enterprise',
        baseUrl: 'https://server.test/api/v1',
        accessToken: 'restored',
        tokenType: 'bearer',
        user: { id: '1', username: 'one' }
    };
    const calls: string[] = [];
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        getCredential: () => session,
        subscribe: () => () => undefined,
        fetch: async (url, init) => {
            calls.push(`${url}:${(init?.headers as Record<string, string>).Authorization}`);
            return new Response(
                JSON.stringify({
                    ...JSON.parse(init?.body as string),
                    role: 'current',
                    server_time: '2026-09-11T00:00:00Z',
                    heartbeat_interval_seconds: 30,
                    registration_timeout_seconds: 90
                })
            );
        },
        deviceId: 'pc',
        name: 'Desk',
        runId: '00000000-0000-4000-8000-000000000003',
        now: () => clock.time,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout
    });
    await tick();
    assert.deepEqual(calls, ['https://server.test/api/v1/devices/register:Bearer restored']);
    assert.equal(runtime.getQualification().role, 'current');
    await runtime.close();
});

for (const phase of ['register', 'heartbeat'] as const) {
    test(`expired ${phase} confirmation stays revoked and immediately requests a fresh confirmation`, async () => {
        const reply = pending<Response>();
        let held = false;
        const f = runtimeFixture({
            fetch: async (url, init) => {
                if (url.endsWith('/' + phase) && !held) {
                    held = true;
                    return reply.promise;
                }
                return f.confirmation(init);
            }
        });
        await f.login();
        if (phase === 'heartbeat') await f.clock.advance(30_000);
        const call = f.calls.at(-1)!;
        // Model a blocked event loop: response arrives after expiry before timer callbacks execute.
        f.clock.time = 91_000;
        reply.resolve(f.confirmation(call.init));
        await tick();
        assert.equal(f.runtime.getQualification().role, null);
        assert.equal(f.runtime.getQualification().reason, 'expired');
        assert.deepEqual(f.logs, []);
        const before = f.calls.length;
        await f.clock.advance(0);
        assert.equal(f.calls.length, before + 1);
        assert.equal(f.runtime.getQualification().role, 'current');
        assert.equal(f.runtime.getQualification().expiresAt, 181_000);
        await f.runtime.close();
    });
}

test('subscription commit during construction registers once without counting the restored scope twice', async () => {
    const clock = new ManualClock();
    const session: AccountCredentialSnapshot = {
        backendId: 'opendesk',
        kind: 'personal',
        baseUrl: 'https://server.test/api/v1',
        accessToken: 'saved',
        tokenType: 'bearer',
        user: { id: '1', username: 'one' }
    };
    const calls: string[] = [];
    const runtime = createRegistrationRuntime({
        hostType: 'electron',
        signal: new AbortController().signal,
        deviceId: 'pc',
        name: 'Desk',
        getCredential: () => session,
        subscribe: (listener) => {
            listener({ kind: 'committed', credential: session });
            return () => undefined;
        },
        now: () => clock.time,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        fetch: async (url, init) => {
            calls.push(url);
            return new Response(
                JSON.stringify({
                    ...JSON.parse(init?.body as string),
                    role: 'current',
                    server_time: '2026-09-11T00:00:00Z',
                    heartbeat_interval_seconds: 30,
                    registration_timeout_seconds: 90
                })
            );
        }
    });
    await tick();
    assert.deepEqual(calls, ['https://server.test/api/v1/devices/register']);
    assert.equal(runtime.getQualification().accountScope, 'https://server.test/api/v1:1:1');
    await runtime.close();
});

test('heartbeats run at 30 seconds without overlapping a pending confirmation', async () => {
    const reply = pending<Response>();
    const f = runtimeFixture({
        fetch: async (url, init) => (url.endsWith('/heartbeat') ? reply.promise : f.confirmation(init))
    });
    await f.login();
    await f.clock.advance(29_999);
    assert.equal(f.calls.length, 1);
    await f.clock.advance(1);
    assert.equal(f.calls[1].at, 30_000);
    f.runtime.resume();
    f.runtime.resume();
    await tick();
    assert.equal(f.calls.length, 2);
    reply.resolve(f.confirmation(f.calls[1].init));
    await tick();
    await f.runtime.close();
});

test('parent abort revokes immediately and sends independently bounded unregister including body', async () => {
    let cleanupSignal: AbortSignal | undefined;
    const f = runtimeFixture({
        fetch: async (url, init) => {
            if (!url.endsWith('/unregister')) return f.confirmation(init);
            cleanupSignal = init?.signal as AbortSignal;
            return {
                ...new Response(),
                text: () =>
                    new Promise<string>((_resolve, reject) => {
                        cleanupSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                    })
            } as Response;
        }
    });
    await f.login();
    f.parent.abort();
    assert.equal(f.runtime.getQualification().role, null);
    assert.equal(cleanupSignal?.aborted, false);
    let finished = false;
    const closing = f.runtime.close().then(() => {
        finished = true;
    });
    await f.clock.advance(999);
    assert.equal(finished, false);
    await f.clock.advance(1);
    await closing;
    assert.equal(cleanupSignal?.aborted, true);
    assert.equal(f.clock.time, 1000);
    await f.runtime.close();
    assert.equal(f.calls.filter((call) => call.url.endsWith('/unregister')).length, 1);
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.accounts.size, 0);
    assert.equal(f.powers.size, 0);
});

test('expires and notifies without polling and never republishes expiry on reads', async () => {
    const f = runtimeFixture({
        fetch: async (url, init) => {
            if (url.endsWith('/heartbeat')) throw new Error('offline');
            return f.confirmation(init);
        }
    });
    await f.login();
    const changes: string[] = [];
    f.runtime.subscribeQualification((value) => changes.push(value.reason));
    await f.clock.advance(89_999);
    assert.equal(f.runtime.getQualification().role, 'current');
    await f.clock.advance(1);
    assert.deepEqual(changes, ['expired']);
    const first = f.runtime.getQualification();
    assert.deepEqual(f.runtime.getQualification(), first);
    assert.deepEqual(changes, ['expired']);
    await f.runtime.close();
});

test('refresh 401 and old-account replies cannot stop or overwrite the new credentials', async () => {
    const old = pending<Response>();
    const f = runtimeFixture({
        fetch: async (url, init) => {
            if (url.endsWith('/heartbeat') && (init?.headers as Record<string, string>).Authorization === 'Bearer one')
                return old.promise;
            return f.confirmation(init);
        }
    });
    await f.login();
    await f.clock.advance(30_000);
    f.emit({ kind: 'token-updated', credential: { ...f.session, accessToken: 'two' } });
    old.resolve(new Response(JSON.stringify({ detail: 'invalid' }), { status: 401 }));
    await tick();
    assert.equal(f.runtime.getQualification().role, 'current');
    assert.equal(
        f.runtime.getQualification().runId,
        f.calls[0].init && JSON.parse(f.calls[0].init.body as string).run_id
    );
    assert.equal((f.calls.at(-1)!.init?.headers as Record<string, string>).Authorization, 'Bearer two');
    f.emit({ kind: 'stopped', credential: f.session });
    assert.equal(f.runtime.getQualification().role, null);
    f.emit({
        kind: 'committed',
        credential: { ...f.session, accessToken: 'three', user: { id: '3', username: 'three' } }
    });
    await tick();
    assert.equal(f.runtime.getQualification().role, 'current');
    await f.runtime.close();
});

test('same-category failures are suppressed and recovery reports accumulated count once', async () => {
    let offline = true;
    const f = runtimeFixture({
        fetch: async (_url, init) => {
            if (offline) throw new Error('private dynamic failure ' + Math.random());
            return f.confirmation(init);
        }
    });
    await f.login();
    await f.clock.advance(90_000);
    assert.deepEqual(f.logs, [{ kind: 'failure', category: 'request', count: 1 }]);
    offline = false;
    await f.clock.advance(30_000);
    assert.deepEqual(f.logs, [
        { kind: 'failure', category: 'request', count: 1 },
        { kind: 'recovered', count: 4 }
    ]);
    await f.clock.advance(30_000);
    assert.equal(f.logs.length, 2);
    await f.runtime.close();
});

test('two runtimes for one device keep run role and resource state isolated', async () => {
    const clock = new ManualClock();
    const a = runtimeFixture({ clock });
    const b = runtimeFixture({
        clock,
        runId: '00000000-0000-4000-8000-000000000002',
        fetch: async (_url, init) => b.confirmation(init, 'standby')
    });
    await a.login();
    await b.login();
    assert.equal(a.runtime.getQualification().role, 'current');
    assert.equal(b.runtime.getQualification().role, 'standby');
    assert.notEqual(a.runtime.getQualification().runId, b.runtime.getQualification().runId);
    await a.runtime.close();
    assert.equal(a.runtime.getQualification().role, null);
    assert.equal(b.runtime.getQualification().role, 'standby');
    await clock.advance(30_000);
    assert.equal(b.calls.length, 2);
    await b.runtime.close();
    assert.equal(clock.timers.size, 0);
});

for (const [status, detail, retry] of [
    [404, 'registration_not_found', true],
    [404, 'Not Found', false],
    [409, 'registration_ended', false],
    [409, 'registration_identity_conflict', false],
    [422, 'invalid', false],
    [401, 'invalid', false],
    [403, 'Account is disabled', false]
] as const) {
    test(`heartbeat ${status}/${detail} uses the prescribed retry and role transition`, async () => {
        const f = runtimeFixture({
            fetch: async (url, init) =>
                url.endsWith('/heartbeat') ? new Response(JSON.stringify({ detail }), { status }) : f.confirmation(init)
        });
        await f.login();
        await f.clock.advance(30_000);
        assert.equal(f.calls.length, retry ? 3 : 2);
        if (!retry) assert.equal(f.runtime.getQualification().role, null);
        await f.clock.advance(30_000);
        assert.equal(f.calls.length, retry ? 5 : 2);
        await f.runtime.close();
    });
}

for (const phase of ['headers', 'body'] as const) {
    test(`request timeout covers pending ${phase} and frees the next retry`, async () => {
        const f = runtimeFixture({
            fetch: async (url, init) => {
                if (url.endsWith('/unregister')) return new Response('{}');
                const wait = () =>
                    new Promise<string>((_resolve, reject) =>
                        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                    );
                if (phase === 'headers') {
                    await wait();
                    return new Response('{}');
                }
                return { ok: true, status: 200, text: wait } as Response;
            }
        });
        await f.login();
        await f.clock.advance(10_000);
        assert.equal(f.calls[0].init?.signal?.aborted, true);
        assert.equal(f.runtime.getQualification().role, null);
        await f.clock.advance(30_000);
        assert.equal(f.calls.length, 2);
        await f.runtime.close();
        assert.equal(f.clock.timers.size, 0);
    });
}

test('success response without server time and timing fields cannot grant qualification', async () => {
    const f = runtimeFixture({
        fetch: async (_url, init) =>
            new Response(JSON.stringify({ ...JSON.parse(init?.body as string), role: 'current' }))
    });
    await f.login();
    assert.equal(f.runtime.getQualification().role, null);
    await f.clock.advance(30_000);
    assert.equal(f.calls.length, 2);
    await f.runtime.close();
});

for (const [status, detail, reason] of [
    [401, 'invalid', 'unauthorized'],
    [403, 'Account is disabled', 'unauthorized'],
    [403, 'resource forbidden', 'configuration']
] as const) {
    test(`heartbeat ${status}/${detail} cannot be restarted by token refresh alone`, async () => {
        const f = runtimeFixture({
            fetch: async (url, init) =>
                url.endsWith('/heartbeat') ? new Response(JSON.stringify({ detail }), { status }) : f.confirmation(init)
        });
        await f.login();
        await f.clock.advance(30_000);
        assert.equal(f.runtime.getQualification().reason, reason);
        f.emit({ kind: 'token-updated', credential: { ...f.session, accessToken: 'two' } });
        await tick();
        assert.equal(f.calls.length, 2);
        f.runtime.resume();
        await f.clock.advance(60_000);
        assert.equal(f.calls.length, 2);
        await f.runtime.close();
    });
}

for (const phase of ['register', 'heartbeat'] as const) {
    test(`temporary HTTP 429 during ${phase} retries on the next 30-second cycle`, async () => {
        let limited = true;
        const f = runtimeFixture({
            fetch: async (url, init) =>
                url.endsWith('/' + phase) && limited ? new Response('{}', { status: 429 }) : f.confirmation(init)
        });
        await f.login();
        if (phase === 'heartbeat') await f.clock.advance(30_000);
        const before = f.calls.length;
        limited = false;
        await f.clock.advance(29_999);
        assert.equal(f.calls.length, before);
        await f.clock.advance(1);
        assert.equal(f.calls.length, before + 1);
        assert.equal(f.runtime.getQualification().role, 'current');
        await f.runtime.close();
    });
}

for (const hostType of ['electron', 'cli'] as const) {
    test(`registers the explicit ${hostType} host type`, async () => {
        const f = runtimeFixture({ hostType });
        try {
            await f.login();
            assert.equal(JSON.parse(f.calls[0].init?.body as string).host_type, hostType);
        } finally {
            await f.runtime.close();
        }
    });
}
