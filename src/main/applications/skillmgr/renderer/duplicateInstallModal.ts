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
import { MODAL_CSS, MODAL_ANIM_DURATION_OUT, detectDarkMode } from '../../../../renderer/components/confirmModal.ts';

export interface DuplicateInstallResult {
    action: 'overwrite' | 'install-new' | 'cancel';
    customName?: string;
}

const DUPLICATE_EXTRA_CSS = `
.od-duplicate-input-section {
    max-height: 0; overflow: hidden; opacity: 0;
    transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.25s ease;
}
.od-duplicate-input-section.od-visible { max-height: 80px; opacity: 1; margin-top: 12px; }
.od-duplicate-input-label { font-size: 11.5px; color: var(--mc-ink2); font-weight: 500; margin-bottom: 5px; }
.od-duplicate-input {
    width: 100%; padding: 7px 10px; border-radius: 8px;
    border: 1px solid var(--mc-line); font-size: 12px; font-family: inherit;
    outline: none; transition: border-color 0.15s; box-sizing: border-box;
    background: var(--mc-bg); color: var(--mc-ink2);
}
.od-duplicate-input:focus { border-color: var(--mc-accent); }
.od-duplicate-input::placeholder { color: var(--mc-ink4); }
`;

const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

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
        if (detectDarkMode(mountTarget)) {
            overlay.classList.add('od-modal-dark');
        }
        overlay.innerHTML = `
<style>${MODAL_CSS}${DUPLICATE_EXTRA_CSS}</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-banner warn">
        <div class="od-confirm-modal-icon" style="background:${pastel.bg};color:${pastel.text};font-size:17px;font-weight:700">${escapeHtml(initial)}</div>
        <div class="od-confirm-modal-banner-text">
            <div class="od-confirm-modal-title">技能已存在</div>
        </div>
        <button class="od-confirm-modal-close" data-action="cancel" aria-label="关闭">${CLOSE_SVG}</button>
    </div>
    <div class="od-confirm-modal-body">
        技能「<b>${escapeHtml(skillName)}</b>」已安装，请选择处理方式。
        <div class="od-duplicate-input-section" id="od-dup-input-section">
            <div class="od-duplicate-input-label">新技能名称</div>
            <input type="text" class="od-duplicate-input" id="od-dup-input" value="${escapeHtml(defaultCustomName)}" />
        </div>
    </div>
    <div class="od-confirm-modal-footer">
        <button class="od-confirm-btn od-confirm-btn-cancel" data-action="cancel">取消</button>
        <button class="od-confirm-btn od-confirm-btn-cancel" data-action="install-new">以新名称安装</button>
        <button class="od-confirm-btn od-confirm-btn-danger" data-action="overwrite">覆盖安装</button>
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
            }, MODAL_ANIM_DURATION_OUT);
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
            if (e.key === 'Enter' && !e.isComposing) {
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

        overlay.querySelectorAll('[data-action="cancel"]').forEach((btn) => {
            btn.addEventListener('click', () => close({ action: 'cancel' }));
        });

        mountTarget.appendChild(overlay);
    });
}
