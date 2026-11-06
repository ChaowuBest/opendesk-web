import { describe, expect, jest, test } from '@jest/globals';
import { ActiveTaskRegistry, type ActiveTaskStore } from '../../../main/applications/channelmgr/dispatch/registry.js';

function makeStore(): ActiveTaskStore & { data: Record<string, Record<string, any>>; saveCalls: string[] } {
    const data: Record<string, Record<string, any>> = {};
    const saveCalls: string[] = [];
    return {
        data,
        saveCalls,
        load(channelId: string) {
            return data[channelId];
        },
        save(channelId: string, entries: Record<string, any>) {
            saveCalls.push(channelId);
            data[channelId] = entries;
        }
    };
}

describe('ActiveTaskRegistry 基本流转', () => {
    test('bind 后 getActiveTaskId/getEntry 返回绑定', () => {
        const registry = new ActiveTaskRegistry();
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBe('task-1');
        expect(registry.getEntry('feishu', 'bot-1', 'user-1')?.taskId).toBe('task-1');
        expect(registry.getEntry('feishu', 'bot-1', 'user-1')?.updatedAt).toBeGreaterThan(0);
    });

    test('unbind 后绑定清空；重复 unbind 静默返回', () => {
        const registry = new ActiveTaskRegistry();
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        registry.unbind('feishu', 'bot-1', 'user-1');
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBeUndefined();
        expect(() => registry.unbind('feishu', 'bot-1', 'user-1')).not.toThrow();
    });

    test('touch 刷新 updatedAt；绑定不存在时静默返回', () => {
        const registry = new ActiveTaskRegistry();
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        const before = registry.getEntry('feishu', 'bot-1', 'user-1')!.updatedAt;
        registry.touch('feishu', 'bot-1', 'user-1');
        expect(registry.getEntry('feishu', 'bot-1', 'user-1')!.updatedAt).toBeGreaterThanOrEqual(before);
        expect(() => registry.touch('feishu', 'bot-1', 'ghost')).not.toThrow();
    });

    test('evictIfInvalid 清除指向失效任务的绑定并返回 true', () => {
        const registry = new ActiveTaskRegistry();
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        expect(registry.evictIfInvalid('feishu', 'bot-1', 'user-1', (id) => id !== 'task-1')).toBe(true);
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBeUndefined();
        // 绑定不存在或任务仍有效时返回 false
        expect(registry.evictIfInvalid('feishu', 'bot-1', 'user-1', () => true)).toBe(false);
    });

    test('listChannelEntries 按渠道枚举并拆解账号/接收者', () => {
        const registry = new ActiveTaskRegistry();
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        registry.bind('feishu', 'bot-1', 'group-1', 'task-2');
        registry.bind('weixin', 'bot-9', 'user-1', 'task-3');

        const entries = registry.listChannelEntries('feishu');
        expect(entries).toHaveLength(2);
        expect(entries.map((e) => [e.accountId, e.recipientId, e.entry.taskId])).toContainEqual([
            'bot-1',
            'user-1',
            'task-1'
        ]);
        expect(entries.map((e) => [e.accountId, e.recipientId, e.entry.taskId])).toContainEqual([
            'bot-1',
            'group-1',
            'task-2'
        ]);
        expect(registry.listChannelEntries('slack')).toHaveLength(0);
    });
});

