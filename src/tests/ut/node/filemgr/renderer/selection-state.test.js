import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as state from '../../../../../main/applications/filemgr/renderer/state.js';

test.afterEach(() => state.__resetForTesting());

test('U01 ordinary selections use a real 3000ms commit deadline', () => {
    assert.equal(state.COMMIT_DEBOUNCE_MS, 3000);
});

test('U08 backend snapshots never replace editable entries or settings workspace', () => {
    state.setEntries([{ root: '/draft' }]);
    state.setDefaultWorkspace('/settings-workspace');
    state.syncStateFromSnapshot({
        platform: 'darwin',
        is_openharmony: false,
        default_workspace: '/old-workspace',
        sources: [{ root: '/old' }]
    });
    assert.deepEqual(state.getEntries(), [{ root: '/draft' }]);
    assert.equal(state.getDefaultWorkspace(), '/settings-workspace');
    assert.equal(state.getPlatform(), 'darwin');
});

const entry = (root) => ({ root, include_patterns: ['**/*'], exclude_patterns: [] });
const config = (entries, workspace = '') => ({
    default_workspace: workspace,
    applications: { filemgr: { enabled: true, entries } }
});
const copy = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function flush() {
    for (let index = 0; index < 30; index++) await Promise.resolve();
}
async function session(t, initial = [], overrides = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    let settings = config(copy(initial));
    const saves = [],
        reads = [],
        feedback = [];
    const owner = state.beginSelectionSession({
        load: async () => {
            reads.push(Date.now());
            return overrides.load ? overrides.load() : copy(settings);
        },
        save: async (request) => {
            saves.push(copy(request));
            if (overrides.save) return overrides.save(request);
            settings = config(copy(request));
            return { settings: copy(settings), reconciliation: Promise.resolve({ ok: true }) };
        },
        onFeedback: (kind) => feedback.push(kind)
    });
    await state.initializeSelectionSession(owner);
    return {
        owner,
        saves,
        reads,
        feedback,
        update: (next) => {
            settings = next;
        }
    };
}
function success(entries, workspace = '', reconciliation = Promise.resolve({ ok: true })) {
    return { settings: config(entries, workspace), reconciliation };
}

