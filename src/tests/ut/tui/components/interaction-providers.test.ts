import { jest } from '@jest/globals';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { InteractionDeliveryChannel } from '../../../../main/aikernel/interaction/delivery.js';
import { MobileInteractionDeliveryEndpoint } from '../../../../main/applications/mobileaccess/acp/mobile/interaction/delivery-endpoint.js';
import { MAX_INTERACTION_BYTES } from '../../../../main/applications/mobileaccess/acp/mobile/interaction/message-mapper.js';
import { TUIAskUserProvider, AskUserWidget } from '../../../../main/tui/components/askUser.js';
import { TUIExitPlanModeProvider, ExitPlanModeWidget } from '../../../../main/tui/components/exitPlanMode.js';
import { TUIPermissionPromptProvider, PermissionPromptWidget } from '../../../../main/tui/components/permission.js';

function fakeTui() {
    const widgets: unknown[] = [];
    return {
        widgets,
        inputArea: {
            showPromptWidget: jest.fn((widget: unknown) => widgets.push(widget)),
            hidePromptWidget: jest.fn()
        },
        closeInputPrompt: jest.fn(() => null),
        focusAfterInputPromptClose: jest.fn(),
        focusInputAreaIfAvailable: jest.fn(),
        isInputBlocked: jest.fn(() => false),
        activeTaskId: 'child',
        getActiveTaskId: jest.fn(() => 'child'),
        setMode: jest.fn(async () => true),
        tui: {
            requestRender: jest.fn(),
            setFocus: jest.fn(),
            terminal: { rows: 40 }
        }
    } as any;
}

function fakeChannel() {
    const channel: any = {
        ask: undefined,
        exit: undefined,
        permission: undefined,
        subscribeEndpointReady: () => () => undefined,
        publishAskUser(request: unknown, answer: (response: unknown) => boolean) {
            channel.ask = { request, answer, close: jest.fn() };
            return { delivered: true, close: channel.ask.close };
        },
        publishExitPlanMode(request: unknown, answer: (response: unknown) => boolean) {
            channel.exit = { request, answer, close: jest.fn() };
            return { delivered: true, close: channel.exit.close };
        },
        publishPermission(request: unknown, answer: (response: unknown) => boolean) {
            channel.permission = { request, answer, close: jest.fn() };
            return { delivered: true, close: channel.permission.close };
        }
    };
    return channel;
}

function sizeBoundChannel() {
    const channel = new InteractionDeliveryChannel(() => 'child');
    const connection = {
        extMethod: jest.fn(async () => ({})),
        requestPermission: jest.fn(async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })),
        extNotification: jest.fn(async () => undefined)
    } as unknown as AgentSideConnection;
    channel.registerEndpoint(
        new MobileInteractionDeliveryEndpoint(
            'child',
            connection,
            new AbortController().signal,
            { authorizeInteractionAnswer() {} },
            () => undefined
        )
    );
    return { channel, connection };
}

const questions = [
    {
        question: 'First?',
        header: 'First',
        options: [
            { label: 'A', description: 'A' },
            { label: 'B', description: 'B' }
        ]
    },
    {
        question: 'Second?',
        header: 'Second',
        options: [
            { label: 'C', description: 'C' },
            { label: 'D', description: 'D' }
        ]
    }
];

afterEach(() => {
    jest.useRealTimers();
});

it('invalidates the AskUser next-question timer when mobile wins', async () => {
    jest.useFakeTimers();
    const tui = fakeTui();
    const channel = fakeChannel();
    const provider = new TUIAskUserProvider(tui, channel);
    const result = provider.prompt({
        requestId: 'ask-1',
        taskId: 'child',
        taskName: 'Task',
        questions
    });
    const widget = tui.widgets[0] as AskUserWidget;
    widget.onDone?.(['A']);
    expect(jest.getTimerCount()).toBe(1);
    expect(channel.ask.answer({ answers: { 0: ['A'], 1: ['C'] } })).toBe(true);
    jest.advanceTimersByTime(50);
    expect(tui.inputArea.showPromptWidget).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toEqual({ answers: { 0: ['A'], 1: ['C'] } });
});

