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

describe('ChannelInteractionService selection', () => {
    test('requestSelection 携带 selection payload，点选后结算出 selected', async () => {
        const sendInteraction = jest.fn(async () => {});
        const entry = makeMockEntry(sendInteraction);
        const service = new ChannelInteractionService(() => entry);

        const outcomePromise = service.requestSelection(
            { type: 'channel', channel: 'mock-channel', accountId: 'acc-1', recipientId: 'user-1' },
            {
                header: '最近的对话',
                options: [
                    { label: '任务一', value: 't1' },
                    { label: '任务二', value: 't2' }
                ]
            }
        );

        const payload = (sendInteraction.mock.calls[0] as unknown[])[0] as {
            kind: string;
            payload: { header: string; options: { label: string; value: string }[] };
        };
        expect(payload.kind).toBe('selection');
        expect(payload.payload.header).toBe('最近的对话');
        expect(payload.payload.options[1]).toEqual({ label: '任务二', value: 't2' });

        const matched = service.handleInteractionEvent('mock-channel', 'acc-1', {
            kind: 'selection',
            interactionId: payload.interactionId,
            operator: { id: 'user-1' },
            selected: 't2'
        });

        expect(matched).toBe(true);
        expect(await outcomePromise).toEqual({ selected: 't2' });
    });

    test('渠道不支持交互时 requestSelection 立即取消', async () => {
        const service = new ChannelInteractionService(() => undefined);
        const outcome = await service.requestSelection(
            { type: 'channel', channel: 'mock-channel', accountId: 'acc-1', recipientId: 'user-1' },
            { header: 'h', options: [{ label: 'a', value: 'a' }] }
        );
        expect(outcome).toEqual({ cancelled: true });
    });

    test('sendInteraction 失败时结算 cancelled 并携带错误信息', async () => {
        const sendInteraction = jest.fn(async () => {
            throw new Error('send error');
        });
        const entry = makeMockEntry(sendInteraction);
        const service = new ChannelInteractionService(() => entry);

        const outcome = await service.requestSelection(
            { type: 'channel', channel: 'mock-channel', accountId: 'acc-1', recipientId: 'user-1' },
            { header: 'h', options: [{ label: 'a', value: 'a' }] }
        );

        expect(outcome.cancelled).toBe(true);
        expect(outcome.error).toContain('send error');
    });
});

describe('ChannelInteractionService 取消范围', () => {
    test('按类型取消只影响目标类型，不会废掉仍可点击的 /list 选择卡片', async () => {
        const sendInteraction = jest.fn(async () => {});
        const entry = makeMockEntry(sendInteraction);
        const service = new ChannelInteractionService(() => entry);
        const participant = { type: 'channel', channel: 'mock-channel', accountId: 'acc-1', recipientId: 'user-1' };

        const selection = service.requestSelection(participant, {
            header: '最近的对话',
            options: [{ label: '任务一', value: 't1' }]
        });
        const ask = service.askUser(participant, { questions: [] });

        // 任务停止时只取消提问
        service.cancelChannelInteractions('mock-channel', 'acc-1', 'user-1', ['askUser']);

        expect(await ask).toEqual({ answers: {}, cancelled: true });
        expect(service.pendingCount()).toBe(1);

        // 会话级取消（如账号停止）仍然清空全部
        service.cancelChannelInteractions('mock-channel');
        expect(await selection).toEqual({ cancelled: true });
        expect(service.pendingCount()).toBe(0);
    });
});
