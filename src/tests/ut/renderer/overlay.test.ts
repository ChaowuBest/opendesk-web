import { beforeEach, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createOverlay } from '../../../renderer/components/overlay.js';

beforeEach(() => {
    const { window } = parseHTML('<html><head></head><body></body></html>');
    Object.assign(globalThis, { window, document: window.document });
    Object.getPrototypeOf(document.createElement('div').style).getPropertyPriority = () => ''; // linkedom omits CSS priorities.
    window.getComputedStyle = ((element: HTMLElement) => ({ position: element.style.position || 'static' })) as any;
});

test('defaults to the viewport and shares one stylesheet per root', () => {
    const first = createOverlay();
    const second = createOverlay();
    expect(first.element.parentNode).toBe(document.body);
    expect(first.element.classList.contains('od-overlay')).toBe(true);
    expect(document.querySelectorAll('style[data-od-overlay-style]')).toHaveLength(1);
    first.dispose();
    second.dispose();
    expect(document.querySelector('.od-overlay')).toBeNull();
});

test('local overlays retain positioning until the last overlay closes and restore the container', () => {
    const target = document.createElement('section');
    document.body.appendChild(target);
    const first = createOverlay({ target });
    const second = createOverlay({ target });
    expect(first.element.parentNode).toBe(target);
    expect(first.element.classList.contains('od-overlay-local')).toBe(true);
    expect(target.style.position).toBe('relative');
    first.dispose();
    first.dispose();
    expect(target.style.position).toBe('relative');
    second.dispose();
    expect(target.style.position || '').toBe('');

    target.style.position = 'absolute';
    const positioned = createOverlay({ target });
    positioned.dispose();
    expect(target.style.position).toBe('absolute');
});
