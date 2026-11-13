import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InteractiveTerminalSessionManager } from '../../../../main/applications/terminal/interactive/session-manager.js';

function fixture() {
    const events: any[] = [];
    const calls: any[] = [];
    let data = (_value: string) => {};
    let exit = (_code: number) => {};
    const process = {
        onData: (fn: typeof data) => {
            data = fn;
            return { dispose() {} };
        },
        onExit: (fn: typeof exit) => {
            exit = fn;
            return { dispose() {} };
        },
        write: (value: string) => calls.push(['write', value]),
        resize: (cols: number, rows: number) => calls.push(['resize', cols, rows]),
        pause: () => calls.push(['pause']),
        resume: () => calls.push(['resume']),
        kill: () => calls.push(['kill'])
    };
    const owner = { send: (event: unknown) => events.push(event), isAlive: () => true };
    const manager = new InteractiveTerminalSessionManager({
        profiles: () => [{ id: 'pwsh', kind: 'powershell', path: 'C:/pwsh.exe' }],
        resolveCwd: (taskId: string, cwd?: string) => {
            assert.equal(taskId, 'task-a');
            return cwd || 'C:/task-workspace';
        },
        environment: () => ({ PATH: 'C:/bin' }),
        spawn: (options: unknown) => {
            calls.push(['spawn', options]);
            return process;
        }
    });
    return { manager, owner, events, calls, data: (value: string) => data(value), exit: (code: number) => exit(code) };
}

test('PTY starts only after renderer knows its session id, using the task workspace', () => {
    const f = fixture();
    const info = f.manager.create(f.owner, { taskId: 'task-a', profileId: 'pwsh' });
    assert.equal(f.calls.length, 0);
    assert.equal(info.cwd, 'C:/task-workspace');
    f.manager.start(f.owner, info.sessionId);
    f.data('first prompt');
    assert.equal(f.events[0].sessionId, info.sessionId);
    assert.equal(f.events[0].data, 'first prompt');
    f.manager.write(f.owner, info.sessionId, '\x03');
    f.manager.resize(f.owner, info.sessionId, 88, 24);
    assert.deepEqual(f.calls.slice(-2), [
        ['write', '\x03'],
        ['resize', 88, 24]
    ]);
    f.manager.closeAll();
});

test('different renderer frames cannot write, resize or close another session', () => {
    const f = fixture();
    const { sessionId } = f.manager.create(f.owner, { taskId: 'task-a', profileId: 'pwsh' });
    const stranger = { send() {}, isAlive: () => true };
    assert.throws(() => f.manager.write(stranger, sessionId, 'bad'), /sessionMissing/);
    assert.throws(() => f.manager.resize(stranger, sessionId, 90, 30), /sessionMissing/);
    assert.throws(() => f.manager.close(stranger, sessionId), /sessionMissing/);
    f.manager.close(f.owner, sessionId);
    f.manager.close(f.owner, sessionId);
    assert.equal(f.calls.length, 0);
});

test('renderer ACK applies backpressure and exit is delivered once after final output', () => {
    const f = fixture();
    const { sessionId } = f.manager.create(f.owner, { taskId: 'task-a', profileId: 'pwsh' });
    f.manager.start(f.owner, sessionId);
    f.data('x'.repeat(300_000));
    assert.equal(f.calls.at(-1)[0], 'pause');
    f.manager.acknowledge(f.owner, sessionId, 300_000);
    assert.equal(f.calls.at(-1)[0], 'resume');
    f.data('tail');
    f.exit(7);
    f.exit(7);
    assert.equal(f.events.at(-2).data, 'tail');
    assert.deepEqual(f.events.at(-1), { type: 'exit', sessionId, exitCode: 7 });
    f.manager.acknowledge(f.owner, sessionId, 4);
    f.manager.closeAll();
});

test('invalid options, sizes and excess sessions are rejected before spawning', () => {
    const f = fixture();
    for (const options of [
        null,
        {},
        { taskId: 'task-a', profileId: 'missing' },
        { taskId: 'task-a', profileId: 'pwsh', cols: -1 }
    ]) {
        assert.throws(() => f.manager.create(f.owner, options as any));
    }
    for (let i = 0; i < 8; i++) f.manager.create(f.owner, { taskId: 'task-a', profileId: 'pwsh' });
    assert.throws(() => f.manager.create(f.owner, { taskId: 'task-a', profileId: 'pwsh' }), /sessionLimit/);
    f.manager.closeOwner(f.owner);
    assert.equal(f.calls.length, 0);
});
