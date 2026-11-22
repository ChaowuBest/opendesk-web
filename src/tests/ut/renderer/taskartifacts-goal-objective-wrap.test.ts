import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

/**
 * goal 正文长路径等不可断行 token 的换行回归测试（issue #346）。
 *
 * 约定：
 * 1. goal 正文与时间线快照、评估正文/证据等自由文本区域都可能包含
 *    /data/.../task_xxx 这类不含空格的长路径；
 * 2. 默认断行规则下 `/` 不是断行机会，`white-space: pre-wrap` 无法让它们折行，
 *    必须 overflow-wrap: anywhere 才能在任意字符处断行且允许容器收缩；
 * 3. DOM 层：正文原样转义渲染在 .goal-objective 按钮内，不因长 token 截断。
 */

const GOAL_CSS_PATH = fileURLToPath(new URL('../../../renderer/styles/goal.css', import.meta.url));

let TaskArtifactsGoalController: any;

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        Element: window.Element,
        CustomEvent: window.CustomEvent,
        customElements: window.customElements
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
    return {
        element,
        getShadowRoot: () => null,
        getTaskId: () => 'task_test',
        isTaskRunning: () => true,
        switchToTaskPlan: jest.fn(),
        syncTaskPlanVisibility: jest.fn(),
        renderTaskPlanPanel: jest.fn(),
        // 直接返回 key，便于断言文案来源
        translate: (key: string) => key
    };
}

const LONG_PATH_OBJECTIVE =
    '打通在鸿蒙pc上构建并在npu上运行自定义算子的通路，部分工作已经在 ' +
    '/data/storage/el2/base/files/tasks/task_mwimsb34_by 中完成，请你参考 ./nnrt.md, ./ascendc.md 来完成';

describe('goal objective long-token wrapping', () => {
    test('goal 正文原样渲染长路径，不做截断处理', () => {
        const controller = new TaskArtifactsGoalController(makeHost());
        controller.setGoalState({
            id: 'goal-1',
            status: 'active',
            revision: 1,
            objective: LONG_PATH_OBJECTIVE,
            pendingContinuation: false,
            updatedAt: '2026-11-17T03:15:00.000Z'
        });
        const { document: doc } = parseHTML(
            `<!doctype html><html><body>${controller.renderTaskPlanContent()}</body></html>`
        );
        const objective = doc.querySelector('.goal-objective.goal-text') as HTMLElement;
        expect(objective).toBeTruthy();
        expect(objective.textContent).toBe(LONG_PATH_OBJECTIVE);
    });

    test('goal 正文允许在任意字符处断行，长路径不再撑破容器', () => {
        const css = readFileSync(GOAL_CSS_PATH, 'utf8');
        const objectiveRule = css.match(/\.goal-objective\s*\{[^}]*\}/)?.[0] ?? '';
        // pre-wrap 保留用户手写换行，但仅靠它无法折行无空格长路径
        expect(objectiveRule).toContain('white-space: pre-wrap');
        expect(objectiveRule).toContain('overflow-wrap: anywhere');
    });

    test('时间线快照同样使用 anywhere 断行（flex 子项需参与 min-content 收缩）', () => {
        const css = readFileSync(GOAL_CSS_PATH, 'utf8');
        const snapshotTextRule = css.match(/\.goal-timeline-objective-text\s*\{[^}]*\}/)?.[0] ?? '';
        expect(snapshotTextRule).toContain('overflow-wrap: anywhere');
    });

    test('评估正文与证据列表允许任意字符断行，证据路径不溢出', () => {
        const css = readFileSync(GOAL_CSS_PATH, 'utf8');
        const bodyRule = css.match(/\.goal-evaluation-body\s*\{[^}]*\}/)?.[0] ?? '';
        expect(bodyRule).toContain('overflow-wrap: anywhere');
        const evidenceRule = css.match(/\.goal-evaluation-evidence li\s*\{[^}]*\}/)?.[0] ?? '';
        expect(evidenceRule).toContain('overflow-wrap: anywhere');
    });
});
