import { beforeEach, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

beforeEach(() => {
    const { window } = parseHTML('<html><head></head><body></body></html>');
    Object.assign(globalThis, { window, document: window.document });
    window.getComputedStyle = ((element: HTMLElement) => ({
        position: element.style.position || 'static'
    })) as never;
});

async function loadLightbox() {
    jest.resetModules();
    return import('../../../renderer/components/imageLightbox.js');
}

const { showImageLightbox, dismissImageLightbox } = await loadLightbox();

test('shows the lightbox as a window-level overlay on body', () => {
    showImageLightbox('/img/a.png');

    const el = document.getElementById('od-image-lightbox');
    expect(el).not.toBeNull();
    expect(el!.parentNode).toBe(document.body);
    expect(el!.classList.contains('od-overlay-root')).toBe(true);
    expect(el!.classList.contains('agent-input-lightbox-overlay')).toBe(true);

    dismissImageLightbox();
});

test('dismiss releases the overlay through the closing-animation fallback', () => {
    // linkedom 不派发 transitionend，走 200ms 兜底释放；断言遮罩节点最终不残留
    jest.useFakeTimers();
    try {
        showImageLightbox('/img/a.png');
        expect(document.querySelectorAll('.od-overlay-root')).toHaveLength(1);

        dismissImageLightbox();
        jest.advanceTimersByTime(250);

        expect(document.getElementById('od-image-lightbox')).toBeNull();
        expect(document.querySelectorAll('.od-overlay-root')).toHaveLength(0);
    } finally {
        jest.useRealTimers();
    }
});

test('re-opening after an external teardown creates a fresh overlay', () => {
    showImageLightbox('/img/a.png');
    // 外部代码（重渲染、任务视图回收等）直接把节点摘掉，随后再次打开必须正常
    document.getElementById('od-image-lightbox')!.remove();
    dismissImageLightbox();

    showImageLightbox('/img/b.png');

    const el = document.getElementById('od-image-lightbox');
    expect(el).not.toBeNull();
    expect(el!.querySelector('img')?.getAttribute('src')).toBe('/img/b.png');
    expect(document.querySelectorAll('.od-overlay-root')).toHaveLength(1);
    dismissImageLightbox();
});
