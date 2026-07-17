import { describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import {
    installApplicationFrameProxies,
    registerApplicationFrameProxyHost
} from '../../../renderer/scripts/application-frame-proxy.js';

const CHANNEL = 'OD_FRAME_API';

function dispatchMessage(window: any, data: unknown, source?: unknown): void {
    const event = new window.Event('message');
    Object.defineProperty(event, 'data', { value: data });
    if (source) {
        Object.defineProperty(event, 'source', { value: source });
    }
    window.dispatchEvent(event);
}

describe('application frame task manager proxy', () => {
    test('bridges task updates and tool callbacks without cloning functions', async () => {
        const { window } = parseHTML('<html><body></body></html>');
        const postMessage = jest.fn();
        Object.defineProperty(window, 'parent', { value: { postMessage } });
        Object.assign(globalThis, { window, document: window.document });

        expect(installApplicationFrameProxies('mailbox')).toBe(true);

        const taskUpdate = jest.fn();
        const subscriptionPromise = (window as any).taskManagerAPI.subscribeTaskUpdate('task-1', taskUpdate);
        const subscriptionRequest = postMessage.mock.calls[0][0];
        expect(subscriptionRequest).toMatchObject({
            channel: CHANNEL,
            api: 'taskManager',
            method: 'subscribeTaskUpdate',
            args: ['task-1']
        });
        expect(subscriptionRequest.args).toHaveLength(1);

        dispatchMessage(window, {
            channel: CHANNEL,
            requestId: subscriptionRequest.requestId,
            result: 'subscription-1'
        });
        await expect(subscriptionPromise).resolves.toBe('subscription-1');
        dispatchMessage(window, {
            channel: CHANNEL,
            type: 'taskUpdate',
            requestId: subscriptionRequest.requestId,
            progress: { task_status: 'running' }
        });
        expect(taskUpdate).toHaveBeenCalledWith({ task_status: 'running' });

        const toolCallback = jest.fn(async () => ({ draft: 'reply' }));
        const attachPromise = (window as any).taskManagerAPI.attachToolset(
            'task-1',
            { name: 'mailbox', tools: [] },
            toolCallback
        );
        const attachRequest = postMessage.mock.calls[1][0];
        expect(attachRequest).toMatchObject({
            channel: CHANNEL,
            api: 'taskManager',
            method: 'attachToolset',
            args: ['task-1', { name: 'mailbox', tools: [] }]
        });
        expect(attachRequest.args).toHaveLength(2);

        dispatchMessage(window, {
            channel: CHANNEL,
            requestId: attachRequest.requestId,
            result: null
        });
        await expect(attachPromise).resolves.toBeNull();
        dispatchMessage(window, {
            channel: CHANNEL,
            type: 'toolCall',
            callbackId: attachRequest.requestId,
            callId: 'call-1',
            toolName: 'draftReply',
            args: { tone: 'friendly' }
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(toolCallback).toHaveBeenCalledWith('draftReply', { tone: 'friendly' });
        expect(postMessage.mock.calls[2][0]).toEqual({
            channel: CHANNEL,
            type: 'toolCallResult',
            callId: 'call-1',
            result: { draft: 'reply' }
        });

        const unsubscribePromise = (window as any).taskManagerAPI.unsubscribeTaskUpdate('task-1', 'subscription-1');
        const unsubscribeRequest = postMessage.mock.calls[3][0];
        dispatchMessage(window, {
            channel: CHANNEL,
            requestId: unsubscribeRequest.requestId,
            result: null
        });
        await expect(unsubscribePromise).resolves.toBeUndefined();

        dispatchMessage(window, {
            channel: CHANNEL,
            type: 'taskUpdate',
            requestId: subscriptionRequest.requestId,
            progress: { task_status: 'stopped' }
        });
        expect(taskUpdate).toHaveBeenCalledTimes(1);
    });

    test('host relays task events and application tool results', async () => {
        const { window } = parseHTML('<html><body></body></html>');
        Object.assign(globalThis, { window, document: window.document });
        const source = { postMessage: jest.fn() };
        let hostTaskUpdate: ((progress: unknown) => void) | null = null;
        let hostToolCallback: ((toolName: string, args: unknown) => Promise<unknown>) | null = null;
        (window as any).taskManagerAPI = {
            subscribeTaskUpdate: jest.fn(async (_taskId: string, callback: (progress: unknown) => void) => {
                hostTaskUpdate = callback;
                return 'subscription-host';
            }),
            attachToolset: jest.fn(
                async (
                    _taskId: string,
                    _toolset: unknown,
                    callback: (toolName: string, args: unknown) => Promise<unknown>
                ) => {
                    hostToolCallback = callback;
                }
            )
        };

        registerApplicationFrameProxyHost();
        dispatchMessage(
            window,
            {
                channel: CHANNEL,
                requestId: 'subscription-request',
                api: 'taskManager',
                method: 'subscribeTaskUpdate',
                args: ['task-1']
            },
            source
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(source.postMessage).toHaveBeenCalledWith(
            { channel: CHANNEL, requestId: 'subscription-request', result: 'subscription-host' },
            '*'
        );

        hostTaskUpdate?.({ task_status: 'running' });
        expect(source.postMessage).toHaveBeenCalledWith(
            {
                channel: CHANNEL,
                type: 'taskUpdate',
                requestId: 'subscription-request',
                progress: { task_status: 'running' }
            },
            '*'
        );

        dispatchMessage(
            window,
            {
                channel: CHANNEL,
                requestId: 'attach-request',
                api: 'taskManager',
                method: 'attachToolset',
                args: ['task-1', { name: 'mailbox', tools: [] }]
            },
            source
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(hostToolCallback).not.toBeNull();

        const toolResultPromise = hostToolCallback?.('draftReply', { tone: 'friendly' });
        const toolCall = source.postMessage.mock.calls.find(([message]) => message.type === 'toolCall')?.[0];
        expect(toolCall).toMatchObject({
            channel: CHANNEL,
            type: 'toolCall',
            callbackId: 'attach-request',
            toolName: 'draftReply',
            args: { tone: 'friendly' }
        });
        dispatchMessage(window, {
            channel: CHANNEL,
            type: 'toolCallResult',
            callId: toolCall.callId,
            result: 'drafted reply'
        });
        await expect(toolResultPromise).resolves.toBe('drafted reply');
    });
});