it('latches ExitPlanMode before an asynchronous mode switch', async () => {
    const tui = fakeTui();
    const channel = fakeChannel();
    let release!: (value: boolean) => void;
    tui.setMode.mockReturnValue(
        new Promise<boolean>((resolve) => {
            release = resolve;
        })
    );
    const provider = new TUIExitPlanModeProvider(tui, channel);
    const result = provider.promptAndSwitch('# Plan', '/work/.plan/ship.md', 'child', 'Task', {
        planRelativePath: '.plan/ship.md'
    });
    const widget = tui.widgets[0] as ExitPlanModeWidget;
    expect(channel.exit.answer({ action: 'execute-standard' })).toBe(true);
    widget.onDone?.('continue-editing');
    expect(tui.setMode).toHaveBeenCalledTimes(1);
    release(true);
    await expect(result).resolves.toEqual({ action: 'execute-standard' });
});

it('publishes Permission only after it becomes active and reuses the typed option responses', async () => {
    const tui = fakeTui();
    const channel = fakeChannel();
    const provider = new TUIPermissionPromptProvider(tui, channel);
    const result = provider.prompt(
        [{ resourceType: 'file', action: 'read', resourcePath: '/work/a.txt' }],
        'shell',
        [{ label: '/work/', pattern: '/work/**' }],
        { taskId: 'child', taskName: 'Task', sourceTaskId: 'child' }
    );
    expect(tui.widgets[0]).toBeInstanceOf(PermissionPromptWidget);
    expect(channel.permission.request.expiresAt).toBeUndefined();
    expect(channel.permission.answer(channel.permission.request.options[0].response)).toBe(true);
    await expect(result).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
});

it('keeps invalid source ids local-only for all three providers', async () => {
    const tui = fakeTui();
    const channel = fakeChannel();
    const ask = new TUIAskUserProvider(tui, channel);
    const exit = new TUIExitPlanModeProvider(tui, channel);
    const permission = new TUIPermissionPromptProvider(tui, channel);
    const askResult = ask.prompt({ requestId: 'a', taskId: 'unknown', taskName: null, questions: [questions[0]] });
    (tui.widgets.at(-1) as AskUserWidget).onDone?.(['A']);
    await askResult;
    const exitResult = exit.promptAndSwitch('# Plan', '/work/.plan/a.md', undefined, 'Task', {
        planRelativePath: '.plan/a.md'
    });
    (tui.widgets.at(-1) as ExitPlanModeWidget).onCancel?.();
    await exitResult;
    const permissionResult = permission.prompt(
        [{ resourceType: 'file', action: 'read', resourcePath: '/work/a' }],
        'shell',
        [],
        { taskId: 'child', taskName: 'Task' }
    );
    (tui.widgets.at(-1) as PermissionPromptWidget).getSelectList().onCancel?.();
    await permissionResult;
    expect(channel.ask).toBeUndefined();
    expect(channel.exit).toBeUndefined();
    expect(channel.permission).toBeUndefined();
});

it('keeps an oversized AskUser request on the normal local TUI path', async () => {
    const tui = fakeTui();
    const remote = sizeBoundChannel();
    const provider = new TUIAskUserProvider(tui, remote.channel);
    const result = provider.prompt({
        requestId: 'oversized-ask',
        taskId: 'child',
        taskName: 'Task',
        questions: [{ ...questions[0], question: 'x'.repeat(MAX_INTERACTION_BYTES + 1) }]
    });
    expect(tui.widgets.at(-1)).toBeInstanceOf(AskUserWidget);
    expect((remote.connection.extMethod as jest.Mock).mock.calls).toHaveLength(0);
    (tui.widgets.at(-1) as AskUserWidget).onCancel?.();
    await expect(result).resolves.toMatchObject({ cancelled: true });
});

