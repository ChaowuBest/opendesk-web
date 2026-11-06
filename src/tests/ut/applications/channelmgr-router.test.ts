import { afterAll, jest } from '@jest/globals';
import { ChannelMessageRouter } from '../../../main/applications/channelmgr/router.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { ActiveTaskRegistry } from '../../../main/applications/channelmgr/dispatch/registry.js';
import type { InboundChannelMessage } from '../../../main/applications/channelmgr/types.js';

// 避免测试环境依赖真实 agent system prompt 构建（SkillRegistry / 文件系统等）
const originalBuildSystemPrompt = TaskState.prototype.buildSystemPrompt;
TaskState.prototype.buildSystemPrompt = jest.fn(async () => 'system prompt');
afterAll(() => {
    TaskState.prototype.buildSystemPrompt = originalBuildSystemPrompt;
});

interface RouterHarness {
    runtime: { modeId?: string; dispatchPolicy?: unknown };
    router: ChannelMessageRouter;
    manager: TaskManagerState;
    registry: ActiveTaskRegistry;
}

function createRouter(): RouterHarness {
    const runtime: { modeId?: string; dispatchPolicy?: unknown } = { modeId: 'standard' };
    const manager = new TaskManagerState();
    manager.save = (() => {}) as never;
    manager.publishTaskListUpdate = (() => {}) as never;
    const router = new ChannelMessageRouter(manager, '/workspace', undefined, () => ({ ...runtime }) as any);
    const registry = new ActiveTaskRegistry();
    router.setActiveTaskRegistry(registry);
    (router as any).submitAndWaitForReply = async () => null;
    return { runtime, router, manager, registry };
}

function makeMessage(text: string): InboundChannelMessage {
    return {
        channelId: 'test-channel',
        accountId: 'account-1',
        senderId: 'user-1',
        senderName: 'User',
        text,
        chatType: 'direct'
    };
}

describe('ChannelMessageRouter 账号运行模式同步', () => {
    test('渠道上下文不将生成的基础 prompt 持久化为自定义内容', async () => {
        const { router, manager } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));

        const task = manager.tasks[0];
        expect(task.agentId).toBeDefined();
        expect(task.custom_system_prompt).toContain('--- Channel Context ---');
        expect(task.custom_system_prompt).not.toContain('system prompt');
    });

    test('同一会话第二条消息复用任务时，模式跟随账号最新设定切换', async () => {
        const { runtime, router, manager } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].activeModeId).toBe('standard');
        const firstHarness = manager.tasks[0].harnessContext;

        runtime.modeId = 'solo';
        await router.routeInboundMessage(makeMessage('第二条消息'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].activeModeId).toBe('solo');
        expect(manager.tasks[0].harnessContext).not.toBe(firstHarness);
    });

    test('模式未变化时复用任务不重建 harness', async () => {
        const { runtime, router, manager } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        const firstHarness = manager.tasks[0].harnessContext;

        runtime.modeId = 'standard';
        await router.routeInboundMessage(makeMessage('第二条消息'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].activeModeId).toBe('standard');
        expect(manager.tasks[0].harnessContext).toBe(firstHarness);
    });

    test('账号未配置 modeId 时不干预任务现有模式', async () => {
        const { runtime, router, manager } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        expect(manager.tasks[0].activeModeId).toBe('standard');

        runtime.modeId = undefined;
        await router.routeInboundMessage(makeMessage('第二条消息'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].activeModeId).toBe('standard');
    });
});

