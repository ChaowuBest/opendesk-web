import { describe, expect, jest, test } from '@jest/globals';
import { ChannelCommandBus, createNewTaskCommand } from '../../../main/applications/channelmgr/commands.js';
import { t as tLocal } from '../../../main/applications/channelmgr/locale/index.js';
import type { InboundChannelMessage } from '../../../main/applications/channelmgr/types.js';

function makeMessage(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
    return {
        channelId: 'feishu',
        accountId: 'bot-1',
        senderId: 'user-1',
        senderName: 'User',
        text: '',
        chatType: 'direct',
        ...overrides
    };
}

function makeBus() {
    const router = {
        unbindActiveTask: jest.fn(),
        startNewTaskWithMessage: jest.fn(async () => null)
    };
    const replies: string[] = [];
    const bus = new ChannelCommandBus();
    bus.register(createNewTaskCommand({ router: router as any }));
    const reply = jest.fn(async (text: string) => {
        replies.push(text);
    });
    return { bus, router, reply, replies };
}

describe('ChannelCommandBus 命令解析', () => {
    test('非 / 开头的消息不消费', async () => {
        const { bus, router, reply } = makeBus();
        expect(await bus.tryHandle(makeMessage({ text: '你好' }), reply)).toBe(false);
        expect(router.unbindActiveTask).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
    });

    test('未注册的命令名按普通消息处理（如 /etc/hosts）', async () => {
        const { bus, router, reply } = makeBus();
        expect(await bus.tryHandle(makeMessage({ text: '/etc/hosts 里写什么' }), reply)).toBe(false);
        expect(router.unbindActiveTask).not.toHaveBeenCalled();
    });

    test('命令前后空白被忽略', async () => {
        const { bus, router, reply } = makeBus();
        expect(await bus.tryHandle(makeMessage({ text: '  /new  \n' }), reply)).toBe(true);
        expect(router.unbindActiveTask).toHaveBeenCalledWith('feishu', 'bot-1', 'user-1');
    });

    test('群聊命令的回执与解绑目标是 groupId', async () => {
        const { bus, router, reply } = makeBus();
        await bus.tryHandle(makeMessage({ text: '/new', chatType: 'group', groupId: 'group-1' }), reply);
        expect(router.unbindActiveTask).toHaveBeenCalledWith('feishu', 'bot-1', 'group-1');
    });
});

describe('/new 命令', () => {
    test('无参：解绑激活任务并回执"已开启新会话"', async () => {
        const { bus, router, reply, replies } = makeBus();

        expect(await bus.tryHandle(makeMessage({ text: '/new' }), reply)).toBe(true);

        expect(router.unbindActiveTask).toHaveBeenCalledWith('feishu', 'bot-1', 'user-1');
        expect(router.startNewTaskWithMessage).not.toHaveBeenCalled();
        expect(replies).toEqual([tLocal('channel.command.newSessionStarted')]);
    });

    test('带参：创建新任务并把参数文本作为首条消息投递', async () => {
        const { bus, router, reply } = makeBus();
        const message = makeMessage({ text: '/new 帮我查一下天气' });

        expect(await bus.tryHandle(message, reply)).toBe(true);

        expect(router.unbindActiveTask).not.toHaveBeenCalled();
        expect(router.startNewTaskWithMessage).toHaveBeenCalledWith(
            expect.objectContaining({ channelId: 'feishu', text: '帮我查一下天气' })
        );
        expect(reply).not.toHaveBeenCalled();
    });

    test('带参但任务没跑起来时，把错误回执补发回渠道', async () => {
        const router = {
            unbindActiveTask: jest.fn(),
            startNewTaskWithMessage: jest.fn(async () => ({
                text: '抱歉，系统在创建会话时遇到了问题：boom',
                mediaUrls: [],
                error: true
            }))
        };
        const replies: string[] = [];
        const bus = new ChannelCommandBus();
        bus.register(createNewTaskCommand({ router: router as any }));
        const reply = jest.fn(async (text: string) => {
            replies.push(text);
        });

        await bus.tryHandle(makeMessage({ text: '/new 新话题' }), reply);

        expect(replies).toHaveLength(1);
        expect(replies[0]).toContain('创建会话时遇到了问题');
    });

    test('命令执行失败时回执错误并消费消息', async () => {
        const router = {
            unbindActiveTask: jest.fn(),
            startNewTaskWithMessage: jest.fn(async () => {
                throw new Error('boom');
            })
        };
        const replies: string[] = [];
        const bus = new ChannelCommandBus();
        bus.register(createNewTaskCommand({ router: router as any }));
        const reply = jest.fn(async (text: string) => {
            replies.push(text);
        });

        expect(await bus.tryHandle(makeMessage({ text: '/new 新话题' }), reply)).toBe(true);
        expect(replies[0]).toContain(tLocal('channel.command.executeFailed'));
        expect(replies[0]).toContain('boom');
    });

    test('回执发送也失败时不向调用方抛错', async () => {
        const router = {
            unbindActiveTask: jest.fn(),
            startNewTaskWithMessage: jest.fn(async () => {
                throw new Error('boom');
            })
        };
        const bus = new ChannelCommandBus();
        bus.register(createNewTaskCommand({ router: router as any }));
        const reply = jest.fn(async () => {
            throw new Error('send failed');
        });

        await expect(bus.tryHandle(makeMessage({ text: '/new' }), reply)).resolves.toBe(true);
    });
});
