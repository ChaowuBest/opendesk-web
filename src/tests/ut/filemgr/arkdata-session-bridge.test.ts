import { jest, test, expect, beforeAll } from '@jest/globals';

// Mock the Electron/SDK boundary only. Import the production bridge normally;
// the optional Node integration additionally exercises the current ArkTS adapter.
const callArkTSFunction = jest.fn<(...args: any[]) => Promise<unknown>>();
jest.unstable_mockModule('electron', () => ({ systemPreferences: { callArkTSFunction } }));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }));
let HarmonyOSDatabaseKit: typeof import('../../../platforms/bridges/harmonyos/database.js').HarmonyOSDatabaseKit;
beforeAll(async () => {
    ({ HarmonyOSDatabaseKit } = await import('../../../platforms/bridges/harmonyos/database.js'));
});

function fixture() {
    const operations = new Map<string, any>();
    const accepted = new Map<string, any>();
    const invocations: string[] = [];
    let deletes = 0,
        pendingDelete = false,
        emptyDeleteId = false,
        unknownReady = false;
    let lostStart: string | null = null;
    let supported = true;
    let refs = 0,
        opens = 0,
        closes = 0,
        next = 0;
    let pendingOpen = false,
        pendingClose = false,
        corruptReady = false;
    callArkTSFunction.mockReset();
    callArkTSFunction.mockImplementation(async (name, _type, args) => {
        invocations.push(name);
        let result: any;
        if (name === 'ArkData.Ping')
            return { value: JSON.stringify({ ok: true, storeSessionProtocol: supported ? 1 : undefined }) };
        let requestKey: string | undefined;
        if (name === 'ArkData.OpenStoreStart') requestKey = 'open:' + JSON.parse(args[2]).sessionId;
        if (name === 'ArkData.CloseStoreStart') requestKey = 'close:' + JSON.parse(args[1]).requestId;
        if (requestKey && accepted.has(requestKey)) {
            const cached = accepted.get(requestKey);
            const operation = cached.operation;
            return {
                value: JSON.stringify(
                    operation?.state !== 'pending' && operation
                        ? { ok: true, settled: true, state: operation.state, error: operation.error }
                        : cached.reply
                )
            };
        }
        if (unknownReady && name.endsWith('Ready')) {
            unknownReady = false;
            return { value: JSON.stringify({ ok: true, state: 'unknown' }) };
        }
        if (corruptReady && name.endsWith('Ready')) {
            corruptReady = false;
            return '{broken';
        }
        if (name === 'ArkData.DeleteStoreStart') {
            if (refs > 0)
                result = {
                    ok: false,
                    error: {
                        code: 'store_busy_with_pending_ops',
                        message: 'isolated occupied store',
                        details: { storeId: args[0], operation: 'DeleteStoreStart' }
                    }
                };
            else {
                deletes++;
                const opId = 'delete-' + ++next;
                operations.set(opId, {
                    ok: true,
                    state: pendingDelete ? 'pending' : 'success',
                    storeId: args[0],
                    path: args[1]
                });
                result = { ok: true, opId: emptyDeleteId ? '' : opId };
            }
        } else if (name === 'ArkData.OpenStoreStart') {
            refs++;
            if (refs > 1) result = { ok: true, reused: true };
            else {
                opens++;
                const opId = 'open-' + ++next;
                operations.set(opId, { ok: true, state: pendingOpen ? 'pending' : 'success' });
                result = { ok: true, opId };
            }
        } else if (name === 'ArkData.CloseStoreStart') {
            if (refs === 0) result = { ok: false, error: { code: 'store_not_open', message: 'no holder' } };
            else {
                const opId = 'close-' + ++next;
                if (refs > 1) {
                    refs--;
                    operations.set(opId, { ok: true, state: 'success' });
                } else {
                    closes++;
                    operations.set(opId, { ok: true, state: pendingClose ? 'pending' : 'success' });
                    if (!pendingClose) refs = 0;
                }
                result = { ok: true, opId };
            }
        } else {
            result = operations.get(args[0]) ?? { ok: false, error: { code: 'op_not_found' } };
        }
        if (requestKey && result.ok)
            accepted.set(requestKey, { reply: result, operation: operations.get(result.opId) });
        if (name === lostStart) {
            lostStart = null;
            return '{lost-response';
        }
        return { value: JSON.stringify(result) };
    });
    const clock = Date.now;
    let timeout = false,
        time = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => (timeout ? (time += 31_001) : clock()));
    const settle = (kind: string, failure = false) => {
        for (const [id, operation] of operations)
            if (id.startsWith(kind) && operation.state === 'pending') {
                if (failure)
                    Object.assign(operation, {
                        ok: false,
                        state: 'error',
                        error: {
                            code: `store_${kind}_failed`,
                            message: 'isolated SDK failure',
                            ...(kind === 'delete' && {
                                details: {
                                    sdkErrorCode: 14800011,
                                    storeId: operation.storeId,
                                    path: operation.path,
                                    operation: 'DeleteStoreStart'
                                }
                            })
                        }
                    });
                else Object.assign(operation, { ok: true, state: 'success' });
            }
        if ((kind === 'close' && !failure) || (kind === 'open' && failure)) refs = 0;
    };
    return {
        lost: (name: string) => {
            lostStart = name;
        },
        support: (value: boolean) => {
            supported = value;
        },
        kit: new HarmonyOSDatabaseKit(),
        operations,
        invocations,
        deletes: () => deletes,
        pendingDelete: () => {
            pendingDelete = true;
        },
        emptyDeleteId: () => {
            emptyDeleteId = true;
        },
        unknownReady: () => {
            unknownReady = true;
        },
        corrupt: () => {
            corruptReady = true;
        },
        counters: () => ({ refs, opens, closes }),
        pendingOpen: () => {
            pendingOpen = true;
        },
        pendingClose: () => {
            pendingClose = true;
        },
        timeout: (value: boolean) => {
            timeout = value;
        },
        settle,
        restore: () => {
            timeout = false;
            settle('open');
            settle('close');
            settle('delete');
            now.mockRestore();
        }
    };
}
const options = (sessionId: string) => ({ sessionId, path: '/isolated.db', vector: true });