describe('ChannelMessageRouter 消息分发策略', () => {
    test('默认策略（未配置 dispatchPolicy）下连续消息复用同一任务', async () => {
        const { router, manager } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        await router.routeInboundMessage(makeMessage('第二条消息'));

        expect(manager.tasks).toHaveLength(1);
    });

    test('timeout 策略：绑定任务被删除后新建任务', async () => {
        const { router, manager, registry } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        expect(manager.tasks).toHaveLength(1);
        const oldTaskId = manager.tasks[0].task_id;

        // 模拟任务在别处被删除（绑定失效）
        manager.tasks.pop();
        await router.routeInboundMessage(makeMessage('任务没了，重开'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].task_id).not.toBe(oldTaskId);
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(manager.tasks[0].task_id);
    });

    test('sticky 策略：绑定任务失效后也复用判定路径新建，有效时始终复用', async () => {
        const { runtime, router, manager } = createRouter();
        runtime.dispatchPolicy = { mode: 'sticky' };

        await router.routeInboundMessage(makeMessage('第一条消息'));
        await router.routeInboundMessage(makeMessage('第二条消息'));
        expect(manager.tasks).toHaveLength(1);

        // 任务删除后绑定失效 → 新建
        manager.tasks.pop();
        await router.routeInboundMessage(makeMessage('第三条消息'));
        expect(manager.tasks).toHaveLength(1);
    });

    test('timeout 策略：绑定活动时间超过阈值后创建新任务', async () => {
        const { runtime, router, manager, registry } = createRouter();
        runtime.dispatchPolicy = { mode: 'timeout', timeoutMinutes: 30 };

        await router.routeInboundMessage(makeMessage('第一条消息'));
        expect(manager.tasks).toHaveLength(1);

        // 交互时间拨回 2 小时前（超过 30 分钟阈值）：绑定时间与任务自身活动时间都要旧，
        // 否则「任务刚在桌面端被继续过」会让会话继续保持
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        registry.getEntry('test-channel', 'account-1', 'user-1')!.updatedAt = twoHoursAgo.getTime();
        manager.tasks[0].updated_at = twoHoursAgo;
        manager.tasks[0].created_at = twoHoursAgo;

        await router.routeInboundMessage(makeMessage('隔了一段时间的新话题'));
        expect(manager.tasks).toHaveLength(2);
    });

    test('timeout 策略：绑定时间旧但任务刚在桌面端活跃过，继续复用该任务', async () => {
        const { runtime, router, manager, registry } = createRouter();
        runtime.dispatchPolicy = { mode: 'timeout', timeoutMinutes: 30 };

        await router.routeInboundMessage(makeMessage('第一条消息'));
        const task = manager.tasks[0];

        // 渠道侧很久没说话（绑定时间很旧），但任务本身刚刚被继续过
        registry.getEntry('test-channel', 'account-1', 'user-1')!.updatedAt = Date.now() - 2 * 60 * 60 * 1000;
        task.updated_at = new Date();
        task.created_at = new Date(Date.now() - 2 * 60 * 60 * 1000);

        await router.routeInboundMessage(makeMessage('接着聊桌面端的话题'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].task_id).toBe(task.task_id);
    });

    test('复用前先加载懒加载任务（否则摘要恒为空、origin 改动会被脏标记保护丢弃）', async () => {
        const { router, manager } = createRouter();
        await router.routeInboundMessage(makeMessage('第一条消息'));
        const task = manager.tasks[0];
        const ensureSpy = jest.spyOn(task, 'ensureLoaded');
        // 模拟重启后由 task_list.json 索引恢复的轻量任务壳
        (task as unknown as { _fullyLoaded: boolean })._fullyLoaded = false;
        try {
            await router.routeInboundMessage(makeMessage('第二条消息'));
        } finally {
            (task as unknown as { _fullyLoaded: boolean })._fullyLoaded = true;
        }

        expect(manager.tasks).toHaveLength(1);
        expect(ensureSpy).toHaveBeenCalled();
    });

    test('smart 策略：LLM 判定新任务时创建新任务', async () => {
        const { runtime, router, manager } = createRouter();
        runtime.dispatchPolicy = { mode: 'smart' };
        (router as any).judgeRelevance = jest.fn(async () => false);

        await router.routeInboundMessage(makeMessage('第一条消息'));
        await router.routeInboundMessage(makeMessage('完全不相关的新话题'));

        expect(manager.tasks).toHaveLength(2);
        expect((router as any).judgeRelevance).toHaveBeenCalledTimes(1);
    });

    test('smart 策略：LLM 判定已有任务时复用并同步模式', async () => {
        const { runtime, router, manager } = createRouter();
        runtime.dispatchPolicy = { mode: 'smart' };
        runtime.modeId = 'standard';
        (router as any).judgeRelevance = jest.fn(async () => true);

        await router.routeInboundMessage(makeMessage('第一条消息'));
        runtime.modeId = 'solo';
        await router.routeInboundMessage(makeMessage('继续聊刚才的话题'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].activeModeId).toBe('solo');
    });

    test('smart 策略：LLM 判定失败回退超时判断时，未超时复用并同步模式', async () => {
        const { runtime, router, manager } = createRouter();
        runtime.dispatchPolicy = { mode: 'smart' };
        runtime.modeId = 'standard';
        (router as any).judgeRelevance = jest.fn(async () => {
            throw new Error('LLM timeout');
        });

        await router.routeInboundMessage(makeMessage('第一条消息'));
        runtime.modeId = 'solo';
        await router.routeInboundMessage(makeMessage('第二条消息'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].activeModeId).toBe('solo');
    });

    test('绑定与任务创建：新会话写入注册表，复用不产生新绑定', async () => {
        const { router, manager, registry } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(manager.tasks[0].task_id);

        await router.routeInboundMessage(makeMessage('第二条消息'));
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(manager.tasks[0].task_id);
    });

    test('群聊任务的 origin 记录 chatType，审批/askUser 卡片才能按群 ID 投递', async () => {
        const { router, manager } = createRouter();
        const message: InboundChannelMessage = {
            ...makeMessage('群里说句话'),
            chatType: 'group',
            groupId: 'group-1',
            senderId: 'member-a'
        };

        await router.routeInboundMessage(message);

        expect(manager.tasks[0].origin).toMatchObject({ recipientId: 'group-1', chatType: 'group' });
    });

    test('群聊消息按 groupId 作为绑定粒度', async () => {
        const { router, manager, registry } = createRouter();
        const message: InboundChannelMessage = {
            ...makeMessage('群里第一条'),
            chatType: 'group',
            groupId: 'group-1',
            senderId: 'member-a'
        };

        await router.routeInboundMessage(makeMessage('私聊第一条'));
        await router.routeInboundMessage(message);

        expect(manager.tasks).toHaveLength(2);
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(manager.tasks[0].task_id);
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'group-1')).toBe(manager.tasks[1].task_id);
    });

    test('getKnownRecipients 从注册表枚举同账号会话', async () => {
        const { router, registry } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        registry.bind('test-channel', 'account-1', 'group-1', 'other-task');

        const recipients = router.getKnownRecipients('test-channel', 'account-1');
        expect(recipients.map((r) => r.recipientId)).toContain('user-1');
        expect(recipients.map((r) => r.recipientId)).toContain('group-1');
        expect(router.getKnownRecipients('test-channel', 'account-2')).toHaveLength(0);
    });

    test('listRecentTasks 全局主任务（含非渠道任务），排除子任务/internal，按最近活动降序', () => {
        const { router, manager } = createRouter();
        const old = new Date('2026-01-01T00:00:00Z');
        const mid = new Date('2026-06-01T00:00:00Z');
        const recent = new Date('2026-11-01T00:00:00Z');
        // finished_at 比 updated_at 晚的任务应按 finished_at 参与排序
        const finished = {
            task_id: 't-finished',
            task_name: '已收尾的对话',
            parent_id: null,
            origin: { type: 'channel', channel: 'feishu', accountId: 'b1', recipientId: 'u1' },
            created_at: old,
            updated_at: mid,
            finished_at: recent
        };
        const desktopTask = {
            task_id: 't-desktop',
            task_name: '桌面端发起的任务',
            parent_id: null,
            origin: undefined,
            created_at: mid,
            updated_at: mid
        };
        const subtask = {
            task_id: 't-sub',
            task_name: '子任务',
            parent_id: 't-desktop',
            origin: undefined,
            created_at: recent,
            updated_at: recent
        };
        const internalTask = {
            task_id: 't-internal',
            task_name: '内部任务',
            parent_id: null,
            internal: true,
            origin: undefined,
            created_at: recent,
            updated_at: recent
        };
        manager.tasks.push(finished, desktopTask, subtask, internalTask) as never;

        const tasks = router.listRecentTasks(10);

        // 桌面端任务（无 origin）包含；子任务与 internal 任务被过滤；finished_at 更晚的排在前
        expect(tasks.map((t) => t.task_id)).toEqual(['t-finished', 't-desktop']);

        // maxCount 截断生效
        expect(router.listRecentTasks(1).map((t) => t.task_id)).toEqual(['t-finished']);
    });

    test('listRecentTasks 的可见性过滤在截断之前生效', () => {
        const { router, manager } = createRouter();
        const recent = new Date('2026-11-01T00:00:00Z');
        const older = new Date('2026-06-01T00:00:00Z');
        manager.tasks.push(
            { task_id: 't-private', parent_id: null, created_at: recent, updated_at: recent },
            { task_id: 't-group', parent_id: null, created_at: older, updated_at: older }
        ) as never;

        const visible = router.listRecentTasks(1, (task) => task.task_id === 't-group');

        expect(visible.map((t) => t.task_id)).toEqual(['t-group']);
    });

    test('registerTaskForParticipant 将定时任务注册进注册表供后续回复复用', async () => {
        const { router, manager, registry } = createRouter();

        await router.routeInboundMessage(makeMessage('第一条消息'));
        const task = manager.tasks[0];
        manager.tasks.pop(); // 模拟任务在 TaskManagerState 列表外仍可查（getTask 走内部存储）

        router.registerTaskForParticipant(task.task_id, {
            type: 'channel',
            channel: 'test-channel',
            accountId: 'account-1',
            recipientId: 'user-1'
        });
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(task.task_id);
    });

    test('/switch 到桌面端任务后，复用时由当前会话接管回复出口（否则渠道侧收不到回复）', async () => {
        const { router, manager } = createRouter();
        const desktopTask = {
            task_id: 't-desktop',
            task_name: '桌面任务',
            parent_id: null,
            origin: undefined,
            created_at: new Date(),
            updated_at: new Date(),
            getAgentMode: () => ({ id: 'standard' }),
            chat_context: { messages: [] },
            harnessContext: { permission: {}, permissionPrompt: null },
            ensureLoaded: jest.fn(),
            persistLater: jest.fn()
        };
        manager.tasks.push(desktopTask as never);
        manager.getTask = ((id: string) => manager.tasks.find((t) => t.task_id === id) ?? null) as never;

        router.bindSessionTask('test-channel', 'account-1', 'user-1', 't-desktop');
        // 只切换绑定不碰任务本身：接管发生在下一条消息复用时
        expect(desktopTask.origin).toBeUndefined();

        await router.routeInboundMessage(makeMessage('从手机接着聊'));

        expect(desktopTask.origin).toEqual({
            type: 'channel',
            channel: 'test-channel',
            accountId: 'account-1',
            recipientId: 'user-1',
            chatType: 'direct'
        });
        expect(desktopTask.persistLater).toHaveBeenCalled();
        expect(manager.tasks).toHaveLength(1);
    });

    test('不同会话绑定同一任务时，由最后一次发消息的会话接管出口', async () => {
        const { router, manager } = createRouter();
        await router.routeInboundMessage(makeMessage('A 会话先聊'));
        const task = manager.tasks[0];

        router.bindSessionTask('test-channel', 'account-1', 'user-2', task.task_id);
        await router.routeInboundMessage({ ...makeMessage('B 会话接着聊'), senderId: 'user-2' });

        expect(task.origin).toEqual({
            type: 'channel',
            channel: 'test-channel',
            accountId: 'account-1',
            recipientId: 'user-2',
            chatType: 'direct'
        });
    });

    test('本会话自己的任务复用时不再改写 origin', async () => {
        const { router, manager } = createRouter();
        await router.routeInboundMessage(makeMessage('第一条消息'));
        const task = manager.tasks[0];
        const persistSpy = jest.spyOn(task, 'persistLater');

        await router.routeInboundMessage(makeMessage('第二条消息'));

        expect(persistSpy).not.toHaveBeenCalled();
    });
});

