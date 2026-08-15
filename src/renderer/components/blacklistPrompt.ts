/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * 恶意技能黑名单弹窗组件
 * 在会话结束时自动弹出，展示疑似恶意技能列表，让用户选择是否加入黑名单。
 */

import { MODAL_CSS, MODAL_ANIM_DURATION_OUT, detectDarkMode, bindOverlayDismiss } from './confirmModal.ts';

interface BlacklistSkillItem {
    bundleName: string;
    skillName: string;
    confidence: 'certain' | 'high' | 'medium' | 'low';
    evidence: string;
    reason: string;
    /** 该 skill 关联的拦截记录列表（用于展示可折叠详情） */
    interceptions?: Array<{ toolName: string; reason: string; riskLevel: string }>;
}

interface BlacklistPromptData {
    taskId: string;
    skills: BlacklistSkillItem[];
}

const confidenceLabels: Record<string, string> = {
    certain: '确定性',
    high: '高置信',
    medium: '中置信',
    low: '低置信',
    contextual: '上下文关联'
};

const confidenceColors: Record<string, string> = {
    certain: '#DC2626',
    high: '#DC2626',
    medium: '#E8935A',
    low: '#9CA3AF',
    contextual: '#9CA3AF'
};

const BLACKLIST_EXTRA_CSS = `
.od-confirm-modal-card { width: 480px; }
.od-bl-skill-item {
    border-radius: 8px; padding: 12px; margin-bottom: 8px;
    border: 1px solid var(--mc-line); background: var(--mc-bg);
}
.od-bl-skill-label {
    display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
}
.od-bl-skill-label input[type="checkbox"] {
    margin-top: 3px; width: 14px; height: 14px; accent-color: var(--mc-red);
}
.od-bl-skill-info { flex: 1; min-width: 0; }
.od-bl-skill-name {
    font-weight: 600; font-size: 13px; color: var(--mc-ink); margin-bottom: 4px;
}
.od-bl-confidence-badge {
    display: inline-block; font-size: 10px; font-weight: 500;
    color: #fff; border-radius: 5px; padding: 1px 7px; margin-left: 6px;
}
.od-bl-evidence {
    font-size: 12px; color: var(--mc-ink3); line-height: 1.4;
}
.od-bl-detail-toggle {
    cursor: pointer; font-size: 12px; color: var(--mc-red);
    user-select: none; margin-top: 8px; padding-top: 8px;
    border-top: 1px solid var(--mc-line-soft);
}
.od-bl-detail-content { margin-top: 6px; display: none; }
.od-bl-detail-content.show { display: block; }
.od-bl-intercept-item {
    font-size: 11px; color: var(--mc-ink3); padding: 4px 0;
    border-bottom: 1px solid var(--mc-line-soft); overflow-wrap: break-word; word-break: break-all;
}
.od-bl-intercept-item:last-child { border-bottom: none; }
.od-bl-intercept-item .tool { font-weight: 500; color: var(--mc-ink2); }
.od-bl-intercept-item .sep { color: var(--mc-ink4); margin: 0 4px; }
.od-bl-risk-badge {
    display: inline-block; font-size: 10px; color: #fff;
    background: var(--mc-red); border-radius: 4px; padding: 0 4px; margin-left: 4px;
}
.od-bl-list { margin-bottom: 16px; max-height: 50vh; overflow-y: auto; overflow-x: hidden; }
`;

