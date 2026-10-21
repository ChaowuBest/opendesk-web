/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { createOverlay } from './overlay.js';

const LIGHTBOX_ID = 'od-image-lightbox';

let _escHandler = null;
let _overlay = null;

/**
 * 显示图片大图预览浮层，点击或按 ESC 关闭。
 * @param {string} src 图片 URL 或 data URI
 */
export function showImageLightbox(src) {
    if (!src) return;
    dismissImageLightbox();

    const handle = createOverlay({ className: 'agent-input-lightbox-overlay' });
    _overlay = handle;
    const overlay = handle.element;
    overlay.id = LIGHTBOX_ID;
    overlay.innerHTML = `<img src="${src}" class="agent-input-lightbox-img" />`;
    overlay.addEventListener('click', dismissImageLightbox);

    // 在 document 上监听 ESC 键，确保一定能收到事件
    _escHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            dismissImageLightbox();
        }
    };
    document.addEventListener('keydown', _escHandler);
}

export function dismissImageLightbox() {
    // 先取出并清空模块级句柄：元素被外部代码移除时也要释放，否则句柄会一直
    // 指向一个已不存在的遮罩，下次 show 之前 _overlay 都是脏的
    const handle = _overlay;
    _overlay = null;

    const el = document.getElementById(LIGHTBOX_ID);
    if (!el) {
        handle?.dispose();
        return;
    }

    // 移除 ESC 监听器
    if (_escHandler) {
        document.removeEventListener('keydown', _escHandler);
        _escHandler = null;
    }

    const drop = () => (handle ? handle.dispose() : el.remove());

    // 添加关闭动画类，等待动画结束后移除元素
    el.classList.add('closing');
    el.addEventListener('transitionend', drop, { once: true });

    // 备用：如果 transitionend 未触发（如元素被其他代码移除），200ms 后强制移除
    setTimeout(() => {
        if (el.parentNode) {
            drop();
        }
    }, 200);
}
