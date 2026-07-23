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

import { escapeHtml } from '../../../../common/utils/escape.js';
import { getSkillInitial, getSkillPastel } from '../../../../renderer/components/skills/skill-detail-card.ts';

const ANIM_DURATION_OUT = 180;
const CONFIRM_MODAL_STYLES = `
    .od-confirm-modal-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.3); backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        animation: od-modal-fade-in 250ms ease-out forwards;
    }
    .od-confirm-modal-overlay.od-modal-leaving {
        animation: od-modal-fade-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-confirm-modal-card {
        background: #fff; border-radius: 20px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
        width: 400px; max-width: 92vw; overflow: hidden;
        animation: od-modal-scale-in 250ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
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
`;

export interface DuplicateInstallResult {
    action: 'overwrite' | 'install-new' | 'cancel';
    customName?: string;
}

/**
 * 重复安装技能时的选择弹窗。
 *
 * 提供三个选项：
 *   - 覆盖安装：直接覆盖已存在的技能
 *   - 以新名称安装：用户输入自定义名称（默认 skillname-1），以新名称安装
 *   - 取消：放弃安装
 */
export function showDuplicateInstallModal(options: {
    skillName: string;
    mountTarget?: HTMLElement;
}): Promise<DuplicateInstallResult> {
    return new Promise((resolve) => {
        const { skillName, mountTarget = document.body } = options;
        const defaultCustomName = `${skillName}-1`;
        const pastel = getSkillPastel(skillName);
        const initial = getSkillInitial(skillName);

        const overlay = document.createElement('div');
        overlay.className = 'od-confirm-modal-overlay';
        overlay.innerHTML = `
<style>
${CONFIRM_MODAL_STYLES}
    .od-confirm-modal-message { margin-bottom: 16px; }
    .od-duplicate-input-section {
        margin-bottom: 22px; max-height: 0; overflow: hidden; opacity: 0;
        transition: max-height 0.25s ease, opacity 0.2s ease, margin-bottom 0.25s ease;
    }
    .od-duplicate-input-section.od-visible { max-height: 80px; opacity: 1; }
    .od-duplicate-input-label { font-size: 13px; color: #6B6B6B; margin-bottom: 8px; }
    .od-duplicate-input {
        width: 100%; padding: 10px 14px; border-radius: 10px;
        border: 1.5px solid #E5E5EA; font-size: 14px; font-family: inherit;
        outline: none; transition: border-color 0.15s; box-sizing: border-box;
    }
    .od-duplicate-input:focus { border-color: #1d1d1f; }
    .od-confirm-btn-secondary {
        background: #F0F5FF; color: #2563EB; border: 1.5px solid #BFDBFE;
    }
    .od-confirm-btn-secondary:hover { background: #DBEAFE; }
</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-body">
        <div class="od-confirm-modal-header">
            <div class="od-confirm-modal-icon" style="background:${pastel.bg};color:${pastel.text};font-size:18px;font-weight:700">${escapeHtml(initial)}</div>
            <div class="od-confirm-modal-title">技能已存在</div>
        </div>
        <div class="od-confirm-modal-message">技能「<b>${escapeHtml(skillName)}</b>」已安装，请选择处理方式。</div>
        <div class="od-duplicate-input-section" id="od-dup-input-section">
            <div class="od-duplicate-input-label">新技能名称：</div>
            <input type="text" class="od-duplicate-input" id="od-dup-input" value="${escapeHtml(defaultCustomName)}" />
        </div>
        <div class="od-confirm-modal-footer">
            <button class="od-confirm-btn od-confirm-btn-cancel" data-action="cancel">取消</button>
            <button class="od-confirm-btn od-confirm-btn-secondary" data-action="install-new">以新名称安装</button>
            <button class="od-confirm-btn od-confirm-btn-danger" data-action="overwrite">覆盖安装</button>
        </div>
    </div>
</div>`;

        let resolved = false;
        const close = (result: DuplicateInstallResult) => {
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
                close({ action: 'cancel' });
            }
        };
        document.addEventListener('keydown', escHandler);

        overlay.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).classList.contains('od-confirm-modal-overlay')) {
                close({ action: 'cancel' });
            }
        });

        const inputSection = overlay.querySelector('#od-dup-input-section') as HTMLElement;
        const input = overlay.querySelector('#od-dup-input') as HTMLInputElement;

        overlay.querySelector('[data-action="install-new"]')!.addEventListener('click', () => {
            if (inputSection.classList.contains('od-visible')) {
                const name = input.value.trim();
                if (!name) {
                    input.focus();
                    return;
                }
                close({ action: 'install-new', customName: name });
            } else {
                inputSection.classList.add('od-visible');
                setTimeout(() => input.focus(), 100);
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const name = input.value.trim();
                if (name) {
                    close({ action: 'install-new', customName: name });
                }
            }
        });

        overlay.querySelector('[data-action="overwrite"]')!.addEventListener('click', () => {
            close({ action: 'overwrite' });
        });

        overlay.querySelector('[data-action="cancel"]')!.addEventListener('click', () => {
            close({ action: 'cancel' });
        });

        mountTarget.appendChild(overlay);
    });
}