const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export function showBlacklistPrompt(data: BlacklistPromptData): void {
    const { taskId, skills } = data;
    if (!skills || skills.length === 0) return;

    const body = document.body;
    const overlay = document.createElement('div');
    overlay.className = 'od-confirm-modal-overlay';
    if (detectDarkMode()) {
        overlay.classList.add('od-modal-dark');
    }

    const listHtml = skills
        .map((skill, index) => {
            const confidenceLabel = confidenceLabels[skill.confidence] || skill.confidence;
            const color = confidenceColors[skill.confidence] || '#9CA3AF';
            const intercepts = skill.interceptions || [];
            const detailId = `od-bl-detail-${index}`;
            const arrowId = `od-bl-arrow-${index}`;
            const detailsHtml =
                intercepts.length > 0
                    ? `
            <div class="od-bl-detail-toggle" data-detail="${detailId}" data-arrow="${arrowId}">
                <span id="${arrowId}">▸</span> 查看 ${intercepts.length} 条拦截详情
            </div>
            <div class="od-bl-detail-content" id="${detailId}">
                ${intercepts
                    .map(
                        (ic, i) => `
                    <div class="od-bl-intercept-item">
                        <span class="tool">${escapeHtml(ic.toolName)}</span>
                        <span class="sep">-</span>
                        <span>${escapeHtml(ic.reason)}</span>
                        ${ic.riskLevel ? `<span class="od-bl-risk-badge">${escapeHtml(ic.riskLevel)}</span>` : ''}
                    </div>
                `
                    )
                    .join('')}
            </div>
        `
                    : '';
            return `
            <div class="od-bl-skill-item">
                <label class="od-bl-skill-label">
                    <input type="checkbox" data-index="${index}" checked>
                    <div class="od-bl-skill-info">
                        <div class="od-bl-skill-name">
                            ${escapeHtml(skill.bundleName)}/${escapeHtml(skill.skillName)}
                            <span class="od-bl-confidence-badge" style="background:${color}">${escapeHtml(confidenceLabel)}</span>
                        </div>
                        <div class="od-bl-evidence">${escapeHtml(skill.evidence)}</div>
                    </div>
                </label>
                ${detailsHtml}
            </div>
        `;
        })
        .join('\n');

    overlay.innerHTML = `
<style>${MODAL_CSS}${BLACKLIST_EXTRA_CSS}</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-banner danger">
        <div class="od-confirm-modal-icon"><i class="fas fa-shield-halved" style="color:#fff"></i></div>
        <div class="od-confirm-modal-banner-text">
            <div class="od-confirm-modal-title">检测到疑似恶意技能</div>
        </div>
        <button class="od-confirm-modal-close" data-action="cancel" aria-label="关闭">${CLOSE_SVG}</button>
    </div>
    <div class="od-confirm-modal-body">
        本次会话中安全网关拦截了危险操作。经分析，以下技能疑似驱动了这些操作。
        请选择要加入黑名单的技能（加入后将无法再加载）：
        <div class="od-bl-list">${listHtml}</div>
    </div>
    <div class="od-confirm-modal-footer">
        <button class="od-confirm-btn od-confirm-btn-cancel" data-action="cancel">忽略</button>
        <button class="od-confirm-btn od-confirm-btn-danger" data-action="confirm">加入黑名单</button>
    </div>
</div>`;

    let resolved = false;
    const close = () => {
        if (resolved) return;
        resolved = true;
        overlay.classList.add('od-modal-leaving');
        setTimeout(() => {
            overlay.remove();
        }, MODAL_ANIM_DURATION_OUT);
        document.removeEventListener('keydown', escHandler);
    };

    const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    };
    document.addEventListener('keydown', escHandler);

    bindOverlayDismiss(overlay, close);

    // 折叠详情切换
    overlay.querySelectorAll('.od-bl-detail-toggle').forEach((toggle) => {
        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            const detailId = (toggle as HTMLElement).dataset.detail!;
            const arrowId = (toggle as HTMLElement).dataset.arrow!;
            const detail = overlay.querySelector(`#${detailId}`);
            const arrow = overlay.querySelector(`#${arrowId}`);
            if (detail?.classList.contains('show')) {
                detail.classList.remove('show');
                if (arrow) arrow.textContent = '▸';
            } else {
                detail?.classList.add('show');
                if (arrow) arrow.textContent = '▾';
            }
        });
    });

    overlay.querySelector('[data-action="confirm"]')!.addEventListener('click', () => {
        const checkboxes = overlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        const itemsToBlock: Array<{ bundleName: string; skillName: string; reason: string; evidence: string }> = [];
        checkboxes.forEach((cb, index) => {
            if (cb.checked && skills[index]) {
                const s = skills[index];
                itemsToBlock.push({
                    bundleName: s.bundleName,
                    skillName: s.skillName,
                    reason: s.reason,
                    evidence: s.evidence
                });
            }
        });
        if (itemsToBlock.length > 0) {
            (window as any).skillBlacklistAPI?.addToBlacklist(itemsToBlock);
        }
        (window as any).skillBlacklistAPI?.dismissBlacklist(taskId);
        close();
    });

    overlay.querySelector('[data-action="cancel"]')!.addEventListener('click', () => {
        (window as any).skillBlacklistAPI?.dismissBlacklist(taskId);
        close();
    });

    body.appendChild(overlay);
}

function escapeHtml(str: string): string {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
