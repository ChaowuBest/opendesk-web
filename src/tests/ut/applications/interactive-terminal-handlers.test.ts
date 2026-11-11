import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const handlers = new Map<string, (...args: any[]) => any>();
let willQuit: undefined | (() => void);

jest.unstable_mockModule('electron', () => ({
    app: {
        once: (_name: string, callback: () => void) => {
            willQuit = callback;
        }
    },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }
}));
jest.unstable_mockModule('../../../main/applications/terminal/scan.js', () => ({
    // The sandboxed bash must be filtered out before renderer sees profiles.
    // Real scanning never reports cmd on win32; the ComSpec entry is the only cmd source.
    // Fixture paths must be POSIX-style: profile building filters candidates through the
    // real path.isAbsolute, which rejects "C:/..." on the Linux CI runner while accepting
    // "/shells/..." on both platforms (win32 treats a leading slash as the drive root).
    scanSupportedShells: () => [
        { kind: 'powershell', path: '/shells/pwsh.exe', sandboxed: false },
        { kind: 'bash', path: '/shells/bash.exe', sandboxed: true }
    ]
}));
jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: {
        getInstance: () => ({
            taskManagerState: {
                getTask: (taskId: string) =>
                    taskId === 'task-1' ? { getWorkspace: () => 'D:/tasks/task-1' } : undefined
            }
        })
    }
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getEffectiveWorkspace: () => 'D:/default-workspace' }) }
}));

const spawnCalls: any[] = [];
const procCalls: string[][] = [];
let emitData = (_data: string) => {};
let emitExit = (_code: number) => {};
jest.unstable_mockModule('../../../main/applications/terminal/interactive/pty.js', () => ({
    spawnTerminalProcess: (options: unknown) => {
        spawnCalls.push(options);
        return {
            onData: (listener: (data: string) => void) => {
                emitData = listener;
                return { dispose() {} };
            },
            onExit: (listener: (code: number) => void) => {
                emitExit = listener;
                return { dispose() {} };
            },
            write: (data: string) => procCalls.push(['write', data]),
            resize: (cols: number, rows: number) => procCalls.push(['resize', cols, rows]),
            pause: () => procCalls.push(['pause']),
            resume: () => procCalls.push(['resume']),
            kill: () => procCalls.push(['kill'])
        };
    }
}));

describe('interactive terminal IPC', () => {
    let register: () => void;
    const profileId = 'powershell:/shells/pwsh.exe';

    beforeAll(async () => {
        ({ registerInteractiveTerminalHandlers: register } =
            await import('../../../main/applications/terminal/interactive/handlers.js'));
        register();
    });
    beforeEach(() => {
        spawnCalls.length = 0;
        procCalls.length = 0;
    });

    function connect() {
        const sent: Array<{ channel: string; payload: any }> = [];
        let destroyed = false;
        const destroyedCallbacks: Array<() => void> = [];
        const sender = {
            isDestroyed: () => destroyed,
            send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
            once: (_name: string, callback: () => void) => {
                destroyedCallbacks.push(() => {
                    destroyed = true;
                    callback();
                });
            }
        };
        return {
            sent,
            destroy: () => destroyedCallbacks.forEach((run) => run()),
            invoke: (name: string, ...args: any[]) => handlers.get(`terminal:${name}`)!({ sender }, ...args)
        };
    }

    test('listProfiles returns scanned profiles instead of throwing', () => {
        const frame = connect();
        const expected = [{ id: profileId, kind: 'powershell', path: '/shells/pwsh.exe' }];
        // On Windows the ComSpec shell is appended from the real environment.
        if (process.platform === 'win32' && process.env.ComSpec) {
            expected.push({ id: `cmd:${process.env.ComSpec}`, kind: 'cmd', path: process.env.ComSpec });
        }
        expect(frame.invoke('listProfiles')).toEqual({ status: 'ok', data: expected });
    });

    test('create reserves the session without spawning; start spawns in the task workspace and forwards output', () => {
        const frame = connect();
        const created = frame.invoke('create', { taskId: 'task-1', profileId, cols: 120, rows: 30 });
        expect(created.status).toBe('ok');
        expect(created.data).toMatchObject({ cwd: 'D:/tasks/task-1', backend: 'pty' });
        expect(spawnCalls).toHaveLength(0);

        frame.invoke('start', created.data.sessionId);
        expect(spawnCalls[0]).toMatchObject({
            profile: { kind: 'powershell', path: '/shells/pwsh.exe' },
            cwd: 'D:/tasks/task-1',
            cols: 120,
            rows: 30
        });

        emitData('first prompt');
        expect(frame.sent).toEqual([
            { channel: 'terminal:data', payload: { sessionId: created.data.sessionId, data: 'first prompt' } }
        ]);

        frame.invoke('write', created.data.sessionId, 'dir\r');
        frame.invoke('resize', created.data.sessionId, 88, 26);
        expect(procCalls.at(-2)).toEqual(['write', 'dir\r']);
        expect(procCalls.at(-1)).toEqual(['resize', 88, 26]);

        emitExit(3);
        expect(frame.sent.at(-1)).toEqual({
            channel: 'terminal:exit',
            payload: { sessionId: created.data.sessionId, exitCode: 3 }
        });
        expect(procCalls.some((call) => call[0] === 'kill')).toBe(false);
    });

    test('acknowledge drives backpressure across the IPC channel', () => {
        const frame = connect();
        const { data } = frame.invoke('create', { taskId: 'task-1', profileId });
        frame.invoke('start', data.sessionId);
        emitData('x'.repeat(300_000));
        expect(procCalls.at(-1)).toEqual(['pause']);
        frame.invoke('acknowledge', data.sessionId, 300_000);
        expect(procCalls.at(-1)).toEqual(['resume']);
        frame.invoke('close', data.sessionId);
    });

    test('sessions without a task run in the configured workspace', () => {
        const frame = connect();
        const { data } = frame.invoke('create', { profileId });
        expect(data.cwd).toBe('D:/default-workspace');
        frame.invoke('close', data.sessionId);
    });

    test('a destroyed renderer frame loses its sessions and cannot reach them again', () => {
        const frame = connect();
        const { data } = frame.invoke('create', { taskId: 'task-1', profileId });
        frame.invoke('start', data.sessionId);
        frame.destroy();
        expect(procCalls.at(-1)).toEqual(['kill']);
        expect(frame.invoke('write', data.sessionId, 'x')).toEqual({ status: 'error', message: 'sessionMissing' });
    });

    test('will-quit kills every live session', () => {
        const frame = connect();
        const { data } = frame.invoke('create', { taskId: 'task-1', profileId });
        frame.invoke('start', data.sessionId);
        willQuit!();
        expect(procCalls.filter((call) => call[0] === 'kill')).toHaveLength(1);
    });
});
