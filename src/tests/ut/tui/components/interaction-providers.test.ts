import { jest } from '@jest/globals';
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