it('keeps an oversized ExitPlanMode request on the normal local TUI path', async () => {
    const tui = fakeTui();
    const remote = sizeBoundChannel();
    const provider = new TUIExitPlanModeProvider(tui, remote.channel);
    const result = provider.promptAndSwitch(
        'x'.repeat(MAX_INTERACTION_BYTES + 1),
        '/work/.plan/large.md',
        'child',
        'Task',
        { planRelativePath: '.plan/large.md' }
    );
    expect(tui.widgets.at(-1)).toBeInstanceOf(ExitPlanModeWidget);
    expect((remote.connection.extMethod as jest.Mock).mock.calls).toHaveLength(0);
    (tui.widgets.at(-1) as ExitPlanModeWidget).onCancel?.();
    await expect(result).resolves.toEqual({ action: 'continue-editing' });
});

it('keeps Permission on its ACP/runtime size boundary and still shows the local TUI path', async () => {
    const tui = fakeTui();
    const remote = sizeBoundChannel();
    const provider = new TUIPermissionPromptProvider(tui, remote.channel);
    const result = provider.prompt(
        [{ resourceType: 'file', action: 'read', resourcePath: `/work/${'x'.repeat(MAX_INTERACTION_BYTES + 1)}` }],
        'shell',
        [],
        { taskId: 'child', taskName: 'Task', sourceTaskId: 'child' }
    );
    expect(tui.widgets.at(-1)).toBeInstanceOf(PermissionPromptWidget);
    expect((remote.connection.requestPermission as jest.Mock).mock.calls).toHaveLength(1);
    (tui.widgets.at(-1) as PermissionPromptWidget).getSelectList().onCancel?.();
    await expect(result).resolves.toMatchObject({ decision: 'deny', rememberScope: 'none' });
});

