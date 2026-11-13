import { describe, expect, jest, test } from '@jest/globals';
import { BackgroundUpdateGate } from '../../../renderer/utils/background-update-gate.js';

describe('BackgroundUpdateGate', () => {
    test('visible window keeps renders flowing', () => {
        const gate = new BackgroundUpdateGate(
            () => true,
            () => undefined
        );
        expect(gate.shouldSkipRender()).toBe(false);
    });

    test('undefined visibility flag is treated as visible', () => {
        // window.__isWindowVisible 尚未初始化时不得丢帧
        const gate = new BackgroundUpdateGate(
            () => undefined as unknown as boolean,
            () => undefined
        );
        expect(gate.shouldSkipRender()).toBe(false);
    });

    test('hidden window skips renders and arms a pending reload', () => {
        let visible = false;
        const onPendingReload = jest.fn();
        const gate = new BackgroundUpdateGate(() => visible, onPendingReload);
        expect(gate.shouldSkipRender()).toBe(true);

        visible = true;
        gate.onWindowBecameVisible();
        expect(onPendingReload).toHaveBeenCalledTimes(1);

        // 标记一次性：没有新的丢帧就不重复补齐
        gate.onWindowBecameVisible();
        expect(onPendingReload).toHaveBeenCalledTimes(1);
    });

    test('repeated drops coalesce into a single reload', () => {
        const onPendingReload = jest.fn();
        const gate = new BackgroundUpdateGate(() => false, onPendingReload);
        gate.shouldSkipRender();
        gate.shouldSkipRender();
        gate.shouldSkipRender();
        gate.onWindowBecameVisible();
        expect(onPendingReload).toHaveBeenCalledTimes(1);
    });

    test('becoming visible without prior drops does not reload', () => {
        let visible = true;
        const onPendingReload = jest.fn();
        const gate = new BackgroundUpdateGate(() => visible, onPendingReload);
        expect(gate.shouldSkipRender()).toBe(false);
        gate.onWindowBecameVisible();
        expect(onPendingReload).not.toHaveBeenCalled();

        // 再次隐藏-显示周期同样不触发
        visible = false;
        gate.onWindowBecameVisible();
        visible = true;
        gate.onWindowBecameVisible();
        expect(onPendingReload).not.toHaveBeenCalled();
    });

    test('drops after a consumed reload arm a new pending reload', () => {
        const onPendingReload = jest.fn();
        const gate = new BackgroundUpdateGate(() => false, onPendingReload);
        gate.shouldSkipRender();
        gate.onWindowBecameVisible();
        expect(onPendingReload).toHaveBeenCalledTimes(1);

        // 第二个隐藏周期：再次丢帧 + 恢复 → 第二次补齐
        gate.shouldSkipRender();
        gate.onWindowBecameVisible();
        expect(onPendingReload).toHaveBeenCalledTimes(2);
    });

    test('markPendingReload arms without a skip decision and shares the single slot', () => {
        let visible = true;
        const onPendingReload = jest.fn();
        const gate = new BackgroundUpdateGate(() => visible, onPendingReload);
        // 窗口仍可见（无丢帧）也可直接登记：供缓冲定时器跨隐藏边界丢弃等路径使用
        gate.markPendingReload();
        expect(gate.shouldSkipRender()).toBe(false);
        visible = false;
        expect(gate.shouldSkipRender()).toBe(true);
        visible = true;
        gate.onWindowBecameVisible();
        expect(onPendingReload).toHaveBeenCalledTimes(1);
        gate.onWindowBecameVisible();
        expect(onPendingReload).toHaveBeenCalledTimes(1);
    });
});
