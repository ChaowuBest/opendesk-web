import { describe, expect, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createSettingChangedDispatcher } from '../../../renderer/settingChangedSubscription.js';

/**
 * 主窗口启动时十余个组件（各翻译器/特性开关）通过 settingAPI.onSettingChanged
 * 订阅 setting:changed 广播。旧实现中每个订阅者都直接在 ipcRenderer 上挂
 * listener，超过 Node EventEmitter 默认上限 10 后每次启动都触发
 * MaxListenersExceededWarning。分发器必须把 IPC listener 数收敛为 1。
 */
describe('setting:changed subscription dispatcher', () => {
    test('订阅收敛：20 个订阅者也只占用 1 个 ipc listener（修复 MaxListenersExceededWarning）', () => {
        const ipc = new EventEmitter();
        const dispatcher = createSettingChangedDispatcher(ipc);

        const unsubscribes = Array.from({ length: 20 }, () => dispatcher.subscribe(() => {}));

        expect(ipc.listenerCount('setting:changed')).toBe(1);

        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
        expect(ipc.listenerCount('setting:changed')).toBe(1);
    });

    test('广播到达时分发给所有活跃订阅者', () => {
        const ipc = new EventEmitter();
        const dispatcher = createSettingChangedDispatcher(ipc);
        const received: unknown[] = [];
        dispatcher.subscribe((setting) => received.push(['a', setting]));
        dispatcher.subscribe((setting) => received.push(['b', setting]));

        const setting = { locale: 'zh-CN' };
        ipc.emit('setting:changed', { sender: {} }, setting);

        expect(received).toEqual([
            ['a', setting],
            ['b', setting]
        ]);
    });

    test('退订后不再收到广播，且不影响其他订阅者', () => {
        const ipc = new EventEmitter();
        const dispatcher = createSettingChangedDispatcher(ipc);
        const received: string[] = [];
        const unsubscribeA = dispatcher.subscribe(() => received.push('a'));
        dispatcher.subscribe(() => received.push('b'));

        unsubscribeA();
        unsubscribeA(); // 重复退订应安全

        ipc.emit('setting:changed', {}, {});

        expect(received).toEqual(['b']);
    });
});

describe('preload onSettingChanged wiring', () => {
    const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');

    test('onSettingChanged 不再直接在 ipcRenderer 上挂 setting:changed listener', () => {
        const start = preloadSource.indexOf('onSettingChanged:');
        expect(start).toBeGreaterThan(-1);
        const end = preloadSource.indexOf('isFullscreen:', start);
        const source = preloadSource.slice(start, end);

        expect(source).not.toContain("ipcRenderer.on('setting:changed'");
        expect(source).toContain('settingChangedDispatcher.subscribe');
    });
});
