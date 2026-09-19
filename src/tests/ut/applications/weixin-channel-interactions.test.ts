import { jest } from '@jest/globals';
import { WechatChannel } from '../../../../resources/plugins/weixin/wechat.mjs';

function makeInboundMessage(messageId: string, text: string) {
    return {
        message_id: messageId,
        message_type: 1,
        message_state: 2,
        from_user_id: 'user-1',
        item_list: [{ type: 1, text_item: { text } }]
    };
}

describe('WechatChannel interactions', () => {
    test('releases the receive loop while the dispatched task is waiting for approval', async () => {
        const channel = new WechatChannel();
        const dispatchInteraction = jest.fn(async () => {});
        channel.loadAccounts = jest.fn(() => ({
            'account-1': { token: 'token', baseUrl: 'https://example.test' }
        }));
        channel._sendText = jest.fn(async () => {});
        let releaseTask!: () => void;
        const taskFinished = new Promise<void>((resolve) => {
            releaseTask = resolve;
        });
        let taskStarted!: () => void;
        const taskDispatched = new Promise<void>((resolve) => {
            taskStarted = resolve;
        });
        const dispatch = jest.fn(async () => {
            await channel.sendInteraction({
                interactionId: 'interaction-1',
                kind: 'approval',
                accountId: 'account-1',
                to: { chatType: 'direct', recipientId: 'user-1' },
                expiresAt: Date.now() + 60_000,
                payload: { prompt: 'test', allowRemember: true }
            });
            taskStarted();
            await taskFinished;
        });

        channel.setChannelRuntimeContext({
            dispatch,
            dispatchInteraction,
            logger: {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            }
        });

        let inboundSettled = false;
        const inbound = channel._handleIncoming('account-1', {}, makeInboundMessage('message-1', '执行任务'));
        void inbound.then(() => {
            inboundSettled = true;
        });

        await taskDispatched;
        await Promise.resolve();

        try {
            expect(inboundSettled).toBe(true);
            await channel._handleIncoming('account-1', {}, makeInboundMessage('message-2', '1'));
            expect(dispatchInteraction).toHaveBeenCalledWith({
                kind: 'approval',
                interactionId: 'interaction-1',
                accountId: 'account-1',
                operator: { id: 'user-1' },
                decision: 'allow',
                rememberScope: 'none'
            });
        } finally {
            releaseTask();
            await inbound;
        }
    });

    test('accepts an approval reply before sending the prompt has completed', async () => {
        const channel = new WechatChannel();
        let completeSend!: () => void;
        const sendCompleted = new Promise<void>((resolve) => {
            completeSend = resolve;
        });
        const dispatchInteraction = jest.fn(async () => {});
        channel.loadAccounts = jest.fn(() => ({
            'account-1': { token: 'token', baseUrl: 'https://example.test' }
        }));
        channel._sendText = jest.fn(async () => sendCompleted);
        channel.setChannelRuntimeContext({
            dispatch: jest.fn(),
            dispatchInteraction,
            logger: {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            }
        });

        const sending = channel.sendInteraction({
            interactionId: 'interaction-1',
            kind: 'approval',
            accountId: 'account-1',
            to: { chatType: 'direct', recipientId: 'user-1' },
            expiresAt: Date.now() + 60_000,
            payload: { prompt: 'test', allowRemember: true }
        });

        try {
            await channel._handleIncoming('account-1', {}, makeInboundMessage('message-1', '3'));
            expect(dispatchInteraction).toHaveBeenCalledWith({
                kind: 'approval',
                interactionId: 'interaction-1',
                accountId: 'account-1',
                operator: { id: 'user-1' },
                decision: 'allow',
                rememberScope: 'session'
            });
        } finally {
            completeSend();
            await sending;
        }
    });

    test.each([
        ['1', { decision: 'allow', rememberScope: 'none' }],
        ['2', { decision: 'deny' }],
        ['3', { decision: 'allow', rememberScope: 'session' }]
    ])('dispatches approval reply %s while the task remains pending', async (reply, expected) => {
        const channel = new WechatChannel();
        const dispatchInteraction = jest.fn(async () => {});
        channel.loadAccounts = jest.fn(() => ({
            'account-1': { token: 'token', baseUrl: 'https://example.test' }
        }));
        channel._sendText = jest.fn(async () => {});
        channel.setChannelRuntimeContext({
            dispatch: jest.fn(),
            dispatchInteraction,
            logger: {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            }
        });

        await channel.sendInteraction({
            interactionId: 'interaction-1',
            kind: 'approval',
            accountId: 'account-1',
            to: { chatType: 'direct', recipientId: 'user-1' },
            expiresAt: Date.now() + 60_000,
            payload: { prompt: 'test', allowRemember: true }
        });
        await channel._handleIncoming('account-1', {}, makeInboundMessage('reply-' + reply, reply));

        expect(dispatchInteraction).toHaveBeenCalledWith({
            kind: 'approval',
            interactionId: 'interaction-1',
            accountId: 'account-1',
            operator: { id: 'user-1' },
            ...expected
        });
    });
});