describe('ActiveTaskRegistry 持久化', () => {
    test('变更时按渠道写入 store', () => {
        const store = makeStore();
        const registry = new ActiveTaskRegistry(store);
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        expect(store.saveCalls).toContain('feishu');
        expect(store.data['feishu']['feishu:bot-1:user-1'].taskId).toBe('task-1');

        registry.unbind('feishu', 'bot-1', 'user-1');
        expect(store.data['feishu']['feishu:bot-1:user-1']).toBeUndefined();
    });

    test('重启后从 store 惰性恢复绑定', () => {
        const store = makeStore();
        const first = new ActiveTaskRegistry(store);
        first.bind('feishu', 'bot-1', 'user-1', 'task-1');

        const second = new ActiveTaskRegistry(store);
        expect(second.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBe('task-1');
        expect(second.listChannelEntries('feishu')).toHaveLength(1);
    });

    test('未注入 store 时保持纯内存行为', () => {
        const registry = new ActiveTaskRegistry();
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        const again = new ActiveTaskRegistry();
        expect(again.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBeUndefined();
    });

    test('store 抛错不影响内存态路由', () => {
        const registry = new ActiveTaskRegistry({
            load: () => {
                throw new Error('disk error');
            },
            save: () => {
                throw new Error('disk error');
            }
        });
        expect(() => registry.bind('feishu', 'bot-1', 'user-1', 'task-1')).not.toThrow();
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBe('task-1');
    });

    test('恢复时忽略形状不合法的持久化条目', () => {
        const store = makeStore();
        store.data['feishu'] = {
            'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 123 },
            'feishu:bot-1:user-2': { taskId: 42, updatedAt: 123 },
            'feishu:bot-1:user-3': 'garbage'
        };
        const registry = new ActiveTaskRegistry(store);
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBe('task-1');
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-2')).toBeUndefined();
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-3')).toBeUndefined();
    });

    test('持久化条目与内存同名时以内存为准', () => {
        const store = makeStore();
        store.data['feishu'] = { 'feishu:bot-1:user-1': { taskId: 'stale-task', updatedAt: 1 } };
        const registry = new ActiveTaskRegistry(store);
        registry.bind('feishu', 'bot-1', 'user-1', 'fresh-task');
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBe('fresh-task');
    });

    test('bind 覆盖旧绑定并写回 store（jest spy 校验）', () => {
        const save = jest.fn();
        const registry = new ActiveTaskRegistry({ load: () => undefined, save });
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        registry.bind('feishu', 'bot-1', 'user-1', 'task-2');
        expect(save).toHaveBeenCalledTimes(2);
        expect(registry.getActiveTaskId('feishu', 'bot-1', 'user-1')).toBe('task-2');
    });

    test('活动刷新（touch）在节流窗口内不重复写配置', () => {
        const save = jest.fn();
        const registry = new ActiveTaskRegistry({ load: () => undefined, save });
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        expect(save).toHaveBeenCalledTimes(1);

        // bind 之后紧接着的活动刷新落在节流窗口内：只更新内存态
        registry.touch('feishu', 'bot-1', 'user-1');
        registry.touch('feishu', 'bot-1', 'user-1');
        expect(save).toHaveBeenCalledTimes(1);
        expect(registry.getEntry('feishu', 'bot-1', 'user-1')!.updatedAt).toBeGreaterThan(0);
    });

    test('活动刷新超出节流窗口后再次落盘', () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        try {
            const save = jest.fn();
            const registry = new ActiveTaskRegistry({ load: () => undefined, save });
            registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
            expect(save).toHaveBeenCalledTimes(1);

            registry.touch('feishu', 'bot-1', 'user-1');
            expect(save).toHaveBeenCalledTimes(1);

            now.mockReturnValue(1_000_000 + 61_000);
            registry.touch('feishu', 'bot-1', 'user-1');
            expect(save).toHaveBeenCalledTimes(2);
        } finally {
            now.mockRestore();
        }
    });

    test('单渠道绑定超过上限时淘汰最久未活动的条目', () => {
        const store = makeStore();
        const registry = new ActiveTaskRegistry(store);
        for (let i = 0; i < 205; i++) {
            registry.bind('feishu', 'bot-1', `user-${i}`, `task-${i}`);
        }
        expect(Object.keys(store.data['feishu'])).toHaveLength(200);
        expect(registry.listChannelEntries('feishu')).toHaveLength(200);
    });

    test('落盘用条目副本，内存态后续变更不会串进已保存的配置', () => {
        const store = makeStore();
        const registry = new ActiveTaskRegistry(store);
        registry.bind('feishu', 'bot-1', 'user-1', 'task-1');
        const saved = store.data['feishu']['feishu:bot-1:user-1'];
        const savedAt = saved.updatedAt;

        const now = jest.spyOn(Date, 'now').mockReturnValue(savedAt + 61_000);
        try {
            registry.touch('feishu', 'bot-1', 'user-1');
        } finally {
            now.mockRestore();
        }
        expect(saved.updatedAt).toBe(savedAt);
    });
});
