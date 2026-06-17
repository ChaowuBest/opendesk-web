import { jest } from '@jest/globals';
import { GlobPermissionEnforcer } from '../../../main/aikernel/security/enforcer';
import type { PermissionRequest } from '../../../main/aikernel/security/permission';

type IpcHandler = (_event: unknown, requestId: string, response: Record<string, unknown>) => void;

const ipcHandlers = new Map<string, Set<IpcHandler>>();
const sentMessages: Array<{ channel: string; args: unknown[] }> = [];

const focusedWindow = {
    isDestroyed: () => false,
    show: jest.fn(),
    focus: jest.fn(),
    webContents: {
        send: jest.fn((channel: string, ...args: unknown[]) => {
            sentMessages.push({ channel, args });
        })
    }
};

const ipcMain = {
    on: jest.fn((channel: string, handler: IpcHandler) => {
        if (!ipcHandlers.has(channel)) {
            ipcHandlers.set(channel, new Set());
        }
        ipcHandlers.get(channel)!.add(handler);
    }),
    removeListener: jest.fn((channel: string, handler: IpcHandler) => {
        ipcHandlers.get(channel)?.delete(handler);
    })
};

class MockNotification {
    static isSupported(): boolean {
        return false;
    }

    show(): void {}
    on(): void {}
}

jest.unstable_mockModule('../../../utils/electron.js', () => ({
    electron: () => ({
        BrowserWindow: {
            getAllWindows: () => [focusedWindow]
        },
        ipcMain,
        Notification: MockNotification
    })
}));

const { ElectronPermissionPromptProvider } = await import('../../../main/aikernel/security/electronPrompt');

const providers: InstanceType<typeof ElectronPermissionPromptProvider>[] = [];

function createProvider(): InstanceType<typeof ElectronPermissionPromptProvider> {
    const provider = new ElectronPermissionPromptProvider();
    providers.push(provider);
    return provider;
}

function readRequest(path: string): PermissionRequest {
    return { resourceType: 'file', action: 'read', resourcePath: path };
}

function permissionRequests(): Array<{ requestId: string; data: any }> {
    return sentMessages
        .filter((msg) => msg.channel === 'permission:request')
        .map((msg) => ({ requestId: msg.args[0] as string, data: msg.args[1] }));
}

function respond(requestId: string, response: Record<string, unknown>): void {
    for (const handler of ipcHandlers.get('permission:response') ?? []) {
        handler({}, requestId, response);
    }
}

beforeEach(() => {
    ipcHandlers.clear();
    sentMessages.length = 0;
    jest.clearAllMocks();
});

