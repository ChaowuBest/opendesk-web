import { jest } from '@jest/globals';
import { ChannelInteractionService } from '../../../main/applications/channelmgr/interactions.js';
import type { ChannelPlugin } from '../../../main/applications/channelmgr/types.js';

/** 构造一个支持结构化交互（interactive + sendInteraction）的 mock 渠道插件。 */
function makeMockChannelPlugin(sendInteraction: jest.Mock): ChannelPlugin {
    return {
        id: 'mock-channel',
        meta: { label: 'Mock Channel' },
        capabilities: { chatTypes: ['direct'], interactive: true },
        config: {
            listAccountIds: () => ['acc-1'],
            resolveAccount: () => undefined,
            defaultAccountId: () => 'acc-1'
        },
        sendInteraction
    } as ChannelPlugin;
}

function makeMockEntry(sendInteraction: jest.Mock) {
    return {
        id: 'mock-channel',
        channelPlugin: makeMockChannelPlugin(sendInteraction)
    };
}

describe('ChannelInteractionService 结算 rememberScope', () => {
    test('点击"始终允许"后 requestApproval 结算出 rememberScope=session', async () => {
        const sendInteraction = jest.fn(async () => {});
        const entry = makeMockEntry(sendInteraction);
        const service = new ChannelInteractionService(() => entry);

        const outcomePromise = service.requestApproval(
            { type: 'channel', channel: 'mock-channel', accountId: 'acc-1', recipientId: 'user-1' },
            { prompt: 'test', tool: 'read', requests: [] }
        );

        // sendInteraction 被调用，取其 requestPayload 里的 interactionId
        const payload = (sendInteraction.mock.calls[0] as unknown[])[0] as { interactionId: string };
        const matched = service.handleInteractionEvent('mock-channel', 'acc-1', {
            kind: 'approval',
            interactionId: payload.interactionId,
            operator: { id: 'user-1' },
            decision: 'allow',
            rememberScope: 'session'
        });

        expect(matched).toBe(true);
        const outcome = await outcomePromise;
        expect(outcome).toEqual({ decision: 'allow', rememberScope: 'session' });
    });

    test('普通 allow 结算出 rememberScope=none', async () => {
        const sendInteraction = jest.fn(async () => {});
        const entry = makeMockEntry(sendInteraction);
        const service = new ChannelInteractionService(() => entry);

        const outcomePromise = service.requestApproval(
            { type: 'channel', channel: 'mock-channel', accountId: 'acc-1', recipientId: 'user-1' },
            { prompt: 'test', tool: 'read', requests: [] }
        );

        const payload = (sendInteraction.mock.calls[0] as unknown[])[0] as { interactionId: string };
        const matched = service.handleInteractionEvent('mock-channel', 'acc-1', {
            kind: 'approval',
            interactionId: payload.interactionId,
            operator: { id: 'user-1' },
            decision: 'allow'
        });

        expect(matched).toBe(true);
        const outcome = await outcomePromise;
        expect(outcome).toEqual({ decision: 'allow', rememberScope: 'none' });
    });
});
