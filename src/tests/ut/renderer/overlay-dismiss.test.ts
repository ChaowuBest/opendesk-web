import { describe, expect, it, jest } from '@jest/globals';
import { bindOverlayDismiss } from '../../../renderer/components/confirmModal.ts';

/**
 * 模拟一个最小化的 overlay 元素，仅记录事件监听器，便于在 node 环境下
 * 手动触发 mousedown / mouseup 并验证关闭回调的调用时机。
 */
function createFakeOverlay() {
    const listeners: Record<string, Array<(e: { target: unknown }) => void>> = {};
    const overlay = {
        listeners,
        addEventListener: (type: string, fn: (e: { target: unknown }) => void) => {
            (listeners[type] ||= []).push(fn);
        }
    } as unknown as HTMLElement;
    const fire = (type: 'mousedown' | 'mouseup', target: unknown) => {
        for (const fn of listeners[type] || []) {
            fn({ target });
        }
    };
    return { overlay, fire };
}

describe('bindOverlayDismiss', () => {
    it('弹窗内按下、遮罩上松开时不触发关闭（修复的 bug 场景）', () => {
        const { overlay, fire } = createFakeOverlay();
        const onDismiss = jest.fn();
        bindOverlayDismiss(overlay, onDismiss);

        const card = { nodeType: 1 };
        // 用户在弹窗卡片内按下（例如全选表单文本），拖到遮罩上松开
        fire('mousedown', card);
        fire('mouseup', overlay);

        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('遮罩上按下、遮罩上松开时触发关闭', () => {
        const { overlay, fire } = createFakeOverlay();
        const onDismiss = jest.fn();
        bindOverlayDismiss(overlay, onDismiss);

        fire('mousedown', overlay);
        fire('mouseup', overlay);

        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('遮罩上按下、弹窗内松开时不触发关闭', () => {
        const { overlay, fire } = createFakeOverlay();
        const onDismiss = jest.fn();
        bindOverlayDismiss(overlay, onDismiss);

        const card = { nodeType: 1 };
        fire('mousedown', overlay);
        fire('mouseup', card);

        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('一次未完成的拖拽后，下一次完整的遮罩点击仍能正常关闭（状态被重置）', () => {
        const { overlay, fire } = createFakeOverlay();
        const onDismiss = jest.fn();
        bindOverlayDismiss(overlay, onDismiss);

        const card = { nodeType: 1 };
        // 第一次：弹窗内按下 -> 遮罩上松开（不应关闭，且内部状态应被重置）
        fire('mousedown', card);
        fire('mouseup', overlay);
        // 第二次：完整遮罩点击（应正常关闭）
        fire('mousedown', overlay);
        fire('mouseup', overlay);

        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('支持自定义 isTarget 判断（如 classList.contains）', () => {
        const { overlay, fire } = createFakeOverlay();
        const onDismiss = jest.fn();
        const overlayTarget = { nodeType: 1, classList: { contains: (c: string) => c === 'od-confirm-modal-overlay' } };
        bindOverlayDismiss(
            overlay,
            onDismiss,
            (t) =>
                !!(t as { classList?: { contains(c: string): boolean } })?.classList?.contains?.(
                    'od-confirm-modal-overlay'
                )
        );

        // 按下与松开都在带遮罩类的目标上 -> 关闭
        fire('mousedown', overlayTarget);
        fire('mouseup', overlayTarget);
        expect(onDismiss).toHaveBeenCalledTimes(1);

        // 按下在卡片（无遮罩类）上 -> 不关闭
        fire('mousedown', { nodeType: 1 });
        fire('mouseup', overlayTarget);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('enabled=false 时完全不监听遮罩点击（带表单弹窗不应被点外关闭）', () => {
        const { overlay, fire } = createFakeOverlay();
        const onDismiss = jest.fn();
        bindOverlayDismiss(overlay, onDismiss, undefined, false);

        // 即使在遮罩上按下并松开也不应触发关闭
        fire('mousedown', overlay);
        fire('mouseup', overlay);
        expect(onDismiss).not.toHaveBeenCalled();

        // 且不应注册任何事件监听器
        expect(overlay.listeners.mousedown ?? []).toHaveLength(0);
        expect(overlay.listeners.mouseup ?? []).toHaveLength(0);
    });
});
