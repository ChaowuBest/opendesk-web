import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

type QueuePanel = HTMLElement & {
    setQueue: (queue: Array<{ id: string; message: string }>) => void;
    setCallbacks: (send: jest.Mock, edit: jest.Mock, remove: jest.Mock, reorder: jest.Mock) => void;
};

function pointerEvent(type: string, pointerId: number, clientY: number, pointerType: string): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: pointerType },
        isPrimary: { value: true },
        button: { value: 0 },
        clientY: { value: clientY }
    });
    return event;
}

describe('message queue reorder handle', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
            confirmModalMockShim({
                showConfirmModal: jest.fn()
            })
        );
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand: jest.fn(),
            refreshPluginSlashCommands: jest.fn()
        }));
        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function setup() {
        const panel = document.createElement('message-queue-panel') as QueuePanel;
        const reorder = jest.fn();
        panel.setCallbacks(jest.fn(), jest.fn(), jest.fn(), reorder);
        panel.setQueue([
            { id: 'a', message: 'first' },
            { id: 'b', message: 'second' },
            { id: 'c', message: 'third' }
        ]);
        document.body.append(panel);
        panel.querySelectorAll('.message-queue-item').forEach((item) => {
            item.getBoundingClientRect = () => {
                const index = [...item.parentElement.children].indexOf(item);
                const offset = Number.parseFloat(item.style.getPropertyValue('--queue-offset')) || 0;
                const scale = Number.parseFloat(item.style.getPropertyValue('--queue-scale')) || 1;
                const height = 40 * scale;
                const top = index * 40 + offset + (40 - height) / 2;
                return { top, bottom: top + height, height } as DOMRect;
            };
        });
        return { panel, reorder };
    }

    test.each(['mouse', 'touch'])('%s drag moves an item to its insertion position', (pointerType) => {
        const { panel, reorder } = setup();
        expect(panel.querySelector('.message-queue-item-index')).toBeNull();
        const handle = panel.querySelectorAll('.message-queue-drag-handle')[0] as HTMLElement;
        expect(handle.querySelector('svg')).not.toBeNull();

        handle.dispatchEvent(pointerEvent('pointerdown', 7, 20, pointerType));
        window.dispatchEvent(pointerEvent('pointermove', 7, 115, pointerType));
        window.dispatchEvent(pointerEvent('pointerup', 7, 115, pointerType));

        expect(reorder).toHaveBeenCalledWith('a', 2);
    });

    test('reorders the visible list while the pointer is still moving', () => {
        const { panel, reorder } = setup();
        const list = panel.querySelector('.message-queue-list') as HTMLElement;
        const handle = panel.querySelectorAll('.message-queue-drag-handle')[0] as HTMLElement;

        handle.dispatchEvent(pointerEvent('pointerdown', 8, 20, 'mouse'));
        window.dispatchEvent(pointerEvent('pointermove', 8, 115, 'mouse'));

        expect([...list.children].map((item) => (item as HTMLElement).dataset.queueId)).toEqual(['b', 'c', 'a']);
        expect(panel.querySelector('[data-queue-id="a"]')?.classList.contains('message-queue-item-dragging')).toBe(
            true
        );
        expect(reorder).not.toHaveBeenCalled();

        window.dispatchEvent(pointerEvent('pointerup', 8, 115, 'mouse'));
    });

    test.each(['mouse', 'touch'])('%s drag responds before reaching the swap threshold', (pointerType) => {
        const { panel, reorder } = setup();
        const items = [...panel.querySelectorAll('.message-queue-item')] as HTMLElement[];
        const handle = items[0].querySelector('.message-queue-drag-handle') as HTMLElement;

        handle.dispatchEvent(pointerEvent('pointerdown', 9, 20, pointerType));
        window.dispatchEvent(pointerEvent('pointermove', 9, 40, pointerType));

        expect([...panel.querySelectorAll('.message-queue-item')].map((item) => item.dataset.queueId)).toEqual([
            'a',
            'b',
            'c'
        ]);
        expect(items[0].style.getPropertyValue('--queue-offset')).toBe('20px');
        expect(Number.parseFloat(items[1].style.getPropertyValue('--queue-offset'))).toBeGreaterThan(0);
        expect(Number.parseFloat(items[1].style.getPropertyValue('--queue-scale'))).toBeLessThan(1);
        expect(panel.querySelector('.message-queue-drop-before, .message-queue-drop-after')).toBeNull();
        expect(reorder).not.toHaveBeenCalled();

        window.dispatchEvent(pointerEvent('pointerup', 9, 40, pointerType));
        expect(items[0].style.getPropertyValue('--queue-offset') ?? '').toBe('');
        expect(items[1].style.getPropertyValue('--queue-offset') ?? '').toBe('');
    });

    test('dragging upward gently displaces the preceding message before swapping', () => {
        const { panel } = setup();
        const items = [...panel.querySelectorAll('.message-queue-item')] as HTMLElement[];
        const handle = items[2].querySelector('.message-queue-drag-handle') as HTMLElement;

        handle.dispatchEvent(pointerEvent('pointerdown', 10, 100, 'mouse'));
        window.dispatchEvent(pointerEvent('pointermove', 10, 82, 'mouse'));

        expect(items[2].style.getPropertyValue('--queue-offset')).toBe('-18px');
        expect(Number.parseFloat(items[1].style.getPropertyValue('--queue-offset'))).toBeLessThan(0);
        window.dispatchEvent(pointerEvent('pointercancel', 10, 82, 'mouse'));
    });

    test('the dragged message stays aligned with the pointer across a swap', () => {
        const { panel } = setup();
        const item = panel.querySelector('[data-queue-id="a"]') as HTMLElement;
        const handle = item.querySelector('.message-queue-drag-handle') as HTMLElement;

        handle.dispatchEvent(pointerEvent('pointerdown', 11, 20, 'mouse'));
        window.dispatchEvent(pointerEvent('pointermove', 11, 40, 'mouse'));
        window.dispatchEvent(pointerEvent('pointermove', 11, 65, 'mouse'));

        expect([...panel.querySelectorAll('.message-queue-item')].map((row) => row.dataset.queueId)).toEqual([
            'b',
            'a',
            'c'
        ]);
        expect(item.getBoundingClientRect().top + 20).toBe(65);
        window.dispatchEvent(pointerEvent('pointerup', 11, 65, 'mouse'));
    });

    test('stops at the bottom once the dragged message is last', () => {
        const { panel } = setup();
        const list = panel.querySelector('.message-queue-list') as HTMLElement;
        list.getBoundingClientRect = () => ({ top: 0, bottom: 80, height: 80 }) as DOMRect;
        Object.defineProperties(list, {
            clientHeight: { value: 80, configurable: true },
            scrollHeight: { value: 200, configurable: true }
        });
        const item = panel.querySelector('[data-queue-id="a"]') as HTMLElement;
        const handle = item.querySelector('.message-queue-drag-handle') as HTMLElement;
        const previousRequestAnimationFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = jest.fn(() => 1);

        handle.dispatchEvent(pointerEvent('pointerdown', 12, 20, 'mouse'));
        window.dispatchEvent(pointerEvent('pointermove', 12, 115, 'mouse'));
        (window.requestAnimationFrame as jest.Mock).mockClear();
        window.dispatchEvent(pointerEvent('pointermove', 12, 260, 'mouse'));

        expect((window.requestAnimationFrame as jest.Mock).mock.calls).toHaveLength(0);
        expect(item.getBoundingClientRect().bottom).toBeLessThanOrEqual(80);
        window.dispatchEvent(pointerEvent('pointerup', 12, 260, 'mouse'));
        window.requestAnimationFrame = previousRequestAnimationFrame;
    });

    test('releasing without moving or cancelling a drag does not change order', () => {
        const { panel, reorder } = setup();
        const handle = panel.querySelectorAll('.message-queue-drag-handle')[0] as HTMLElement;

        handle.dispatchEvent(pointerEvent('pointerdown', 1, 20, 'mouse'));
        window.dispatchEvent(pointerEvent('pointerup', 1, 20, 'mouse'));
        handle.dispatchEvent(pointerEvent('pointerdown', 2, 20, 'touch'));
        window.dispatchEvent(pointerEvent('pointermove', 2, 115, 'touch'));
        window.dispatchEvent(pointerEvent('pointercancel', 2, 115, 'touch'));

        expect(reorder).not.toHaveBeenCalled();
        expect([...panel.querySelectorAll('.message-queue-item')].map((item) => item.dataset.queueId)).toEqual([
            'a',
            'b',
            'c'
        ]);
        expect(panel.querySelector('.message-queue-item-dragging')).toBeNull();
    });

    test('dragging upward places the last item first', () => {
        const { panel, reorder } = setup();
        const handle = panel.querySelectorAll('.message-queue-drag-handle')[2] as HTMLElement;

        handle.dispatchEvent(pointerEvent('pointerdown', 3, 100, 'mouse'));
        window.dispatchEvent(pointerEvent('pointermove', 3, 5, 'mouse'));
        window.dispatchEvent(pointerEvent('pointerup', 3, 5, 'mouse'));

        expect(reorder).toHaveBeenCalledWith('c', 0);
    });

    test('dragging near the edge scrolls a long queue until released', () => {
        const { panel } = setup();
        const list = panel.querySelector('.message-queue-list') as HTMLElement;
        list.getBoundingClientRect = () => ({ top: 0, bottom: 80 }) as DOMRect;
        list.scrollTop = 0;
        let frame: FrameRequestCallback | undefined;
        window.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
            frame = callback;
            return 1;
        });
        window.cancelAnimationFrame = jest.fn();
        const handle = panel.querySelectorAll('.message-queue-drag-handle')[0] as HTMLElement;

        handle.dispatchEvent(pointerEvent('pointerdown', 4, 20, 'touch'));
        window.dispatchEvent(pointerEvent('pointermove', 4, 75, 'touch'));
        expect(frame).toBeDefined();
        frame?.(0);
        expect(list.scrollTop).toBeGreaterThan(0);
        window.dispatchEvent(pointerEvent('pointercancel', 4, 75, 'touch'));
        expect(window.cancelAnimationFrame).toHaveBeenCalled();
    });

    test('arrow keys move a focused handle one position', () => {
        const { panel, reorder } = setup();
        const handle = panel.querySelectorAll('.message-queue-drag-handle')[1] as HTMLElement;
        const event = new Event('keydown', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'key', { value: 'ArrowUp' });

        handle.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(reorder).toHaveBeenCalledWith('b', 0);
    });
});