describe('ChannelMessageRouter 重启恢复绑定', () => {
    test('从带 origin 的任务恢复会话绑定，同会话取最近活跃任务', () => {
        const { router, manager, registry } = createRouter();
        const old = new Date('2026-01-01T00:00:00Z');
        const recent = new Date('2026-06-01T00:00:00Z');
        const t1 = {
            task_id: 't1',
            task_name: '旧对话',
            origin: { type: 'channel', channel: 'feishu', accountId: 'b1', recipientId: 'u1' },
            updated_at: old,
            created_at: old
        };
        const t2 = {
            task_id: 't2',
            task_name: '新对话',
            origin: { type: 'channel', channel: 'feishu', accountId: 'b1', recipientId: 'u1' },
            updated_at: recent,
            created_at: old
        };
        const t3 = {
            task_id: 't3',
            task_name: '别的渠道',
            origin: { type: 'channel', channel: 'weixin', accountId: 'b1', recipientId: 'u1' },
            updated_at: recent,
            created_at: old
        };
        const t4 = { task_id: 't4', task_name: 'PC任务', origin: undefined, updated_at: recent };
        manager.tasks.push(t1, t2, t3, t4) as never;

        router.restoreSessionBindings();

        expect(registry.getActiveTaskId('feishu', 'b1', 'u1')).toBe('t2');
        expect(registry.getActiveTaskId('weixin', 'b1', 'u1')).toBe('t3');
    });

    test('内存中已存在的绑定不被恢复逻辑覆盖', async () => {
        const { router, manager, registry } = createRouter();
        await router.routeInboundMessage(makeMessage('运行中的会话'));
        const runningId = manager.tasks[0].task_id;

        const stale = {
            task_id: 'stale-task',
            task_name: '旧任务',
            origin: { type: 'channel', channel: 'test-channel', accountId: 'account-1', recipientId: 'user-1' },
            updated_at: new Date('2026-01-01T00:00:00Z'),
            created_at: new Date('2026-01-01T00:00:00Z')
        };
        manager.tasks.push(stale) as never;
        router.restoreSessionBindings();

        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(runningId);
    });

    test('恢复后的绑定驱动后续消息复用原任务', async () => {
        const { router, manager, registry } = createRouter();
        const persisted = {
            task_id: 'persisted-task',
            task_name: '重启前的对话',
            origin: { type: 'channel', channel: 'test-channel', accountId: 'account-1', recipientId: 'user-1' },
            updated_at: new Date(),
            created_at: new Date()
        };
        manager.tasks.push(persisted) as never;
        manager.getTask = ((id: string) => manager.tasks.find((t) => t.task_id === id) ?? null) as never;
        router.restoreSessionBindings();
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe('persisted-task');

        await router.routeInboundMessage(makeMessage('重启后继续聊'));

        // 复用恢复的任务，不新建
        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].task_id).toBe('persisted-task');
    });
});

