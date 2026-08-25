import { beforeAll, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('shared skill detail card', () => {
    let window: any;
    let document: any;

    beforeAll(async () => {
        const parsed = parseHTML('<!doctype html><html><body></body></html>');
        window = parsed.window;
        document = window.document;
        Object.assign(globalThis, {
            window,
            document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements
        });
        await import('../../../renderer/components/skills/skill-detail-card.js');
    });

    function createCard(model: any): any {
        const card = document.createElement('skill-detail-card');
        card.model = model;
        return card;
    }

    test('renders a back button when backLabel is set and emits the back action', () => {
        const actions: string[] = [];
        const card = createCard({
            id: 'plugin',
            name: 'Plugin',
            closeLabel: 'Close',
            backLabel: 'Back',
            actions: []
        });
        card.addEventListener('skill-detail-action', (event: any) => actions.push(event.detail.id));

        const back = card.shadowRoot.querySelector('.detail-back');
        expect(back).not.toBeNull();
        expect(back.hasAttribute('hidden')).toBe(false);
        expect(back.getAttribute('aria-label')).toBe('Back');
        back.dispatchEvent(new window.Event('click'));

        expect(actions).toEqual(['back']);
    });

    test('hides the back button when backLabel is absent', () => {
        const card = createCard({
            id: 'plugin',
            name: 'Plugin',
            closeLabel: 'Close',
            actions: []
        });
        expect(card.shadowRoot.querySelector('.detail-back')?.hasAttribute('hidden')).toBe(true);
        // hidden 属性会被 .detail-back 的 display:flex 覆盖，必须有显式的 [hidden] 规则兜底
        const styles = card.shadowRoot.querySelector('style')?.textContent ?? '';
        expect(styles.replace(/\s/g, '')).toContain('.detail-back[hidden]{display:none');
    });

    test('reuses the dialog skeleton and only animates the body on view switch', () => {
        const card = createCard({ id: 'a', name: 'A', closeLabel: 'Close', actions: [] });
        const firstOverlay = card.shadowRoot.querySelector('.detail-overlay');
        const firstDialog = card.shadowRoot.querySelector('.detail-dialog');
        // 首次渲染无切换动画
        expect(card.shadowRoot.querySelector('.detail-body').className).not.toMatch(/body-switch/);

        card.model = { id: 'a', name: 'B', closeLabel: 'Close', transition: 'forward', actions: [] };

        // 骨架复用：遮罩与窗口元素保持同一实例，不重建
        expect(card.shadowRoot.querySelector('.detail-overlay')).toBe(firstOverlay);
        expect(card.shadowRoot.querySelector('.detail-dialog')).toBe(firstDialog);
        // 切换动画只作用于内容区
        expect(firstDialog.className).not.toMatch(/dialog-switch/);
        expect(card.shadowRoot.querySelector('.detail-body').className).toContain('body-switch-forward');
    });

    test('applies the back direction animation on view switch', () => {
        const card = createCard({ id: 'a', name: 'A', closeLabel: 'Close', actions: [] });
        card.model = { id: 'a', name: 'B', closeLabel: 'Close', transition: 'back', actions: [] };
        expect(card.shadowRoot.querySelector('.detail-body').className).toContain('body-switch-back');
    });

    test('locks dialog size on view switch and releases it afterwards', () => {
        const card = createCard({ id: 'a', name: 'A', closeLabel: 'Close', actions: [] });
        const dialog = card.shadowRoot.querySelector('.detail-dialog');
        Object.defineProperty(dialog, 'offsetWidth', { configurable: true, value: 680 });
        Object.defineProperty(dialog, 'offsetHeight', { configurable: true, value: 520 });

        card.model = { id: 'a', name: 'B', closeLabel: 'Close', transition: 'forward', actions: [] };
        expect(dialog.style.width).toBe('680px');
        expect(dialog.style.height).toBe('520px');

        card.model = { id: 'a', name: 'C', closeLabel: 'Close', actions: [] };
        expect(dialog.style.width ?? '').toBe('');
        expect(dialog.style.height ?? '').toBe('');
    });

    test('hides the action footer when no actions are provided', () => {
        const card = createCard({ id: 'a', name: 'A', closeLabel: 'Close', actions: [] });
        const footer = card.shadowRoot.querySelector('.detail-footer');
        expect(footer?.hasAttribute('hidden')).toBe(true);
    });
});
