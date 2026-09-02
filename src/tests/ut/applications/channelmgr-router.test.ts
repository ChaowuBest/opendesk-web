import { afterAll, jest } from '@jest/globals';
import { ChannelMessageRouter } from '../../../main/applications/channelmgr/router.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import type { InboundChannelMessage } from '../../../main/plugins/types.js';

// 避免测试环境依赖真实 agent system prompt 构建（SkillRegistry / 文件系统等）
const originalBuildSystemPrompt = TaskState.prototype.buildSystemPrompt;
TaskState.prototype.buildSystemPrompt = jest.fn(async () => 'system prompt');
afterAll(() => {
    TaskState.prototype.buildSystemPrompt = originalBuildSystemPrompt;
});

interface RouterHarness {
    runtime: { modeId?: string };
    router: ChannelMessageRouter;
    manager: TaskManagerState;
}

function createRouter(): RouterHarness {
    const runtime: { modeId?: string } = { modeId: 'standard' };
    const manager = new TaskManagerState();
    manager.save = (() => {}) as never;
    manager.publishTaskListUpdate = (() => {}) as never;
    const router = new ChannelMessageRouter(manager, '/workspace', undefined, () => ({ ...runtime }));
    (router as any).checkSessionRelevance = async () => true;
    (router as any).submitAndWaitForReply = async () => null;
    return { runtime, router, manager };
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

    test('LLM 关联性检查失败回退超时判断时，复用任务同样同步模式', async () => {
        const { runtime, router, manager } = createRouter();
        (router as any).checkSessionRelevance = async () => {
            throw new Error('LLM timeout');
        };

        await router.routeInboundMessage(makeMessage('第一条消息'));
        runtime.modeId = 'solo';
        await router.routeInboundMessage(makeMessage('第二条消息'));

        expect(manager.tasks).toHaveLength(1);
        expect(manager.tasks[0].activeModeId).toBe('solo');
    });
});