test('concurrent same-session opens acquire once; distinct sessions release independently', async () => {
    const f = fixture();
    try {
        await Promise.all([f.kit.openStore('store', options('a')), f.kit.openStore('store', options('a'))]);
        await f.kit.openStore('store', options('b'));
        expect(f.counters()).toEqual({ refs: 2, opens: 1, closes: 0 });
        await f.kit.closeStore('store', options('a'));
        await f.kit.closeStore('store', options('a'));
        expect(f.counters().refs).toBe(1);
        await f.kit.closeStore('store', options('b'));
        expect(f.counters()).toEqual({ refs: 0, opens: 1, closes: 1 });
    } finally {
        f.restore();
    }
});

test('late successful open is automatically released after its caller times out', async () => {
    const f = fixture();
    try {
        f.pendingOpen();
        f.timeout(true);
        await expect(f.kit.openStore('store', options('a'))).rejects.toMatchObject({ code: 'operation_timeout' });
        await expect(f.kit.closeStore('store', options('a'))).rejects.toMatchObject({ code: 'operation_timeout' });
        f.timeout(false);
        f.settle('open');
        await f.kit.closeStore('store', options('a'));
        expect(f.counters()).toEqual({ refs: 0, opens: 1, closes: 1 });
    } finally {
        f.restore();
    }
});