function reofferChannel() {
    const channel = new InteractionDeliveryChannel(() => 'child');
    const wire: Array<{ requestId: string; params: any; answer(payload: unknown): void }> = [];
    const connection = {
        extMethod: (_method: string, params: any) =>
            new Promise((resolve) => {
                wire.push({ requestId: params.requestId, params, answer: resolve });
            }),
        requestPermission: (params: any) =>
            new Promise((resolve) => {
                wire.push({ requestId: params._meta.opendesk.requestId, params, answer: resolve });
            }),
        extNotification: async () => undefined
    } as unknown as AgentSideConnection;
    const endpoints: MobileInteractionDeliveryEndpoint[] = [];
    const attach = (): (() => void) => {
        const endpoint = new MobileInteractionDeliveryEndpoint(
            'child',
            connection,
            new AbortController().signal,
            { authorizeInteractionAnswer() {} },
            {
                async sendFailed(send: () => Promise<void>) {
                    await send();
                },
                async invalidateLoadedSession() {},
                failConnection() {}
            },
            () => undefined
        );
        endpoints.push(endpoint);
        const unregister = channel.registerEndpoint(endpoint);
        // Replacing a loaded Session unregisters and disposes, exactly like the adapter does.
        return () => {
            unregister();
            endpoint.dispose();
        };
    };
    const settle = async (): Promise<void> => {
        for (let round = 0; round < 3; round += 1) {
            for (let index = 0; index < 8; index += 1) await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    return { channel, wire, attach, settle, dispose: () => endpoints.forEach((e) => e.dispose()) };
}

it.each(['askUser', 'exitPlanMode', 'permission'] as const)(
    're-offers the outstanding TUI %s request to a newly ready endpoint exactly once',
    async (kind) => {
        const tui = fakeTui();
        const remote = reofferChannel();
        const detach = remote.attach();
        const taskInfo = { taskId: 'child', taskName: 'Task', sourceTaskId: 'child' };
        const providers = {
            askUser: () => new TUIAskUserProvider(tui, remote.channel),
            exitPlanMode: () => new TUIExitPlanModeProvider(tui, remote.channel),
            permission: () => new TUIPermissionPromptProvider(tui, remote.channel)
        };
        const provider = providers[kind]();
        const start = (): Promise<unknown> => {
            if (kind === 'askUser') {
                return (provider as TUIAskUserProvider).prompt({
                    requestId: 'ask-reoffer',
                    questions,
                    taskId: 'child',
                    taskName: 'Task'
                } as any);
            }
            if (kind === 'exitPlanMode') {
                return (provider as TUIExitPlanModeProvider).promptAndSwitch(
                    '# Plan',
                    '/work/.plan/ship.md',
                    'child',
                    'Task',
                    { planRelativePath: '.plan/ship.md' }
                );
            }
            return (provider as TUIPermissionPromptProvider).prompt(
                [{ resourceType: 'file', action: 'read', resourcePath: '/work/a.txt' }],
                'shell',
                [],
                taskInfo
            );
        };
        const pending = start();
        await remote.settle();
        expect(remote.wire).toHaveLength(1);
        const original = remote.wire[0];

        // The phone left and came back on a new endpoint: the request must be offered again.
        detach();
        remote.attach();
        remote.channel.notifyEndpointReady();
        await remote.settle();
        expect(remote.wire).toHaveLength(2);
        expect(remote.wire[1].requestId).toBe(original.requestId);

        // Repeated readiness on the same endpoint must not deliver again.
        remote.channel.notifyEndpointReady();
        await remote.settle();
        expect(remote.wire).toHaveLength(2);

        if (kind === 'askUser') remote.wire[1].answer({ answers: { 0: ['A'], 1: ['B'] } });
        else if (kind === 'exitPlanMode') {
            remote.wire[1].answer({ schemaVersion: 1, requestId: original.requestId, action: 'continue-editing' });
        } else remote.wire[1].answer({ outcome: { outcome: 'cancelled' } });
        await expect(pending).resolves.toBeDefined();
        remote.dispose();
    }
);

it('does not re-offer a TUI request that already settled locally', async () => {
    const tui = fakeTui();
    const remote = reofferChannel();
    const detach = remote.attach();
    const provider = new TUIPermissionPromptProvider(tui, remote.channel);
    const pending = provider.prompt(
        [{ resourceType: 'file', action: 'read', resourcePath: '/work/a.txt' }],
        'shell',
        [],
        { taskId: 'child', taskName: 'Task', sourceTaskId: 'child' }
    );
    await remote.settle();
    expect(remote.wire).toHaveLength(1);
    (tui.widgets.at(-1) as PermissionPromptWidget).getSelectList().onCancel?.();
    await expect(pending).resolves.toMatchObject({ decision: 'deny' });

    detach();
    remote.attach();
    remote.channel.notifyEndpointReady();
    await remote.settle();
    expect(remote.wire).toHaveLength(1);
    remote.dispose();
});

it('advances the TUI ExitPlanMode queue after an awaited mode switch, without an external nudge', async () => {
    let releaseSwitch = (): void => undefined;
    const switching = new Promise<boolean>((resolve) => {
        releaseSwitch = () => resolve(true);
    });
    const tui = fakeTui();
    tui.setMode = jest.fn(() => switching);
    const remote = reofferChannel();
    remote.attach();
    const provider = new TUIExitPlanModeProvider(tui, remote.channel);
    const first = provider.promptAndSwitch('# first', '/work/.plan/a.md', 'child', 'Task', {
        planRelativePath: '.plan/a.md'
    });
    const second = provider.promptAndSwitch('# second', '/work/.plan/b.md', 'child', 'Task', {
        planRelativePath: '.plan/b.md'
    });
    await remote.settle();
    expect(remote.wire).toHaveLength(1);

    // Answering with a mode switch makes the Provider register its queue advance only after an await,
    // by which time the remote exit is already free.
    remote.wire[0].answer({
        schemaVersion: 1,
        requestId: remote.wire[0].requestId,
        action: 'execute-standard'
    });
    await remote.settle();
    releaseSwitch();
    await expect(first).resolves.toEqual({ action: 'execute-standard' });
    await remote.settle();

    // The second approval must reach the phone without any external processQueueIfReady() nudge.
    expect(remote.wire).toHaveLength(2);
    remote.wire[1].answer({
        schemaVersion: 1,
        requestId: remote.wire[1].requestId,
        action: 'continue-editing'
    });
    await expect(second).resolves.toEqual({ action: 'continue-editing' });
    remote.dispose();
});

it('does not activate the next TUI Permission item while the previous close is still in flight', async () => {
    let releaseTerminal = (): void => undefined;
    const terminal = new Promise<void>((resolve) => {
        releaseTerminal = resolve;
    });
    const tui = fakeTui();
    const channel = new InteractionDeliveryChannel(() => 'child');
    const wire: Array<{ requestId: string; answer(payload: unknown): void }> = [];
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'child',
        {
            requestPermission: (params: any) =>
                new Promise((resolve) => {
                    wire.push({ requestId: params._meta.opendesk.requestId, answer: resolve });
                }),
            extNotification: async () => terminal
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        {
            async sendFailed(send: () => Promise<void>) {
                await send();
            },
            async invalidateLoadedSession() {},
            failConnection() {}
        },
        () => undefined
    );
    channel.registerEndpoint(endpoint);
    const provider = new TUIPermissionPromptProvider(tui, channel);
    const taskInfo = { taskId: 'child', taskName: 'Task', sourceTaskId: 'child' };
    const settle = async (): Promise<void> => {
        for (let round = 0; round < 3; round += 1) {
            for (let index = 0; index < 8; index += 1) await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    const first = provider.prompt(
        [{ resourceType: 'file', action: 'read', resourcePath: '/work/a.txt' }],
        'shell',
        [],
        taskInfo
    );
    await settle();
    expect(wire).toHaveLength(1);
    wire[0].answer({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    await expect(first).resolves.toMatchObject({ decision: 'allow' });
    await settle();

    // A brand new request arrives while the close notification is still in flight: its own
    // processQueue() must not activate it into the still-occupied remote exit.
    const second = provider.prompt(
        [{ resourceType: 'file', action: 'read', resourcePath: '/work/b.txt' }],
        'shell',
        [],
        taskInfo
    );
    await settle();
    expect(wire).toHaveLength(1);
    releaseTerminal();
    await settle();
    expect(wire).toHaveLength(2);
    wire[1].answer({ outcome: { outcome: 'cancelled' } });
    await expect(second).resolves.toMatchObject({ decision: 'deny' });
    endpoint.dispose();
});

it('does not activate the next TUI AskUser item while the previous close is still in flight', async () => {
    let releaseTerminal = (): void => undefined;
    const terminal = new Promise<void>((resolve) => {
        releaseTerminal = resolve;
    });
    const tui = fakeTui();
    const channel = new InteractionDeliveryChannel(() => 'child');
    const wire: Array<{ requestId: string; answer(payload: unknown): void }> = [];
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'child',
        {
            extMethod: (_method: string, params: any) =>
                new Promise((resolve) => {
                    wire.push({ requestId: params.requestId, answer: resolve });
                }),
            extNotification: async () => terminal
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        {
            async sendFailed(send: () => Promise<void>) {
                await send();
            },
            async invalidateLoadedSession() {},
            failConnection() {}
        },
        () => undefined
    );
    channel.registerEndpoint(endpoint);
    const provider = new TUIAskUserProvider(tui, channel);
    const settle = async (): Promise<void> => {
        for (let round = 0; round < 3; round += 1) {
            for (let index = 0; index < 8; index += 1) await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    const ask = (requestId: string) =>
        provider.prompt({ requestId, questions: [questions[0]], taskId: 'child', taskName: 'Task' } as any);
    const first = ask('ask-window-1');
    await settle();
    expect(wire).toHaveLength(1);
    wire[0].answer({ answers: { 0: ['A'] } });
    await expect(first).resolves.toEqual({ answers: { 0: ['A'] } });
    await settle();

    // A brand new question arriving inside the closing window must wait for the exit, not be dropped.
    const second = ask('ask-window-2');
    await settle();
    expect(wire).toHaveLength(1);
    releaseTerminal();
    await settle();
    expect(wire).toHaveLength(2);
    wire[1].answer({ cancelled: true, answers: {} });
    await expect(second).resolves.toMatchObject({ cancelled: true });
    endpoint.dispose();
});
