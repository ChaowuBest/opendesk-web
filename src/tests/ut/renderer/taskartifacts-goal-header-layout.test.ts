import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

/**
 * 窄面板下 goal 头部与目标卡片的排版回归测试（issue #326）。
 *
 * 约定：
 * 1. 编辑 / 暂停(恢复) / 清除 属于目标本身的操作，渲染在卡片右下角；创建目标是全局动作，留在头部；
 * 2. 目标已清除时头部不再挂灰色状态标签，改由卡片标题「目标已清除」+ 正文删除线表达；
 * 3. 结构层：按钮文案独立成 span 且带 title，窄容器可只保留图标；
 * 4. 样式层：头部与操作区允许换行（绝不重叠），标题与按钮禁止逐字断行，窄容器隐藏文案。
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

function renderSection(status: string): HTMLElement {
    const controller = new TaskArtifactsGoalController(makeHost());
    controller.setGoalState({
        id: 'goal-1',
        status,
        revision: 1,
        objective: 'test',
        pendingContinuation: false,
        updatedAt: '2026-10-01T12:00:00.000Z'
    });
    const { document: doc } = parseHTML(
        `<!doctype html><html><body>${controller.renderTaskPlanContent()}</body></html>`
    );
    const section = doc.querySelector('.goal-section') as HTMLElement;
    expect(section).toBeTruthy();
    return section;
}

function actionIds(root: Element | null): string[] {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.goal-action-btn')).map((btn) => btn.getAttribute('data-goal-action'));
}

describe('goal header narrow-panel layout', () => {
    test('每个操作按钮都由图标与独立文案 span 组成，并带 title 兜底', () => {
        const section = renderSection('active');
        const buttons = Array.from(section.querySelectorAll('.goal-action-btn')) as HTMLElement[];
        expect(buttons.length).toBeGreaterThan(0);

        for (const button of buttons) {
            expect(button.querySelector('i.goal-action-icon')).toBeTruthy();
            const label = button.querySelector('.goal-action-label');
            expect(label).toBeTruthy();
            // 窄面板隐藏文案后，title 是唯一可读提示
            expect(button.getAttribute('title')).toBe(label!.textContent);
        }
    });

    test('标题文案独立成节点，避免与徽章一起被压缩逐字断行', () => {
        const header = renderSection('active').querySelector('.goal-header') as HTMLElement;
        expect(header.querySelector('.goal-title > .goal-title-text')).toBeTruthy();
        expect(header.querySelector('.goal-title .goal-badge')).toBeTruthy();
    });

    test('目标动作渲染在卡片右下角，创建目标留在头部', () => {
        const active = renderSection('active');
        expect(actionIds(active.querySelector('.goal-card-actions'))).toEqual(['edit-start', 'pause', 'clear']);
        expect(active.querySelector('.goal-header .goal-actions')).toBeFalsy();

        const complete = renderSection('complete');
        expect(actionIds(complete.querySelector('.goal-card-actions'))).toEqual(['clear']);
        expect(actionIds(complete.querySelector('.goal-header .goal-actions'))).toEqual(['create-new']);

        const cleared = renderSection('cleared');
        expect(cleared.querySelector('.goal-card-actions')).toBeFalsy();
        expect(actionIds(cleared.querySelector('.goal-header .goal-actions'))).toEqual(['create-new']);
    });

    test('已清除的目标不再显示状态标签，改由卡片标题与正文删除线表达', () => {
        const cleared = renderSection('cleared');
        expect(cleared.querySelector('.goal-badge')).toBeFalsy();
        expect(cleared.querySelector('.goal-card-label')?.textContent).toBe('goal.panel.cleared_title');
        expect(cleared.querySelector('.goal-objective')?.classList.contains('goal-objective-cleared')).toBe(true);

        const active = renderSection('active');
        expect(active.querySelector('.goal-badge')).toBeTruthy();
        expect(active.querySelector('.goal-card-label')?.textContent).toBe('goal.panel.title');
        expect(active.querySelector('.goal-objective')?.classList.contains('goal-objective-cleared')).toBe(false);
    });

    test('头部允许换行且以容器查询驱动窄面板只显示图标', () => {
        const css = readFileSync(GOAL_CSS_PATH, 'utf8');
        const headerRule = css.match(/\.goal-header\s*\{[^}]*\}/)?.[0] ?? '';
        expect(headerRule).toContain('flex-wrap: wrap');
        expect(headerRule).toContain('container-type: inline-size');

        // 标题与按钮文案禁止逐字断行
        const titleTextRule = css.match(/\.goal-title-text\s*\{[^}]*\}/)?.[0] ?? '';
        expect(titleTextRule).toContain('white-space: nowrap');
        const actionBtnRule = css.match(/\.goal-action-btn\s*\{[^}]*\}/)?.[0] ?? '';
        expect(actionBtnRule).toContain('white-space: nowrap');
        // 行盒收到 1em，中文文案在药丸按钮里才真正上下居中
        expect(actionBtnRule).toContain('line-height: 1');
        // 图标比文案略小，且固定 1em 盒子居中，避免 Font Awesome 行盒不对称导致偏移
        const actionIconRule = css.match(/\.goal-action-icon\s*\{[^}]*\}/)?.[0] ?? '';
        expect(actionIconRule).toContain('font-size');
        expect(actionIconRule).toContain('height: 1em');
        expect(actionIconRule).toContain('line-height: 1');

        // 卡片操作区靠右下角，且自身是窄面板查询容器
        const cardActionsRule = css.match(/\.goal-card-actions\s*\{[^}]*\}/)?.[0] ?? '';
        expect(cardActionsRule).toContain('justify-content: flex-end');
        const cardRule = css.match(/\.goal-card\s*\{[^}]*\}/)?.[0] ?? '';
        expect(cardRule).toContain('container-type: inline-size');

        // 已清除正文删除线
        const clearedRule = css.match(/\.goal-objective-cleared\s*\{[^}]*\}/)?.[0] ?? '';
        expect(clearedRule).toContain('line-through');

        // 窄容器内隐藏文案，只保留图标（头部与卡片各一份）
        const containerBlocks = css.match(/@container[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
        expect(containerBlocks.length).toBeGreaterThanOrEqual(2);
        expect(containerBlocks.join('\n')).toContain('.goal-action-label');
    });
});