for (const newOwner of [false, true])
    test(`late successful close caches its result, new owner=${newOwner}`, async () => {
        const f = fixture();
        try {
            await f.kit.openStore('store', options('a'));
            f.pendingClose();
            f.timeout(true);
            await expect(f.kit.closeStore('store', options('a'))).rejects.toMatchObject({ code: 'operation_timeout' });
            f.timeout(false);
            f.settle('close');
            await f.kit.closeStore('store', options('a'));
            // ArkTS terminal records expire after five minutes; a cached release
            // remains idempotent after that eviction and after a new generation.
            f.operations.clear();
            if (newOwner) await f.kit.openStore('store', options('b'));
            await f.kit.closeStore('store', options('a'));
            expect(f.counters().refs).toBe(newOwner ? 1 : 0);
            if (newOwner) {
                const released = f.kit.closeStore('store', options('b'));
                await new Promise((resolve) => setImmediate(resolve));
                f.settle('close');
                await released;
            }
        } finally {
            f.restore();
        }
    });

test('late SDK close failure allows retry of the same retained reference', async () => {
    const f = fixture();
    try {
        await f.kit.openStore('store', options('a'));
        f.pendingClose();
        f.timeout(true);
        await expect(f.kit.closeStore('store', options('a'))).rejects.toMatchObject({ code: 'operation_timeout' });
        f.timeout(false);
        f.settle('close', true);
        await expect(f.kit.closeStore('store', options('a'))).rejects.toMatchObject({ code: 'store_close_failed' });
        const retried = f.kit.closeStore('store', options('a'));
        await new Promise((resolve) => setImmediate(resolve));
        f.settle('close');
        await retried;
        expect(f.counters()).toEqual({ refs: 0, opens: 1, closes: 2 });
    } finally {
        f.restore();
    }
});

test('late SDK open failure does not manufacture a release or another acquisition', async () => {
    const f = fixture();
    try {
        f.pendingOpen();
        f.timeout(true);
        await expect(f.kit.openStore('store', options('a'))).rejects.toMatchObject({ code: 'operation_timeout' });
        f.timeout(false);
        f.settle('open', true);
        await f.kit.closeStore('store', options('a'));
        expect(f.counters()).toEqual({ refs: 0, opens: 1, closes: 0 });
    } finally {
        f.restore();
    }
});

test('release arriving before open retires that identity without acquiring a connection', async () => {
    const f = fixture();
    try {
        await f.kit.closeStore('store', options('a'));
        await expect(f.kit.openStore('store', options('a'))).rejects.toMatchObject({ code: 'store_id_conflict' });
        expect(f.counters()).toEqual({ refs: 0, opens: 0, closes: 0 });
    } finally {
        f.restore();
    }
});

test('immediate release after open cannot wait for its own predecessor', async () => {
    const f = fixture();
    try {
        await Promise.all([f.kit.openStore('store', options('a')), f.kit.closeStore('store', options('a'))]);
        expect(f.counters()).toEqual({ refs: 0, opens: 1, closes: 1 });
    } finally {
        f.restore();
    }
});

test('session identity cannot be reused for a different path or store', async () => {
    const f = fixture();
    try {
        await f.kit.openStore('store', options('a'));
        await expect(f.kit.openStore('other', options('a'))).rejects.toMatchObject({ code: 'store_id_conflict' });
        await expect(f.kit.openStore('store', { ...options('a'), path: '/other.db' })).rejects.toMatchObject({
            code: 'store_id_conflict'
        });
        await f.kit.closeStore('store', options('a'));
        expect(f.counters().opens).toBe(1);
    } finally {
        f.restore();
    }
});

test('malformed Ready after accepted close keeps the original release operation', async () => {
    const f = fixture();
    try {
        await f.kit.openStore('store', options('a'));
        f.pendingClose();
        f.corrupt();
        await expect(f.kit.closeStore('store', options('a'))).rejects.toMatchObject({ code: 'operation_unresolved' });
        await expect(f.kit.openStore('store', options('a'))).rejects.toMatchObject({ code: 'store_closing' });
        f.settle('close');
        await f.kit.closeStore('store', options('a'));
        await f.kit.openStore('store', options('b'));
        await f.kit.closeStore('store', options('a'));
        expect(f.counters().refs).toBe(1);
        const released = f.kit.closeStore('store', options('b'));
        await new Promise((resolve) => setImmediate(resolve));
        f.settle('close');
        await released;
        expect(f.counters()).toEqual({ refs: 0, opens: 2, closes: 2 });
    } finally {
        f.restore();
    }
});