test('U01 2999/3000ms and consecutive selection debounce use latest entries', async (t) => {
    const h = await session(t);
    state.editEntries([entry('/first')]);
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(h.saves.length, 0);
    state.editEntries([entry('/latest')]);
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(h.saves.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(h.saves, [[entry('/latest')]]);
    assert.equal(state.getSelectionStatus().dueAt, null);
    assert.equal(state.getSnapshot(), null);
});

test('U02 R1 undo preserves earlier unsaved new entry and grants it a new deadline', async (t) => {
    const existing = entry('/existing'),
        added = entry('/new');
    const h = await session(t, [existing]);
    state.editEntries([existing, added]);
    t.mock.timers.tick(1000);
    state.editEntries([{ ...existing, exclude_patterns: ['sub/**'] }, added], { undoable: true });
    t.mock.timers.tick(1000);
    assert.deepEqual(state.rollbackUndo(), [existing, added]);
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(h.saves.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(h.saves, [[existing, added]]);
});

test('U02 undo back to known baseline does not write an equivalent selection', async (t) => {
    const h = await session(t, [entry('/old')]);
    state.editEntries([], { undoable: true });
    assert.deepEqual(state.rollbackUndo(), [entry('/old')]);
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(h.saves.length, 0);
});

test('U03 undo is valid at 2999ms, consumed once, superseded and invalid exactly at expiry', async (t) => {
    await session(t, [entry('/old')]);
    state.editEntries([], { undoable: true });
    const token = state.getUndo().token;
    t.mock.timers.tick(2999);
    assert.ok(state.rollbackUndo(token));
    assert.equal(state.rollbackUndo(token), null);
    state.editEntries([], { undoable: true });
    const old = state.getUndo().token;
    state.editEntries([entry('/other')], { undoable: true });
    assert.equal(state.rollbackUndo(old), null);
    const latest = state.getUndo().token;
    // Advance Date without running timers: boundary correctness is independent of timer ordering.
    t.mock.timers.setTime(Date.now() + 3000);
    assert.equal(state.rollbackUndo(latest), null);
});

test('U03 waiting for the occupied slot never extends the undo window', async (t) => {
    const pending = deferred();
    const h = await session(t, [], {
        save: async (value) => (h.saves.length === 1 ? pending.promise : success(value))
    });
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/request'), entry('/new')], { undoable: true });
    const token = state.getUndo().token;
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.saves.length, 1);
    assert.equal(state.rollbackUndo(token), null);
    pending.resolve(success([entry('/request')]));
    await flush();
    assert.equal(h.saves.length, 2);
});

test('U04 old success preserves a different latest selection, undo and original deadline through reconciliation', async (t) => {
    const pending = deferred(),
        reconcile = deferred();
    const h = await session(t, [], {
        save: async (value) => (h.saves.length === 1 ? pending.promise : success(value))
    });
    state.editEntries([entry('/first')]);
    t.mock.timers.tick(3000);
    await flush();
    t.mock.timers.tick(500);
    state.editEntries([entry('/new')], { undoable: true });
    const undo = state.getUndo(),
        deadline = state.getSelectionStatus().dueAt;
    pending.resolve(success([entry('/first')], '', reconcile.promise));
    await flush();
    assert.deepEqual(state.getEntries(), [entry('/new')]);
    assert.equal(state.getUndo(), undo);
    assert.equal(state.getSelectionStatus().dueAt, deadline);
    t.mock.timers.tick(4000);
    await flush();
    assert.equal(h.saves.length, 1);
    reconcile.resolve({ ok: true });
    await flush();
    assert.deepEqual(h.saves[1], [entry('/new')]);
});

test('U04 undo to old baseline remains necessary after an older request writes another value', async (t) => {
    const pending = deferred();
    const h = await session(t, [entry('/old')], {
        save: async (value) => (h.saves.length === 1 ? pending.promise : success(value))
    });
    state.editEntries([entry('/first')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/old')]);
    state.editEntries([], { undoable: true });
    assert.deepEqual(state.rollbackUndo(), [entry('/old')]);
    pending.resolve(success([entry('/first')]));
    await flush();
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(h.saves[1], [entry('/old')]);
});

test('U05 R3 absorbs the effective workspace entries as the sole baseline', async (t) => {
    const effective = [entry('/parent'), entry('/parent/child')];
    const h = await session(t, [], { save: async () => success(effective, '/parent/child') });
    state.editEntries([entry('/parent')]);
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(state.getEntries(), effective);
    assert.deepEqual(state.getSavedEntries(), effective);
    assert.equal(state.getDefaultWorkspace(), '/parent/child');
    assert.equal(h.saves.length, 1);
    state.editEntries(copy(effective));
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.saves.length, 1);
});

test('U05 exact comparison ignores object field order but preserves array order and raw roots', () => {
    assert.equal(
        state.entriesEqual([{ root: 'D:', exclude_patterns: [] }], [{ exclude_patterns: [], root: 'D:' }]),
        true
    );
    assert.equal(state.entriesEqual([{ root: 'D:' }], [{ root: 'D:/' }]), false);
    assert.equal(state.entriesEqual([{ root: '/a' }, { root: '/b' }], [{ root: '/b' }, { root: '/a' }]), false);
});

test('U06 consumed undo restoring in-flight request absorbs effective result without another write', async (t) => {
    const pending = deferred(),
        effective = [entry('/parent'), entry('/parent/child')];
    const h = await session(t, [], { save: async () => pending.promise });
    state.editEntries([entry('/parent')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/excluded')], { undoable: true });
    state.rollbackUndo();
    pending.resolve(success(effective, '/parent/child'));
    await flush();
    assert.deepEqual(state.getEntries(), effective);
    assert.equal(state.getSelectionStatus().dueAt, null);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.saves.length, 1);
});

test('U06 effective absorption never rewrites a still valid undo snapshot', async (t) => {
    const pending = deferred();
    const h = await session(t, [], {
        save: async (value) => (h.saves.length === 1 ? pending.promise : success(value))
    });
    state.editEntries([entry('/parent')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/other')]);
    state.editEntries([entry('/parent')], { undoable: true });
    const operation = state.getUndo();
    pending.resolve(success([entry('/parent'), entry('/child')]));
    await flush();
    assert.deepEqual(state.getEntries(), [entry('/parent')]);
    assert.equal(state.getUndo(), operation);
    assert.deepEqual(state.rollbackUndo(), [entry('/other')]);
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(h.saves[1], [entry('/other')]);
});

test('U09 idle settings sync accepts child-to-parent workspace change without saving or reviving child', async (t) => {
    const h = await session(t, [entry('/parent/child')]);
    h.update(config([entry('/parent')], '/parent'));
    state.requestSettingsSync(h.owner);
    await flush();
    assert.deepEqual(state.getEntries(), [entry('/parent')]);
    assert.equal(state.getDefaultWorkspace(), '/parent');
    state.editEntries([...state.getEntries(), entry('/new')]);
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(h.saves, [[entry('/parent'), entry('/new')]]);
});

test('U09 protected notifications defer; editing during a read invalidates the old result', async (t) => {
    const read = deferred();
    let nextRead = false;
    const h = await session(t, [], { load: () => (nextRead ? read.promise : config([])) });
    nextRead = true;
    state.requestSettingsSync(h.owner);
    await flush();
    state.editEntries([entry('/draft')]);
    const deadline = state.getSelectionStatus().dueAt;
    read.resolve(config([entry('/external')], '/external'));
    await flush();
    assert.deepEqual(state.getEntries(), [entry('/draft')]);
    assert.equal(state.getDefaultWorkspace(), '');
    assert.equal(state.getSelectionStatus().dueAt, deadline);
    nextRead = false;
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.saves.length, 1);
});

test('U09 a new notification invalidates a read; failures wait for a real next notification', async (t) => {
    const read = deferred();
    let loadNumber = 0;
    const h = await session(t, [], {
        load: () => {
            loadNumber++;
            if (loadNumber === 2) return read.promise;
            return config([entry(loadNumber > 2 ? '/latest' : '/initial')]);
        }
    });
    state.requestSettingsSync(h.owner);
    await flush();
    state.requestSettingsSync(h.owner);
    read.resolve(config([entry('/stale')]));
    await flush();
    assert.deepEqual(state.getEntries(), [entry('/latest')]);
    assert.equal(h.reads.length, 3);
    const before = h.reads.length;
    h.owner.load = async () => {
        h.reads.push(Date.now());
        throw Error('offline');
    };
    state.requestSettingsSync(h.owner);
    await flush();
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(h.reads.length, before + 1);
});

test('U10 save success with reconcile failure retains effective baseline and does not retry', async (t) => {
    const h = await session(t, [], { save: async (value) => success(value, '', Promise.resolve({ ok: false })) });
    state.editEntries([entry('/saved')]);
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(state.getSavedEntries(), [entry('/saved')]);
    assert.deepEqual(h.feedback, ['reconcileFailed']);
    t.mock.timers.tick(9000);
    await flush();
    assert.equal(h.saves.length, 1);
});

test('U10 unknown save rereads once, does not claim success or automatically retry', async (t) => {
    const h = await session(t, [], {
        save: async () => {
            throw Object.assign(Error('IPC lost'), { saveAttempted: true });
        }
    });
    h.update(config([entry('/in-memory')]));
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.reads.length, 2);
    assert.deepEqual(state.getEntries(), [entry('/in-memory')]);
    assert.deepEqual(h.feedback, ['unknownReloaded']);
    t.mock.timers.tick(9000);
    await flush();
    assert.equal(h.saves.length, 1);
});

test('U10 unknown reread failure makes baseline unknown; an existing edit equal to old baseline still saves', async (t) => {
    const read = deferred();
    let loads = 0;
    const h = await session(t, [entry('/old')], {
        load: () => (++loads === 1 ? config([entry('/old')]) : read.promise),
        save: async (value) => {
            if (h.saves.length === 1) throw Object.assign(Error('IPC lost'), { saveAttempted: true });
            return success(value);
        }
    });
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/old')], { undoable: true });
    const token = state.getUndo().token;
    read.reject(Error('read failed'));
    await flush();
    assert.equal(state.getSavedEntries(), null);
    assert.equal(state.getUndo().token, token);
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(h.saves[1], [entry('/old')]);
    assert.equal(loads, 2);
});

test('U10 pre-save failure does not reread, swallow latest edit or recreate the consumed deadline', async (t) => {
    const pending = deferred();
    const h = await session(t, [], {
        save: async (value) => (h.saves.length === 1 ? pending.promise : success(value))
    });
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/latest')], { undoable: true });
    const deadline = state.getSelectionStatus().dueAt;
    pending.reject(Error('load before save failed'));
    await flush();
    assert.equal(h.reads.length, 1);
    assert.equal(state.getSelectionStatus().dueAt, deadline);
    assert.ok(state.getUndo());
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(h.saves[1], [entry('/latest')]);
});

test('U11 close cancels unsent changes; immediate reopen waits for issued save and reconcile before reading', async (t) => {
    const pending = deferred(),
        reconcile = deferred();
    const h = await session(t, [], { save: async () => pending.promise });
    state.editEntries([entry('/cancelled')]);
    state.closeSelectionSession(h.owner);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.saves.length, 0);
    const old = state.beginSelectionSession({
        load: async () => config([]),
        save: async () => pending.promise,
        onFeedback: (x) => h.feedback.push(x)
    });
    await state.initializeSelectionSession(old);
    state.editEntries([entry('/issued')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/never-issued')]);
    state.closeSelectionSession(old);
    let freshReads = 0;
    const fresh = state.beginSelectionSession({
        load: async () => {
            freshReads++;
            return config([entry('/effective')]);
        },
        save: async () => {
            throw Error('unexpected');
        }
    });
    const initializing = state.initializeSelectionSession(fresh);
    await flush();
    assert.equal(freshReads, 0);
    pending.resolve(success([entry('/issued')], '', reconcile.promise));
    await flush();
    assert.equal(freshReads, 0);
    reconcile.resolve({ ok: true });
    await initializing;
    assert.equal(freshReads, 1);
    assert.deepEqual(state.getEntries(), [entry('/effective')]);
    assert.deepEqual(h.feedback, []);
});

test('U11 old settings read cannot initialize a reopened page', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const pending = deferred();
    const old = state.beginSelectionSession({ load: () => pending.promise });
    const oldInit = state.initializeSelectionSession(old);
    state.closeSelectionSession(old);
    const fresh = state.beginSelectionSession({ load: async () => config([entry('/new-page')]) });
    await state.initializeSelectionSession(fresh);
    pending.resolve(config([entry('/old-page')]));
    await oldInit;
    assert.deepEqual(state.getEntries(), [entry('/new-page')]);
});

test('U12 immediate delete serializes with an occupied slot and retains latest choices', async (t) => {
    const pending = deferred();
    const h = await session(t, [entry('/remove')], {
        save: async (value) => (h.saves.length === 1 ? pending.promise : success(value))
    });
    state.editEntries([entry('/remove'), entry('/before')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([...state.getEntries(), entry('/new')]);
    const deletion = state.commitEntriesNow(state.getEntries().filter((item) => item.root !== '/remove'));
    await flush();
    assert.equal(h.saves.length, 1);
    pending.resolve(success([entry('/remove'), entry('/before')]));
    await deletion;
    assert.deepEqual(h.saves[1], [entry('/before'), entry('/new')]);
});

test('U09 notifications during local edits are read once after protection ends', async (t) => {
    const h = await session(t);
    state.editEntries([entry('/local')], { undoable: true });
    state.requestSettingsSync(h.owner);
    state.requestSettingsSync(h.owner);
    await flush();
    assert.equal(h.reads.length, 1);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.reads.length, 2);
    assert.deepEqual(state.getEntries(), [entry('/local')]);
});

test('U10 unknown-result reread updates only baseline when a later edit has its own undo and deadline', async (t) => {
    const read = deferred();
    let reads = 0;
    const h = await session(t, [], {
        load: () => (++reads === 1 ? config([]) : read.promise),
        save: async (value) => {
            if (h.saves.length === 1) throw Object.assign(Error('unknown'), { saveAttempted: true });
            return success(value);
        }
    });
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/latest')], { undoable: true });
    const operation = state.getUndo(),
        deadline = state.getSelectionStatus().dueAt;
    read.resolve(config([entry('/effective-old')]));
    await flush();
    assert.deepEqual(state.getSavedEntries(), [entry('/effective-old')]);
    assert.deepEqual(state.getEntries(), [entry('/latest')]);
    assert.equal(state.getUndo(), operation);
    assert.equal(state.getSelectionStatus().dueAt, deadline);
    assert.deepEqual(h.feedback, []);
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(h.saves[1], [entry('/latest')]);
});

test('U10 unknown reread failure with no new operation never retries or turns null baseline into empty', async (t) => {
    let reads = 0;
    const h = await session(t, [], {
        load: async () => {
            if (++reads === 1) return config([]);
            throw Error('reread failed');
        },
        save: async () => {
            throw Object.assign(Error('unknown'), { saveAttempted: true });
        }
    });
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(state.getSavedEntries(), null);
    assert.deepEqual(state.getEntries(), [entry('/request')]);
    assert.equal(state.getSelectionStatus().dueAt, null);
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(h.saves.length, 1);
    assert.equal(reads, 2);
    assert.deepEqual(h.feedback, ['unknownFailed']);
});

test('U05 old success cannot describe a different newer choice as saved even if it equals effective config', async (t) => {
    const pending = deferred();
    const h = await session(t, [], { save: async () => pending.promise });
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    state.editEntries([entry('/effective')]);
    const deadline = state.getSelectionStatus().dueAt;
    pending.resolve(success([entry('/effective')]));
    await flush();
    assert.deepEqual(h.feedback, []);
    assert.equal(state.getSelectionStatus().dueAt, null);
    // An equivalent current value can lose its unnecessary deadline at slot release, without a success toast.
    assert.ok(deadline !== null);
    assert.equal(h.saves.length, 1);
});

test('U10 one qualified unknown-result reread consumes already deferred settings notifications', async (t) => {
    const h = await session(t, [], {
        save: async () => {
            state.requestSettingsSync(h.owner);
            throw Object.assign(Error('response lost after notification'), { saveAttempted: true });
        }
    });
    state.editEntries([entry('/request')]);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.reads.length, 2);
    assert.equal(h.saves.length, 1);
    assert.deepEqual(h.feedback, ['unknownReloaded']);
});
