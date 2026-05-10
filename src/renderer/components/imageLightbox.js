/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

const LIGHTBOX_ID = 'od-image-lightbox';

/**
 * 显示图片大图预览浮层，点击或按 ESC 关闭。
 * @param {string} src 图片 URL 或 data URI
 */
export function showImageLightbox(src) {
    if (!src) return;
    dismissImageLightbox();

    const overlay = document.createElement('div');
    overlay.id = LIGHTBOX_ID;
    overlay.className = 'agent-input-lightbox-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `<img src="${src}" class="agent-input-lightbox-img" />`;
    overlay.addEventListener('click', dismissImageLightbox);
    overlay.addEventListener('keydown', _lightboxKeyHandler);
    document.body.appendChild(overlay);
    overlay.focus();
}

export function dismissImageLightbox() {
    const el = document.getElementById(LIGHTBOX_ID);
    if (el) {
        el.removeEventListener('keydown', _lightboxKeyHandler);
        el.remove();
    }
}

function _lightboxKeyHandler(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissImageLightbox();
    }
}