for (const phase of ['Open', 'Close'])
    test(`lost ${phase} Start replays its accepted request exactly once`, async () => {
        const f = fixture();
        try {
            if (phase === 'Close') await f.kit.openStore('store', options('a'));
            f.lost(`ArkData.${phase}StoreStart`);
            const request =
                phase === 'Open' ? f.kit.openStore('store', options('a')) : f.kit.closeStore('store', options('a'));
            await expect(request).rejects.toMatchObject({ code: 'envelope_parse_failed' });
            await f.kit.closeStore('store', options('a'));
            expect(f.counters()).toEqual({ refs: 0, opens: 1, closes: 1 });
        } finally {
            f.restore();
        }
    });
test('an older adapter without the idempotent store protocol is unavailable for new ownership', async () => {
    const f = fixture();
    try {
        expect(await f.kit.available()).toBe(true);
        f.support(false);
        expect(await f.kit.available()).toBe(false);
        expect(f.counters().opens).toBe(0);
    } finally {
        f.restore();
    }
});

for (const scenario of ['occupied', 'sdk-failure', 'timeout', 'bad-start', 'bad-ready', 'empty-op-id', 'unknown-ready'])
    test(`deletion ${scenario} preserves the failure without retry or acquiring another owner`, async () => {
        const f = fixture();
        try {
            if (scenario === 'occupied') await f.kit.openStore('store', options('owner'));
            else f.pendingDelete();
            if (scenario === 'timeout') f.timeout(true);
            if (scenario === 'bad-start') f.lost('ArkData.DeleteStoreStart');
            if (scenario === 'bad-ready') f.corrupt();
            if (scenario === 'empty-op-id') f.emptyDeleteId();
            if (scenario === 'unknown-ready') f.unknownReady();
            const expectedCode =
                scenario === 'occupied'
                    ? 'store_busy_with_pending_ops'
                    : scenario === 'sdk-failure'
                      ? 'store_delete_failed'
                      : scenario === 'timeout'
                        ? 'operation_timeout'
                        : scenario === 'empty-op-id'
                          ? 'payload_shape_invalid'
                          : scenario === 'unknown-ready'
                            ? 'unknown_error'
                            : 'envelope_parse_failed';
            const rejected = expect(f.kit.deleteStore('store', options('delete-caller'))).rejects.toMatchObject({
                code: expectedCode,
                ...(scenario === 'sdk-failure' && {
                    details: { sdkErrorCode: 14800011, storeId: 'store', operation: 'DeleteStoreStart' }
                })
            });
            if (scenario === 'sdk-failure') {
                await new Promise((resolve) => setImmediate(resolve));
                f.settle('delete', true);
            }
            await rejected;
            f.timeout(false);
            expect(f.deletes()).toBe(scenario === 'occupied' ? 0 : 1);
            expect(f.invocations.filter((name) => name === 'ArkData.DeleteStoreStart')).toHaveLength(1);
            expect(f.invocations.filter((name) => name === 'ArkData.OpenStoreStart')).toHaveLength(
                scenario === 'occupied' ? 1 : 0
            );
            expect(f.invocations.filter((name) => name.includes('CloseStore'))).toHaveLength(0);
            if (!['occupied', 'sdk-failure'].includes(scenario)) {
                expect([...f.operations.values()].filter((op) => op.state === 'pending')).toHaveLength(1);
                f.settle('delete');
                expect([...f.operations.values()].every((op) => op.state === 'success')).toBe(true);
            }
        } finally {
            f.restore();
        }
    });
