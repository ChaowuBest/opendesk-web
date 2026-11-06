import { describe, expect, jest, test } from '@jest/globals';
import {
    ChannelCommandBus,
    createListCommand,
    createSwitchCommand,
    InMemoryPendingTaskListStore
} from '../../../main/applications/channelmgr/commands.js';
import { t as tLocal } from '../../../main/applications/channelmgr/locale/index.js';
import type { InboundChannelMessage } from '../../../main/applications/channelmgr/types.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';

function makeTask(id: string, name: string | null, updatedAt: Date): TaskState {
    return {
        task_id: id,
        task_name: name,
        updated_at: updatedAt,
        created_at: updatedAt,
        origin: { type: 'channel', channel: 'feishu', accountId: 'bot-1', recipientId: 'user-1' }
    } as unknown as TaskState;
}

function makeMessage(text: string): InboundChannelMessage {
    return {
        channelId: 'feishu',
        accountId: 'bot-1',
        senderId: 'user-1',
        senderName: 'User',
        text,
        chatType: 'direct'
    };
}

function makeRouter(tasks: TaskState[]) {
    return {
        listRecentTasks: jest.fn((maxCount: number, filter?: (task: TaskState) => boolean) =>
            (filter ? tasks.filter(filter) : tasks).slice(0, maxCount)
        ),
        getTaskById: jest.fn((id: string) => tasks.find((t) => t.task_id === id)),
        bindSessionTask: jest.fn(),
        getActiveSessionTaskId: jest.fn(() => undefined)
    };
}

function makeInteractionService(supports: boolean) {
    return {
        supportsInteractive: jest.fn(() => supports),
        requestSelection: jest.fn(async () => ({ cancelled: true }))
    };
}

function makeBus(router: any, interactionService: any, pendingTaskLists: InMemoryPendingTaskListStore) {
    const replies: string[] = [];
    const bus = new ChannelCommandBus();
    bus.register(createListCommand({ router, interactionService, pendingTaskLists }));
    bus.register(createSwitchCommand({ router, pendingTaskLists }));
    const reply = jest.fn(async (text: string) => {
        replies.push(text);
    });
    return { bus, reply, replies };
}

describe('InMemoryPendingTaskListStore', () => {
    test('set/get 往返；过期后返回 undefined', () => {
        const store = new InMemoryPendingTaskListStore();
        store.set('k', ['a', 'b'], 1000);
        expect(store.get('k', 999)).toEqual(['a', 'b']);
        expect(store.get('k', 1000)).toBeUndefined();
        expect(store.get('k', 1001)).toBeUndefined();
    });

    test('同 key 重复 set 覆盖旧列表；无关 key 互不影响', () => {
        const store = new InMemoryPendingTaskListStore();
        store.set('k1', ['a'], 1000);
        store.set('k2', ['b'], 1000);
        store.set('k1', ['c'], 2000);
        expect(store.get('k1', 0)).toEqual(['c']);
        expect(store.get('k2', 0)).toEqual(['b']);
    });
});

