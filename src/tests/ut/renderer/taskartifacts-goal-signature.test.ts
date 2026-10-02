import { beforeAll, describe, expect, jest } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * GoalStateController.setGoalState 内容签名短路的回归测试：
 * goal active 期间宿主每秒轮询 getGoalStatus 并以（内容相同的）summary 调用
 * setGoalState，签名未变时必须跳过面板全量 innerHTML 重建；内容真正变化时恢复。
 */
describe('task artifacts goal state signature guard', () => {
    let TaskArtifactsGoalController: any;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
            showConfirmModal: jest.fn(async () => true),
            showInfoModal: jest.fn(async () => undefined),
            showCloseDialog: jest.fn(),
            bindOverlayDismiss: jest.fn(),
            detectDarkMode: jest.fn(() => false),
            MODAL_CSS: '',
            renderIcon: jest.fn(() => ''),
            shouldConfirmOnEnter: jest.fn(() => false),
            MODAL_ANIM_DURATION_IN: 250,
            MODAL_ANIM_DURATION_OUT: 180,
            escapeModalText: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        }));

        const mod = await import('../../../renderer/components/taskartifacts-goal/controller.js');
        TaskArtifactsGoalController = (mod as any).TaskArtifactsGoalController;
    });

    function makeHost() {
        const element = document.createElement('div');
        const host = {
            element,
            getShadowRoot: () => null,
            getTaskId: () => 'task_test',
            isTaskRunning: () => true,
            switchToTaskPlan: jest.fn(),
            syncTaskPlanVisibility: jest.fn(),
            renderTaskPlanPanel: jest.fn(),
            translate: (key: string) => key
        };
        return host;
    }

    function goalSummary(overrides: Record<string, unknown> = {}) {
        return {
            id: 'goal-1',
            status: 'active',
            revision: 3,
            objective: '完成性能优化',
            pendingContinuation: false,
            updatedAt: '2026-10-02T00:00:00.000Z',
            ...overrides
        };
    }

    test('内容相同的重复 setGoalState 只渲染一次面板', () => {
        const host = makeHost();
        const controller = new TaskArtifactsGoalController(host);
        controller.setGoalState(goalSummary());
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(1);
        // mergeGoalSummary 每次产生新对象，但内容相同 → 签名短路
        for (let i = 0; i < 5; i++) {
            controller.setGoalState(goalSummary());
        }
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(1);
    });

    test('内容变化（revision/status/objective）时恢复重建', () => {
        const host = makeHost();
        const controller = new TaskArtifactsGoalController(host);
        controller.setGoalState(goalSummary());
        controller.setGoalState(goalSummary({ revision: 4 }));
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(2);
        controller.setGoalState(goalSummary({ revision: 4, status: 'complete' }));
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(3);
        controller.setGoalState(goalSummary({ revision: 4, status: 'complete', objective: '新目标' }));
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(4);
    });

    test('null ↔ null 短路，null → goal 正常渲染，goal → null 正常清理', () => {
        const host = makeHost();
        const controller = new TaskArtifactsGoalController(host);
        controller.setGoalState(null);
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(1);
        controller.setGoalState(null);
        controller.setGoalState(undefined);
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(1);
        controller.setGoalState(goalSummary());
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(2);
        controller.setGoalState(goalSummary());
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(2);
        controller.setGoalState(null);
        expect(host.renderTaskPlanPanel).toHaveBeenCalledTimes(3);
    });

    test('签名短路后再次变化时内部状态（goalState）保持同步', () => {
        const host = makeHost();
        const controller = new TaskArtifactsGoalController(host);
        controller.setGoalState(goalSummary());
        for (let i = 0; i < 3; i++) {
            controller.setGoalState(goalSummary());
        }
        expect((controller as any)._goalState?.revision).toBe(3);
        controller.setGoalState(goalSummary({ revision: 5 }));
        expect((controller as any)._goalState?.revision).toBe(5);
    });
});
