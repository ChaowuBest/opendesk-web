import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { enUs } from '../../../locale/en-us.js';

const showConfirmModal = jest.fn(async () => true);
const showInfoModal = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal,
    showInfoModal,
    // 与真实实现同构的轻量转换：转义 HTML 并保留换行
    escapeModalText: (text: string) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}));

function createTranslate() {
    return (key: string, params?: Record<string, string | number>): string => {
        let text: string = enUs[key] ?? key;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
            }
        }
        return text;
    };
}

describe('task artifacts goal dialog (issue #265 unified fix)', () => {
    let TaskArtifactsGoalController: typeof import('../../../renderer/components/taskartifacts-goal/controller.js').TaskArtifactsGoalController;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent
        });
        (globalThis as any).window.alert = jest.fn();

        ({ TaskArtifactsGoalController } =
            await import('../../../renderer/components/taskartifacts-goal/controller.js'));
    });

    beforeEach(() => {
        showInfoModal.mockClear();
        showInfoModal.mockResolvedValue(undefined);
        showConfirmModal.mockClear();
    });

    function createController() {
        const host = {
            element: document.createElement('div'),
            getShadowRoot: () => null,
            getTaskId: () => 'task-1',
            isTaskRunning: () => false,
            switchToTaskPlan: jest.fn(),
            syncTaskPlanVisibility: jest.fn(),
            renderTaskPlanPanel: jest.fn(),
            translate: createTranslate()
        };
        return { controller: new TaskArtifactsGoalController(host as any), host };
    }

    test('showGoalCreationForm shows the in-page dialog and switches to the plan only after it closes', async () => {
        const { controller, host } = createController();
        controller.setGoalState({ id: 'goal-1', status: 'active', revision: 1, objective: '当前目标' });
        // setGoalState 首次设置 goal 时会自动 switchToTaskPlan，这里只关注 showGoalCreationForm 的时序
        host.switchToTaskPlan.mockClear();

        let resolveDialog: (() => void) | undefined;
        showInfoModal.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveDialog = resolve;
                })
        );

        const creation = controller.showGoalCreationForm();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(showInfoModal).toHaveBeenCalledTimes(1);
        expect(showInfoModal).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Goal',
                message: expect.stringContaining('Complete or clear the goal before creating a new one.'),
                confirmText: 'Confirm'
            })
        );
        expect(host.switchToTaskPlan).not.toHaveBeenCalled();

        resolveDialog?.();
        await creation;
        expect(host.switchToTaskPlan).toHaveBeenCalledTimes(1);
        expect((globalThis as any).window.alert).not.toHaveBeenCalled();
    });

    test('showGoalCreationForm opens the creation form directly when no unfinished goal exists', async () => {
        const { controller, host } = createController();
        controller.setGoalState(null);

        await controller.showGoalCreationForm();

        expect(showInfoModal).not.toHaveBeenCalled();
        expect(host.switchToTaskPlan).toHaveBeenCalledTimes(1);
    });
});
