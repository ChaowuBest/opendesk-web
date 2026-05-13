/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 通用确认模态弹窗。
 *
 * 设计风格与日历 app 拖动日程确认弹窗一致：
 *   - 背景蒙层：半透明黑色 + 模糊，fade 动画进入
 *   - 卡片：大圆角、柔和阴影，scale + translateY 弹性进入
 *   - 按钮：主要 / 次要 / 危险三种样式
 *   - 支持 Esc 键关闭、点击蒙层关闭
 *
 * 使用方式：
 *   const confirmed = await showConfirmModal({ ... });
 */

export interface ConfirmModalOptions {
    /** 图标的 FontAwesome class，如 'fa-trash-can' */
    icon?: string;
    /** 图标容器背景色（默认 #FEF2F2） */
    iconBg?: string;
    /** 图标颜色（默认 #DC2626） */
    iconColor?: string;
    /** 弹窗标题 */
    title: string;
    /** 弹窗内容描述（支持 HTML） */
    message: string;
    /** 确认按钮文本（默认 "确认"） */
    confirmText?: string;
    /** 取消按钮文本（默认 "取消"） */
    cancelText?: string;
    /** 确认按钮是否为危险样式（红色，默认 false） */
    danger?: boolean;
    /** 挂载目标（默认 document.body，可传 shadowRoot 中的元素） */
    mountTarget?: HTMLElement;
}

const ANIM_DURATION_IN = 250;
const ANIM_DURATION_OUT = 180;

export function showConfirmModal(options: ConfirmModalOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const {
            icon = 'fa-circle-exclamation',
            iconBg = '#FEF2F2',
            iconColor = '#DC2626',
            title,
            message,
            confirmText = '确认',
            cancelText = '取消',
            danger = false,
            mountTarget = document.body
        } = options;

        const overlay = document.createElement('div');
        overlay.className = 'od-confirm-modal-overlay';
        overlay.innerHTML = `
<style>
    .od-confirm-modal-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.3); backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        animation: od-modal-fade-in ${ANIM_DURATION_IN}ms ease-out forwards;
    }
    .od-confirm-modal-overlay.od-modal-leaving {
        animation: od-modal-fade-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-confirm-modal-card {
        background: #fff; border-radius: 20px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
        width: 400px; max-width: 92vw; overflow: hidden;
        animation: od-modal-scale-in ${ANIM_DURATION_IN}ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
    }
    .od-confirm-modal-overlay.od-modal-leaving .od-confirm-modal-card {
        animation: od-modal-scale-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-confirm-modal-body { padding: 28px; }
    .od-confirm-modal-header {
        display: flex; align-items: center; gap: 12px; margin-bottom: 18px;
    }
    .od-confirm-modal-icon {
        width: 42px; height: 42px; border-radius: 12px;
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .od-confirm-modal-icon i { font-size: 18px; }
    .od-confirm-modal-title {
        font-size: 16px; font-weight: 700; color: #1d1d1f; line-height: 1.3;
    }
    .od-confirm-modal-message {
        font-size: 14px; color: #3C3C43; line-height: 1.6; margin-bottom: 22px;
    }
    .od-confirm-modal-footer {
        display: flex; justify-content: flex-end; gap: 10px;
        padding-top: 16px; border-top: 1px solid #F0F0F0;
    }
    .od-confirm-btn {
        padding: 10px 24px; border-radius: 12px; border: none;
        font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    .od-confirm-btn:active { transform: scale(0.97); }
    .od-confirm-btn-cancel {
        background: #fff; color: #1d1d1f; border: 1.5px solid #E5E5EA;
    }
    .od-confirm-btn-cancel:hover { background: #F5F5F7; }
    .od-confirm-btn-primary {
        background: #1d1d1f; color: #fff;
    }
    .od-confirm-btn-primary:hover { background: #333; }
    .od-confirm-btn-danger {
        background: #DC2626; color: #fff;
    }
    .od-confirm-btn-danger:hover { background: #B91C1C; }

    @keyframes od-modal-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes od-modal-fade-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes od-modal-scale-in {
        from { opacity: 0; transform: scale(0.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes od-modal-scale-out {
        from { opacity: 1; transform: scale(1) translateY(0); }
        to { opacity: 0; transform: scale(0.95) translateY(10px); }
    }
</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-body">
        <div class="od-confirm-modal-header">
            <div class="od-confirm-modal-icon" style="background:${iconBg}">
                <i class="fas ${icon}" style="color:${iconColor}"></i>
            </div>
            <div class="od-confirm-modal-title">${title}</div>
        </div>
        <div class="od-confirm-modal-message">${message}</div>
        <div class="od-confirm-modal-footer">
            <button class="od-confirm-btn od-confirm-btn-cancel" data-action="cancel">${cancelText}</button>
            <button class="od-confirm-btn ${danger ? 'od-confirm-btn-danger' : 'od-confirm-btn-primary'}" data-action="confirm">${confirmText}</button>
        </div>
    </div>
</div>`;

        let resolved = false;
        const close = (result: boolean) => {
            if (resolved) return;
            resolved = true;
            overlay.classList.add('od-modal-leaving');
            setTimeout(() => {
                overlay.remove();
                resolve(result);
            }, ANIM_DURATION_OUT);
            document.removeEventListener('keydown', escHandler);
        };

        const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(false);
            }
        };
        document.addEventListener('keydown', escHandler);

        overlay.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).classList.contains('od-confirm-modal-overlay')) {
                close(false);
            }
        });

        overlay.querySelector('[data-action="cancel"]')!.addEventListener('click', () => close(false));
        overlay.querySelector('[data-action="confirm"]')!.addEventListener('click', () => close(true));

        mountTarget.appendChild(overlay);
    });
}