describe('/list 命令', () => {
    test('无历史对话时回执提示', async () => {
        const router = makeRouter([]);
        const interactionService = makeInteractionService(true);
        const { bus, reply, replies } = makeBus(router, interactionService, new InMemoryPendingTaskListStore());

        await bus.tryHandle(makeMessage('/list'), reply);

        expect(replies).toEqual([tLocal('channel.command.listEmpty')]);
        expect(interactionService.requestSelection).not.toHaveBeenCalled();
    });

    test('当前激活任务已在列表中时标注（当前）', async () => {
        const tasks = [makeTask('t1', '任务一', new Date()), makeTask('t2', '任务二', new Date())];
        const router = makeRouter(tasks);
        router.getActiveSessionTaskId = jest.fn(() => 't1');
        const { bus, reply, replies } = makeBus(
            router,
            makeInteractionService(false),
            new InMemoryPendingTaskListStore()
        );

        await bus.tryHandle(makeMessage('/list'), reply);

        expect(replies[0]).toContain(`任务一${tLocal('channel.command.listCurrentMark')}`);
        expect(replies[0]).toContain('2. 任务二');
    });

    test('当前激活任务不在最近列表时追加到末尾并标注', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        router.getActiveSessionTaskId = jest.fn(() => 't-old');
        router.getTaskById = jest.fn((id: string) =>
            id === 't-old' ? makeTask('t-old', '很久前的任务', new Date()) : undefined
        );
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        const { bus, reply, replies } = makeBus(router, makeInteractionService(false), pendingTaskLists);

        await bus.tryHandle(makeMessage('/list'), reply);

        // t1 不是当前任务不标注；t-old 是当前任务，追加到末尾并标注
        expect(replies[0]).toContain('1. 任务一');
        expect(replies[0]).not.toContain('1. 任务一' + tLocal('channel.command.listCurrentMark'));
        expect(replies[0]).toContain('2. 很久前的任务' + tLocal('channel.command.listCurrentMark'));
        // 追加的当前任务也进入 /switch 编号映射
        expect(pendingTaskLists.get('feishu:bot-1:user-1', 0)).toEqual(['t1', 't-old']);
    });

    test('卡片路径同样标注当前任务', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        router.getActiveSessionTaskId = jest.fn(() => 't1');
        const interactionService = makeInteractionService(true);
        interactionService.requestSelection = jest.fn(async () => ({ cancelled: true }));
        const { bus, reply, replies } = makeBus(router, interactionService, new InMemoryPendingTaskListStore());

        await bus.tryHandle(makeMessage('/list'), reply);

        const payload = interactionService.requestSelection.mock.calls[0][1];
        expect(payload.options).toEqual([{ label: `任务一${tLocal('channel.command.listCurrentMark')}`, value: 't1' }]);
        // 卡片携带 /list N 提示文案
        expect(payload.hint).toBe(tLocal('channel.command.listHint'));
        expect(replies).toEqual([]);
    });

    test('/list N 按指定条数拉取，非法值回退默认 10', async () => {
        const many = Array.from({ length: 20 }, (_, i) => makeTask(`t${i + 1}`, `任务${i + 1}`, new Date()));
        const router = makeRouter(many);
        const { bus, reply, replies } = makeBus(
            router,
            makeInteractionService(false),
            new InMemoryPendingTaskListStore()
        );

        await bus.tryHandle(makeMessage('/list 5'), reply);
        expect(router.listRecentTasks).toHaveBeenCalledWith(5, expect.any(Function));
        expect(replies[0]).toContain('5. 任务5');
        expect(replies[0]).not.toContain('6. 任务6');
        expect(replies[0]).toContain(tLocal('channel.command.listHint'));

        // 超上限 clamp 到 100；非法参数回退默认 10
        await bus.tryHandle(makeMessage('/list 500'), reply);
        expect(router.listRecentTasks).toHaveBeenLastCalledWith(100, expect.any(Function));

        await bus.tryHandle(makeMessage('/list abc'), reply);
        expect(router.listRecentTasks).toHaveBeenLastCalledWith(10, expect.any(Function));
    });

    test('/list 非纯数字参数不按前缀截断（5abc 回退默认条数）', async () => {
        const many = Array.from({ length: 20 }, (_, i) => makeTask(`t${i + 1}`, `任务${i + 1}`, new Date()));
        const router = makeRouter(many);
        const { bus, reply } = makeBus(router, makeInteractionService(false), new InMemoryPendingTaskListStore());

        await bus.tryHandle(makeMessage('/list 5abc'), reply);
        expect(router.listRecentTasks).toHaveBeenLastCalledWith(10, expect.any(Function));
    });

    test('群聊只列本群自己的对话，看不到私聊任务', async () => {
        const groupTask = makeTask('t-group', '群里的对话', new Date());
        groupTask.origin = { type: 'channel', channel: 'feishu', accountId: 'bot-1', recipientId: 'group-1' };
        const directTask = makeTask('t-dm', '私聊对话', new Date());
        const router = makeRouter([groupTask, directTask]);
        const interactionService = makeInteractionService(false);
        const { bus, reply, replies } = makeBus(router, interactionService, new InMemoryPendingTaskListStore());

        const groupMessage = makeMessage('/list');
        groupMessage.chatType = 'group';
        groupMessage.groupId = 'group-1';
        await bus.tryHandle(groupMessage, reply);

        // 私聊任务对群聊不可见；群自己的对话保持可见
        expect(replies[0]).toContain('群里的对话');
        expect(replies[0]).not.toContain('私聊对话');
    });

    test('支持交互的渠道推送选择卡片，不阻塞等待点选', async () => {
        const tasks = [makeTask('t1', '任务一', new Date()), makeTask('t2', null, new Date())];
        const router = makeRouter(tasks);
        const interactionService = makeInteractionService(true);
        interactionService.requestSelection = jest.fn(async () => ({ cancelled: true })); // 模拟用户不点
        const { bus, reply, replies } = makeBus(router, interactionService, new InMemoryPendingTaskListStore());

        await expect(bus.tryHandle(makeMessage('/list'), reply)).resolves.toBe(true);

        // requestSelection 已发出但未被 await（cancelled 时无回执、不阻塞）
        expect(interactionService.requestSelection).toHaveBeenCalledTimes(1);
        const payload = interactionService.requestSelection.mock.calls[0][1];
        expect(payload.options).toEqual([
            { label: '任务一', value: 't1' },
            { label: tLocal('channel.task.unnamed'), value: 't2' }
        ]);
        expect(replies).toEqual([]);
    });

    test('卡片点选后切换绑定并回执任务名（fire-and-forget 回调生效）', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        const interactionService = makeInteractionService(true);
        let resolveSelection: (outcome: unknown) => void = () => {};
        interactionService.requestSelection = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveSelection = resolve as never;
                })
        );
        const { bus, reply, replies } = makeBus(router, interactionService, new InMemoryPendingTaskListStore());

        await bus.tryHandle(makeMessage('/list'), reply);
        resolveSelection({ selected: 't1' });
        await new Promise((resolve) => setTimeout(resolve, 0)); // 让 .then 回调跑完

        expect(router.bindSessionTask).toHaveBeenCalledWith('feishu', 'bot-1', 'user-1', 't1');
        expect(replies).toEqual([`${tLocal('channel.command.switchedTo')}任务一`]);
    });

    test('点选的任务已不存在时回执提示', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        router.getTaskById = jest.fn(() => undefined);
        const interactionService = makeInteractionService(true);
        let resolveSelection: (outcome: unknown) => void = () => {};
        interactionService.requestSelection = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveSelection = resolve as never;
                })
        );
        const { bus, reply, replies } = makeBus(router, interactionService, new InMemoryPendingTaskListStore());

        await bus.tryHandle(makeMessage('/list'), reply);
        resolveSelection({ selected: 't1' });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(router.bindSessionTask).not.toHaveBeenCalled();
        expect(replies).toEqual([tLocal('channel.command.invalidSwitchTarget')]);
    });

    test('不支持交互的渠道回退编号文本并记录映射', async () => {
        const tasks = [makeTask('t1', '任务一', new Date()), makeTask('t2', '任务二', new Date())];
        const router = makeRouter(tasks);
        const interactionService = makeInteractionService(false);
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        const { bus, reply, replies } = makeBus(router, interactionService, pendingTaskLists);

        await bus.tryHandle(makeMessage('/list'), reply);

        expect(interactionService.requestSelection).not.toHaveBeenCalled();
        expect(replies[0]).toContain('1. 任务一');
        expect(replies[0]).toContain('2. 任务二');
        expect(replies[0]).toContain(tLocal('channel.command.listHint'));
        expect(pendingTaskLists.get('feishu:bot-1:user-1', 0)).toEqual(['t1', 't2']);
    });

    test('卡片发送失败时回退推送编号文本列表（不再静默卡住）', async () => {
        const tasks = [makeTask('t1', '任务一', new Date()), makeTask('t2', '任务二', new Date())];
        const router = makeRouter(tasks);
        const interactionService = makeInteractionService(true);
        // 模拟飞书拒绝卡片（如选项数量超出平台限制）
        interactionService.requestSelection = jest.fn(async () => ({ cancelled: true, error: 'too many elements' }));
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        const { bus, reply, replies } = makeBus(router, interactionService, pendingTaskLists);

        await bus.tryHandle(makeMessage('/list 100'), reply);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(replies).toHaveLength(1);
        expect(replies[0]).toContain('1. 任务一');
        expect(replies[0]).toContain('2. 任务二');
        expect(replies[0]).toContain(tLocal('channel.command.listHint'));
        expect(pendingTaskLists.get('feishu:bot-1:user-1', 0)).toEqual(['t1', 't2']);

        // 回退后 /switch 仍可用
        await bus.tryHandle(makeMessage('/switch 2'), reply);
        expect(router.bindSessionTask).toHaveBeenCalledWith('feishu', 'bot-1', 'user-1', 't2');
    });

    test('卡片链路整体抛错时同样回退文本列表，且不留未处理拒绝', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        const interactionService = makeInteractionService(true);
        interactionService.requestSelection = jest.fn(async () => {
            throw new Error('boom');
        });
        const { bus, reply, replies } = makeBus(router, interactionService, new InMemoryPendingTaskListStore());

        await expect(bus.tryHandle(makeMessage('/list'), reply)).resolves.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(replies).toHaveLength(1);
        expect(replies[0]).toContain('1. 任务一');
    });

    test('交互式渠道（如微信文本模拟卡片）/list 后 /switch N 同样可用', async () => {
        const tasks = [makeTask('t1', '任务一', new Date()), makeTask('t2', '任务二', new Date())];
        const router = makeRouter(tasks);
        const interactionService = makeInteractionService(true);
        interactionService.requestSelection = jest.fn(async () => ({ cancelled: true }));
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        const { bus, reply, replies } = makeBus(router, interactionService, pendingTaskLists);

        // 卡片路径不写回执但对用户可见的编号列表仍需可 /switch
        await bus.tryHandle(makeMessage('/list'), reply);
        expect(replies).toEqual([]);
        expect(pendingTaskLists.get('feishu:bot-1:user-1', 0)).toEqual(['t1', 't2']);

        await bus.tryHandle(makeMessage('/switch 2'), reply);
        expect(router.bindSessionTask).toHaveBeenCalledWith('feishu', 'bot-1', 'user-1', 't2');
        expect(replies).toEqual([`${tLocal('channel.command.switchedTo')}任务二`]);
    });
});

