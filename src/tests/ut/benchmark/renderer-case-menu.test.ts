import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';
import { summarizeCases, type CaseRunState, type RunRecord } from '../../../main/applications/benchmark/common.js';

/**
 * 用例行右键菜单回归：
 * 之前只有 done/failed 的用例能弹出右键菜单，运行中的用例即使已拿到
 * runTaskId 也无法跳转到执行/验证任务。现在所有已加载的用例都给菜单，
 * 跳转项按 taskId 有无禁用；重跑在整轮已结束（非 running）时可用，
 * 整轮运行中禁用（原地重跑会与进行中的执行冲突）。
 */

function makeCase(patch: Partial<CaseRunState>): CaseRunState {
    return {
        key: 'track/case',
        trackId: 'track',
        trackName: 'Track',
        caseId: 'case',
        name: 'case',
        weight: 1,
        status: 'pending',
        score: null,
        ratio: null,
        reason: '',
        error: '',
        logError: '',
        runTaskId: null,
        verifyTaskId: null,
        startedAt: null,
        finishedAt: null,
        dir: 'cases/track__case',
        ...patch
    };
}

function makeRun(cases: CaseRunState[]): RunRecord {
    return {
        id: 'run-1',
        datasetId: 'ds-1',
        datasetName: 'DS',
        createdAt: 1,
        startedAt: 1,
        finishedAt: null,
        status: 'running',
        concurrency: 2,
        runModel: 'm1',
        verifyModel: 'm2',
        runModelEffort: '',
        verifyModelEffort: '',
        runTimeoutSec: null,
        verifyTimeoutSec: null,
        tracks: ['track'],
        cases,
        summary: summarizeCases(cases)
    };
}

describe('benchmark 用例行右键菜单', () => {
    let callMainWorld: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            CSS: { escape: (value: string) => value },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });

        await jest.unstable_mockModule('../../../main/applications/widget_utils.js', () => ({
            AgentOperableHTMLElement: class extends HTMLElement {},
            RendererTool: class {},
            RendererToolset: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/components/confirmModal', () =>
            confirmModalMockShim({
                showConfirmModal: jest.fn(),
                bindOverlayDismiss: jest.fn()
            })
        );

        await import('../../../main/applications/benchmark/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        // callMainWorld 的调用点普遍接 .catch(...)，桩必须返回 Promise
        callMainWorld = jest.fn(async () => undefined);
        (globalThis as any).window.applicationAPI = {
            call: jest.fn(),
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    function createWidget(run: RunRecord) {
        const widget = document.createElement('benchmark-entry-widget') as any;
        widget.detailRunId = run.id;
        widget.detail = run;
        widget.detailTab = 'cases';
        widget.render();
        // 与 connectedCallback 里的绑定保持一致（元素未挂载，需要手动绑定）
        widget.shadowRoot.addEventListener('click', widget.handleClick);
        widget.shadowRoot.addEventListener('contextmenu', widget.handleContextMenu);
        return widget;
    }

    function rightClick(widget: any, key: string) {
        const row = widget.shadowRoot.querySelector(`tr[data-case-key="${key}"]`) as HTMLElement;
        expect(row).not.toBeNull();
        // 浏览器原生 contextmenu 会冒泡到 shadowRoot 上的监听器，这里保持一致
        row.dispatchEvent(new window.Event('contextmenu', { bubbles: true }));
    }

    function openMenu(widget: any, key: string): HTMLElement {
        rightClick(widget, key);
        return widget.shadowRoot.querySelector('.case-menu') as HTMLElement;
    }

    test('运行中的用例右键弹出菜单，「跳转运行任务」可用且验证项禁用', () => {
        const run = makeRun([makeCase({ key: 't/running', status: 'running', runTaskId: 'task-1' })]);
        const widget = createWidget(run);

        const menu = openMenu(widget, 't/running');
        expect(menu).not.toBeNull();
        const jumpRun = menu.querySelector('[data-action="case-menu-jump-run"]') as HTMLElement;
        const jumpVerify = menu.querySelector('[data-action="case-menu-jump-verify"]') as HTMLElement;
        expect(jumpRun.hasAttribute('disabled')).toBe(false);
        expect(jumpVerify.hasAttribute('disabled')).toBe(true);
    });

    test('未开始（pending）的用例右键不弹菜单', () => {
        const run = makeRun([makeCase({ key: 't/pending', status: 'pending' })]);
        run.status = 'stopped';
        const widget = createWidget(run);

        rightClick(widget, 't/pending');
        expect(widget.shadowRoot.querySelector('.case-menu')).toBeNull();
    });

    test('跑过但被停止的用例可弹菜单，整轮结束后重跑可用', () => {
        const run = makeRun([makeCase({ key: 't/stopped', status: 'stopped', runTaskId: 'task-1' })]);
        run.status = 'stopped';
        const widget = createWidget(run);

        const menu = openMenu(widget, 't/stopped');
        expect(menu).not.toBeNull();
        expect((menu.querySelector('[data-action="case-menu-jump-run"]') as HTMLElement).hasAttribute('disabled')).toBe(
            false
        );
        expect(
            (menu.querySelector('[data-action="case-menu-jump-verify"]') as HTMLElement).hasAttribute('disabled')
        ).toBe(true);
        expect((menu.querySelector('[data-action="case-menu-rerun"]') as HTMLElement).hasAttribute('disabled')).toBe(
            false
        );
    });

    test('整轮运行中重跑项禁用，避免与进行中的执行冲突', () => {
        const run = makeRun([makeCase({ key: 't/done', status: 'done', runTaskId: 'task-1', verifyTaskId: 'task-2' })]);
        const widget = createWidget(run);

        const menu = openMenu(widget, 't/done');
        expect((menu.querySelector('[data-action="case-menu-rerun"]') as HTMLElement).hasAttribute('disabled')).toBe(
            true
        );
    });

    test('执行中的用例重跑项禁用，已结束的用例可用', () => {
        const run = makeRun([
            makeCase({ key: 't/running', status: 'running', runTaskId: 'task-1' }),
            makeCase({ key: 't/failed', status: 'failed', runTaskId: 'task-3' })
        ]);
        run.status = 'stopped';
        const widget = createWidget(run);

        expect(
            (
                openMenu(widget, 't/running').querySelector('[data-action="case-menu-rerun"]') as HTMLElement
            ).hasAttribute('disabled')
        ).toBe(true);
        expect(
            (openMenu(widget, 't/failed').querySelector('[data-action="case-menu-rerun"]') as HTMLElement).hasAttribute(
                'disabled'
            )
        ).toBe(false);
    });

    test('点击运行中用例菜单的「跳转运行任务」会打开对应任务', async () => {
        const run = makeRun([makeCase({ key: 't/running', status: 'running', runTaskId: 'task-1' })]);
        const widget = createWidget(run);

        const menu = openMenu(widget, 't/running');
        const jumpRun = menu.querySelector('[data-action="case-menu-jump-run"]') as HTMLElement;
        jumpRun.dispatchEvent(new window.Event('click', { bubbles: true }));
        await Promise.resolve();
        expect(callMainWorld).toHaveBeenCalledWith('openTask', 'task-1');
    });
});