describe('ElectronPermissionPromptProvider queue', () => {
    afterEach(() => {
        for (const provider of providers.splice(0)) {
            provider.dispose();
        }
        jest.useRealTimers();
    });

    test('shows one prompt at a time and advances after one-time allow', async () => {
        const provider = createProvider();
        const first = provider.prompt([readRequest('/tmp/a.txt')], 'readFile', [], {
            taskId: 'parent',
            taskName: 'Parent',
            sourceTaskId: 'child-1',
            sourceTaskName: 'Child 1',
            parentTaskId: 'parent'
        });
        const second = provider.prompt([readRequest('/tmp/b.txt')], 'readFile', [], {
            taskId: 'parent',
            taskName: 'Parent',
            sourceTaskId: 'child-2',
            sourceTaskName: 'Child 2',
            parentTaskId: 'parent'
        });

        expect(permissionRequests()).toHaveLength(1);
        expect(permissionRequests()[0].data.taskId).toBe('parent');
        expect(permissionRequests()[0].data.sourceTaskId).toBe('child-1');

        respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
        await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });

        expect(permissionRequests()).toHaveLength(2);
        expect(permissionRequests()[1].data.sourceTaskId).toBe('child-2');

        respond(permissionRequests()[1].requestId, { decision: 'deny', rememberScope: 'none' });
        await expect(second).resolves.toMatchObject({ decision: 'deny', rememberScope: 'none' });
    });

    test('rebroadcasts current prompt until it receives a response', async () => {
        jest.useFakeTimers();
        const provider = createProvider();
        const prompt = provider.prompt([readRequest('/tmp/a.txt')], 'readFile', [], {
            taskId: 'parent',
            taskName: 'Parent',
            sourceTaskId: 'child-1',
            parentTaskId: 'parent'
        });

        expect(permissionRequests()).toHaveLength(1);
        jest.advanceTimersByTime(2000);
        expect(permissionRequests()).toHaveLength(2);

        respond(permissionRequests()[0].requestId, { decision: 'allow', rememberScope: 'none' });
        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });

        jest.advanceTimersByTime(4000);
        expect(permissionRequests()).toHaveLength(2);
    });

    test('persistent allow waits for rule write, then filters queued allowed requests', async () => {
        const provider = createProvider();
        const first = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-1',
                sourceTaskName: 'Child 1',
                parentTaskId: 'parent'
            }
        );
        const second = provider.prompt(
            [readRequest('/tmp/b.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-2',
                sourceTaskName: 'Child 2',
                parentTaskId: 'parent'
            }
        );

        expect(permissionRequests()).toHaveLength(1);
        respond(permissionRequests()[0].requestId, {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        await expect(first).resolves.toMatchObject({
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        expect(permissionRequests()).toHaveLength(1);

        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);
        await provider.notifyPermissionRulesChanged(enforcer);

        await expect(second).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(permissionRequests()).toHaveLength(1);
    });

    test('persistent allow rule changes can resolve the current prompt', async () => {
        const provider = createProvider();
        const prompt = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-1',
                sourceTaskName: 'Child 1',
                parentTaskId: 'parent'
            }
        );

        expect(permissionRequests()).toHaveLength(1);

        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);
        await provider.notifyPermissionRulesChanged(enforcer);

        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(
            sentMessages.some(
                (msg) => msg.channel === 'permission:dismiss' && msg.args[0] === permissionRequests()[0].requestId
            )
        ).toBe(true);
    });

    test('persistent allow filter preserves protected ask priority', async () => {
        const provider = createProvider();
        const first = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-1',
                parentTaskId: 'parent'
            }
        );
        const second = provider.prompt(
            [readRequest('/tmp/.env')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-2',
                parentTaskId: 'parent'
            }
        );

        respond(permissionRequests()[0].requestId, {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        await first;

        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '**/.env', effect: 'ask' },
            { resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' }
        ]);
        await provider.notifyPermissionRulesChanged(enforcer);

        expect(permissionRequests()).toHaveLength(2);
        expect(permissionRequests()[1].data.requests[0].resourcePath).toBe('/tmp/.env');

        respond(permissionRequests()[1].requestId, { decision: 'deny', rememberScope: 'none' });
        await expect(second).resolves.toMatchObject({ decision: 'deny', rememberScope: 'none' });
    });

    test('queued prompts can timeout while waiting for persistent allow rule notification', async () => {
        jest.useFakeTimers();
        const provider = createProvider();
        const first = provider.prompt(
            [readRequest('/tmp/a.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-1',
                parentTaskId: 'parent'
            }
        );
        const second = provider.prompt(
            [readRequest('/tmp/b.txt')],
            'readFile',
            [{ label: '/tmp/', pattern: '/tmp/**' }],
            {
                taskId: 'parent',
                taskName: 'Parent',
                sourceTaskId: 'child-2',
                parentTaskId: 'parent'
            }
        );

        respond(permissionRequests()[0].requestId, {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: '/tmp/**'
        });
        await expect(first).resolves.toMatchObject({ decision: 'allow', rememberScope: 'prefix' });

        const secondSettled = jest.fn();
        second.then(secondSettled);

        jest.advanceTimersByTime(300_001);
        await Promise.resolve();
        await Promise.resolve();

        expect(secondSettled).toHaveBeenCalledWith({
            decision: 'deny',
            rememberScope: 'none',
            denyReason: 'timeout'
        });
    });
});