describe('/switch 命令', () => {
    test('切到最近一次 /list 推送的编号并回执', async () => {
        const tasks = [makeTask('t1', '任务一', new Date()), makeTask('t2', '任务二', new Date())];
        const router = makeRouter(tasks);
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        pendingTaskLists.set('feishu:bot-1:user-1', ['t1', 't2'], Date.now() + 60_000);
        const { bus, reply, replies } = makeBus(router, makeInteractionService(false), pendingTaskLists);

        expect(await bus.tryHandle(makeMessage('/switch 2'), reply)).toBe(true);

        expect(router.bindSessionTask).toHaveBeenCalledWith('feishu', 'bot-1', 'user-1', 't2');
        expect(replies).toEqual([`${tLocal('channel.command.switchedTo')}任务二`]);
    });

    test('无 pending 列表 / 越界 / 非数字编号时回执提示', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        pendingTaskLists.set('feishu:bot-1:user-1', ['t1'], Date.now() + 60_000);
        const { bus, reply, replies } = makeBus(router, makeInteractionService(false), pendingTaskLists);

        await bus.tryHandle(makeMessage('/switch 5'), reply);
        await bus.tryHandle(makeMessage('/switch abc'), reply);

        const other = makeMessage('/switch 1');
        other.accountId = 'bot-other';
        await bus.tryHandle(other, reply);

        expect(replies).toEqual([
            tLocal('channel.command.invalidSwitchIndex'),
            tLocal('channel.command.invalidSwitchIndex'),
            tLocal('channel.command.invalidSwitchIndex')
        ]);
        expect(router.bindSessionTask).not.toHaveBeenCalled();
    });

    test('pending 列表过期后 /switch 失效', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        pendingTaskLists.set('feishu:bot-1:user-1', ['t1'], Date.now() - 1);
        const { bus, reply, replies } = makeBus(router, makeInteractionService(false), pendingTaskLists);

        await bus.tryHandle(makeMessage('/switch 1'), reply);

        expect(replies).toEqual([tLocal('channel.command.invalidSwitchIndex')]);
        expect(router.bindSessionTask).not.toHaveBeenCalled();
    });

    test('编号指向的任务已被删除时回执提示', async () => {
        const tasks = [makeTask('t1', '任务一', new Date())];
        const router = makeRouter(tasks);
        router.getTaskById = jest.fn(() => undefined);
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        pendingTaskLists.set('feishu:bot-1:user-1', ['t1'], Date.now() + 60_000);
        const { bus, reply, replies } = makeBus(router, makeInteractionService(false), pendingTaskLists);

        await bus.tryHandle(makeMessage('/switch 1'), reply);

        expect(replies).toEqual([tLocal('channel.command.invalidSwitchIndex')]);
        expect(router.bindSessionTask).not.toHaveBeenCalled();
    });

    test('群聊不会用过期编号切到已不可见（如私聊）的任务', async () => {
        // 任务 origin 属于私聊 user-1，群聊列表里出现它（模拟过期/跨会话的编号映射）
        const directTask = makeTask('t-dm', '私聊任务', new Date());
        const router = makeRouter([directTask]);
        const pendingTaskLists = new InMemoryPendingTaskListStore();
        pendingTaskLists.set('feishu:bot-1:group-1', ['t-dm'], Date.now() + 60_000);
        const { bus, reply, replies } = makeBus(router, makeInteractionService(false), pendingTaskLists);

        const groupMessage = makeMessage('/switch 1');
        groupMessage.chatType = 'group';
        groupMessage.groupId = 'group-1';
        await bus.tryHandle(groupMessage, reply);

        expect(router.bindSessionTask).not.toHaveBeenCalled();
        expect(replies).toEqual([tLocal('channel.command.invalidSwitchIndex')]);
    });
});
