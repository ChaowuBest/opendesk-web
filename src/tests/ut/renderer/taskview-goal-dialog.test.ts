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
    return (key: string, args?: Record<string, string | number>): string => {
        let text: string = enUs[key] ?? key;
        if (args) {
            for (const [k, v] of Object.entries(args)) {
                text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
            }
        }
        return text;
    };
}

describe('task view goal controller dialog (issue #265 unified fix)', () => {
    let GoalController: typeof import('../../../renderer/components/taskview-goal/controller.js').GoalController;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent
        });
        (globalThis as any).window.alert = jest.fn();

        ({ GoalController } = await import('../../../renderer/components/taskview-goal/controller.js'));
    });

    beforeEach(() => {
        showInfoModal.mockClear();
        showInfoModal.mockResolvedValue(undefined);
        showConfirmModal.mockClear();
        (window as any).taskManagerAPI = {};
    });

    function createController() {
        const host = document.createElement('div') as HTMLDivElement & Record<string, any>;
        host.task_id = 'task-1';
        host.task_status = 'running';
        host._isTaskInputRunning = jest.fn(() => true);
        host.updateStopButtonVisibility = jest.fn();
        const controller = new GoalController(host, { getTranslator: createTranslate });
        return { controller, host };
    }

    test('pause failure shows the in-page dialog instead of a native alert', async () => {
        const { controller } = createController();
        (window as any).taskManagerAPI.pauseGoal = jest.fn(async () => ({
            ok: false,
            messageKey: 'goal.edit.conflict'
        }));

        const paused = await controller.pauseActiveGoal();

        expect(paused).toBe(false);
        expect(showInfoModal).toHaveBeenCalledTimes(1);
        expect(showInfoModal).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Goal',
                message: 'The goal changed while confirmation was open. Review the latest goal and try again.',
                confirmText: 'Confirm'
            })
        );
        expect((globalThis as any).window.alert).not.toHaveBeenCalled();
    });

    test('unsupported goal supplement shows the in-page dialog and reports unsupported', async () => {
        const { controller } = createController();
        controller.currentGoal = { id: 'goal-1', status: 'active', revision: 1 };

        const outcome = await controller.handleActiveGoalInput(
            { message: 'see attachment', attachedFilePaths: [], attachedImages: [{ id: 'img-1' }] },
            { alertUnsupported: true }
        );

        expect(outcome).toBe('unsupported');
        expect(showInfoModal).toHaveBeenCalledTimes(1);
        expect((globalThis as any).window.alert).not.toHaveBeenCalled();
    });

    test('goal supplement failure resolves only after the in-page dialog closes', async () => {
        const { controller } = createController();
        controller.currentGoal = { id: 'goal-1', status: 'active', revision: 1 };
        (window as any).taskManagerAPI.addGoalSupplement = jest.fn(async () => ({
            ok: false,
            messageKey: 'goal.edit.conflict'
        }));

        let resolveDialog: (() => void) | undefined;
        showInfoModal.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveDialog = resolve;
                })
        );

        let settled = false;
        const submission = controller.submitGoalSupplement({ message: '补充说明' }).then((result) => {
            settled = true;
            return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(showInfoModal).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);

        resolveDialog?.();
        const result = await submission;

        expect(settled).toBe(true);
        expect(result).toBe(false);
        expect((globalThis as any).window.alert).not.toHaveBeenCalled();
    });
});
