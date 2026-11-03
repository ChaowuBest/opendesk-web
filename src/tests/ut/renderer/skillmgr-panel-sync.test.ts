import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/* 技能中心 installed 面板的局部结果区同步：结构切换（空态 <-> 列表）必须整页重建 */
describe('skill center panel body sync', () => {
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
            IntersectionObserver: class {
                observe() {}
                disconnect() {}
                unobserve() {}
            },
            ResizeObserver: class {
                observe() {}
                disconnect() {}
                unobserve() {}
            },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal', () => ({
            showConfirmModal: jest.fn(async () => true),
            bindOverlayDismiss: jest.fn(),
            renderIcon: jest.fn(() => '<i class="mock-icon"></i>')
        }));
        await jest.unstable_mockModule('../../../renderer/components/skills/skill-detail-card.ts', () => ({
            getSkillInitial: () => 'A',
            getSkillPastel: () => ({ bg: '#eee', text: '#333' })
        }));
        await jest.unstable_mockModule('../../../renderer/deferredSubscription.js', () => ({
            adoptDeferredSubscription: jest.fn()
        }));
        await jest.unstable_mockModule('../../../common/markdown/markdown-html-safety.js', () => ({
            neutralizeMarkdownHtml: (html: string) => html
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));
        await jest.unstable_mockModule('../../../main/applications/skillmgr/renderer/duplicateInstallModal.js', () => ({
            showDuplicateInstallModal: jest.fn(async () => null)
        }));

        await import('../../../main/applications/skillmgr/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        (window as any).applicationAPI = {
            call: jest.fn(async () => undefined),
            callMainWorld: jest.fn(async () => undefined),
            streamCall: jest.fn(),
            subscribe: jest.fn(() => () => undefined),
            unsubscribe: jest.fn(),
            sendNotification: jest.fn()
        };
    });

    function skill(id: string, name: string) {
        return { id, name, description: `${name} description`, enabled: true };
    }

    function createWidget(skills: unknown[]) {
        const widget = document.createElement('skillmgr-entry-widget') as any;
        widget.skills = skills;
        widget.externalSkills = [];
        widget.builtinSkills = [];
        widget.loading = false;
        widget.error = null;
        widget.activeTab = 'installed';
        widget.render();
        return widget;
    }

    test('刷新从空态拉回技能时局部同步会重建面板，而不是停在旧空态', () => {
        const widget = createWidget([]);
        // 0 个技能时面板是空态，没有结果区节点
        expect(widget.shadowRoot.querySelector('#panel-installed .panel-body')).toBeNull();

        widget.skills = [skill('s1', 'Alpha')];
        widget._syncPanelBody('installed', { fade: false });

        const panel = widget.shadowRoot.querySelector('#panel-installed') as HTMLElement;
        expect(panel.textContent).toContain('Alpha');
        expect(panel.querySelector('.panel-body')).not.toBeNull();
    });

    test('技能被清空后局部同步回到空态，不留旧卡片', () => {
        const widget = createWidget([skill('s1', 'Alpha')]);
        expect(widget.shadowRoot.querySelector('#panel-installed .panel-body')).not.toBeNull();

        widget.skills = [];
        widget._syncPanelBody('installed', { fade: false });

        const panel = widget.shadowRoot.querySelector('#panel-installed') as HTMLElement;
        expect(panel.textContent).not.toContain('Alpha');
        expect(panel.querySelector('.empty-state')).not.toBeNull();
    });

    test('普通筛选沿用局部替换：结果区节点保持同一个，不整页重建', () => {
        const widget = createWidget([skill('s1', 'Alpha'), skill('s2', 'Beta')]);
        const body = widget.shadowRoot.querySelector('#panel-installed .panel-body') as HTMLElement;

        widget.installedState.query = 'beta';
        widget._syncPanelBody('installed', { fade: false });

        const panel = widget.shadowRoot.querySelector('#panel-installed') as HTMLElement;
        expect(panel.querySelector('.panel-body')).toBe(body);
        expect(body.textContent).toContain('Beta');
        expect(body.textContent).not.toContain('Alpha');
    });
});