describe('ChannelMessageRouter 错误回执', () => {
    test('提交消息失败时回执带 error 标记（渠道侧才能直接投递，不至于静默）', async () => {
        const { router } = createRouter();
        (router as any).submitAndWaitForReply = async () => {
            throw new Error('boom');
        };

        const reply = await router.routeInboundMessage(makeMessage('你好'));

        expect(reply).toMatchObject({ error: true, mediaUrls: [] });
        expect(reply?.text).toContain('boom');
    });
});

describe('ChannelMessageRouter /new 起始新会话', () => {
    test('解绑旧绑定并创建新任务，绑定指向新任务', async () => {
        const { router, manager, registry } = createRouter();
        await router.routeInboundMessage(makeMessage('第一条消息'));
        const firstTaskId = manager.tasks[0].task_id;
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(firstTaskId);

        await router.startNewTaskWithMessage(makeMessage('换个话题'));

        expect(manager.tasks).toHaveLength(2);
        const newTaskId = manager.tasks[1].task_id;
        expect(newTaskId).not.toBe(firstTaskId);
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'user-1')).toBe(newTaskId);
    });

    test('群聊按 groupId 解绑并重绑到新任务', async () => {
        const { router, manager, registry } = createRouter();
        const groupMessage: InboundChannelMessage = {
            ...makeMessage('群里第一条'),
            chatType: 'group',
            groupId: 'group-1',
            senderId: 'member-a'
        };
        await router.routeInboundMessage(groupMessage);
        const firstTaskId = manager.tasks[0].task_id;

        await router.startNewTaskWithMessage({ ...groupMessage, text: '群里换个话题' });

        expect(manager.tasks).toHaveLength(2);
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'group-1')).toBe(manager.tasks[1].task_id);
        expect(registry.getActiveTaskId('test-channel', 'account-1', 'group-1')).not.toBe(firstTaskId);
    });
});
