import { describe, expect, jest, test } from '@jest/globals';
import { FeishuChannel } from '../../../../resources/plugins/feishu/feishu.mjs';

/**
 * 飞书插件 selection（/list 单选列表）冒烟测试。
 * 回归点：sendInteraction → _registerInteraction 解构签名必须包含 selectionLabels，
 * 否则函数体内的属性简写会抛 ReferenceError: selectionLabels is not defined。
 */
function makeChannel() {
    const channel = new FeishuChannel();
    const ctx = {
        fetch: jest.fn(async () => ({ json: async () => ({ code: 0, data: { message_id: 'om-1' } }) })),
        dispatchInteraction: jest.fn(async () => {}),
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
        setStatus: jest.fn()
    };
    channel.loadAccounts = jest.fn(() => ({
        'account-1': { appId: 'cli-a', appSecret: 'secret', accountName: 'bot' }
    }));
    channel.setChannelRuntimeContext(ctx as never);
    return { channel, ctx };
}

const SELECTION_REQUEST = {
    interactionId: 'sel-1',
    kind: 'selection' as const,
    accountId: 'account-1',
    to: { chatType: 'direct' as const, recipientId: 'user-1' },
    expiresAt: Date.now() + 60_000,
    payload: {
        header: '最近的对话',
        hint: '提示：发送 /list N 可查看最近 N 条对话（最多 100）',
        options: [
            { label: '任务一', value: 't1' },
            { label: '任务二', value: 't2' }
        ]
    }
};

function interactions(channel: FeishuChannel): Map<string, { kind: string; selectionLabels: Record<string, string> }> {
    return (
        channel as unknown as { _interactions: Map<string, { kind: string; selectionLabels: Record<string, string> }> }
    )._interactions;
}

describe('FeishuChannel selection 卡片', () => {
    test('sendInteraction(kind=selection) 构建卡片并注册 pending 映射', async () => {
        const { channel, ctx } = makeChannel();

        const { messageId } = await channel.sendInteraction(SELECTION_REQUEST);

        expect(messageId).toBe('om-1');
        // ctx.fetch 也承载 tenant_access_token 获取，按请求体定位发卡片的调用
        const calls = (ctx.fetch as ReturnType<typeof jest.fn>).mock.calls as unknown as [string, { body: string }][];
        const cardCall = calls.find(([, init]) => init?.body?.includes('msg_type'))!;
        const body = JSON.parse(cardCall[1].body);
        expect(body.msg_type).toBe('interactive');
        const card = JSON.parse(body.content);
        expect(card.header.title.content).toBe('最近的对话');
        // 2 个选项按钮 + 末尾 hint 提示 markdown
        expect(card.body.elements).toHaveLength(3);
        expect(card.body.elements[2].tag).toBe('markdown');
        expect(card.body.elements[2].content).toBe('提示：发送 /list N 可查看最近 N 条对话（最多 100）');

        const pending = interactions(channel).get('sel-1');
        expect(pending?.kind).toBe('selection');
        expect(pending?.selectionLabels).toEqual({ t1: '任务一', t2: '任务二' });
    });

    test('点选选项回传 selected 并刷新状态卡片', async () => {
        const { channel, ctx } = makeChannel();
        await channel.sendInteraction(SELECTION_REQUEST);
        (ctx.fetch as ReturnType<typeof jest.fn>).mockClear();

        const ack = (await channel._handleCardAction('account-1', {
            event: {
                operator: { open_id: 'ou-1' },
                action: {
                    value: { oc: 'opendesk-interaction-v1', kind: 'selection', value: 't1', id: 'sel-1' }
                }
            }
        })) as { toast: { type: string; content: string } };

        expect(ctx.dispatchInteraction).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'selection',
                interactionId: 'sel-1',
                accountId: 'account-1',
                operator: { id: 'ou-1' },
                selected: 't1'
            })
        );
        expect(ack.toast).toEqual({ type: 'success', content: '已选择' });
        // 状态卡片展示所选项的 label（依赖 pending.selectionLabels 映射）
        expect(JSON.stringify(ack)).toContain('任务一');
        // 结算后清理 pending；PATCH 兜底异步刷新原消息
        expect(interactions(channel).has('sel-1')).toBe(false);
        await Promise.resolve();
        expect((ctx.fetch as ReturnType<typeof jest.fn>).mock.calls.length).toBeGreaterThan(0);
    });

    test('无效选项（缺 value）时 toast 警告且不回传', async () => {
        const { channel, ctx } = makeChannel();
        await channel.sendInteraction(SELECTION_REQUEST);

        const ack = (await channel._handleCardAction('account-1', {
            event: {
                operator: { open_id: 'ou-1' },
                action: {
                    value: { oc: 'opendesk-interaction-v1', kind: 'selection', id: 'sel-1' }
                }
            }
        })) as { toast: { type: string } };

        expect(ctx.dispatchInteraction).not.toHaveBeenCalled();
        expect(ack.toast.type).toBe('warning');
    });
});
