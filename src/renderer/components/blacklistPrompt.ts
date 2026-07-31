/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * 恶意技能黑名单弹窗组件
 * 在会话结束时自动弹出，展示疑似恶意技能列表，让用户选择是否加入黑名单。
 */

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

export function showBlacklistPrompt(data: BlacklistPromptData): void {
    const { taskId, skills } = data;
    if (!skills || skills.length === 0) return;

    const body = document.body;
    const overlay = document.createElement('div');
    overlay.className = 'od-confirm-modal-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '99999';
    overlay.style.background = 'rgba(0,0,0,0.3)';
    overlay.style.backdropFilter = 'blur(6px)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

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
            <div style="margin-top:8px;border-top:1px solid #FEE2E2;padding-top:8px;">
                <div onclick="(function(){var d=document.getElementById('${detailId}'),a=document.getElementById('${arrowId}');if(d.style.display==='none'){d.style.display='block';a.textContent='▾'}else{d.style.display='none';a.textContent='▸'}})()" style="cursor:pointer;font-size: var(--fs-md);color:#DC2626;user-select:none;">
                    <span id="${arrowId}">▸</span> 查看 ${intercepts.length} 条拦截详情
                </div>
                <div id="${detailId}" style="display:none;margin-top:6px;">
                    ${intercepts
                        .map(
                            (ic, i) => `
                        <div style="font-size: var(--fs-sm);color:#6B7280;padding:4px 0;border-bottom:${i < intercepts.length - 1 ? '1px solid #F3F4F6' : 'none'};overflow-wrap:break-word;word-break:break-all;">
                            <span style="font-weight:500;">${escapeHtml(ic.toolName)}</span>
                            <span style="color:#9CA3AF;margin:0 4px;">-</span>
                            <span>${escapeHtml(ic.reason)}</span>
                            ${ic.riskLevel ? `<span style="display:inline-block;font-size: var(--fs-xs);color:#fff;background:#DC2626;border-radius:4px;padding:0 4px;margin-left:4px;">${escapeHtml(ic.riskLevel)}</span>` : ''}
                        </div>
                    `
                        )
                        .join('')}
                </div>
            </div>
        `
                    : '';
            return `
            <div style="background:#FEF2F2;border-radius:10px;padding:12px;margin-bottom:8px;border:1px solid #FEE2E2;">
                <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
                    <input type="checkbox" data-index="${index}" checked style="margin-top:3px;width:16px;height:16px;accent-color:#DC2626;">
                    <div style="flex:1;">
                        <div style="font-weight:600;font-size: var(--fs-lg);color:#1d1d1f;margin-bottom:4px;">
                            ${escapeHtml(skill.bundleName)}/${escapeHtml(skill.skillName)}
                            <span style="display:inline-block;font-size: var(--fs-sm);font-weight:500;color:#fff;background:${color};border-radius:6px;padding:1px 6px;margin-left:6px;">${escapeHtml(confidenceLabel)}</span>
                        </div>
                        <div style="font-size: var(--fs-base);color:#6B7280;line-height:1.4;">
                            ${escapeHtml(skill.evidence)}
                        </div>
                    </div>
                </label>
                ${detailsHtml}
            </div>
        `;
        })
        .join('\n');

    const card = document.createElement('div');
    card.style.cssText = `
        background:#fff;border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,0.18),0 0 1px rgba(0,0,0,0.1);
        width:480px;max-width:92vw;overflow:hidden;
    `;
    card.innerHTML = `
        <div style="padding:28px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
                <div style="width:42px;height:42px;border-radius:12px;background:#FEF2F2;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <i class="fas fa-shield-halved" style="color:#DC2626;font-size:18px;"></i>
                </div>
                <div style="font-size: var(--fs-xl);font-weight:700;color:#1d1d1f;line-height:1.3;">检测到疑似恶意技能</div>
            </div>
            <div style="font-size: var(--fs-lg);color:#3C3C43;line-height:1.6;margin-bottom:16px;">
                本次会话中安全网关拦截了危险操作。经分析，以下技能疑似驱动了这些操作。
                请选择要加入黑名单的技能（加入后将无法再加载）：
            </div>
            <div style="margin-bottom:20px;max-height:50vh;overflow-y:auto;overflow-x:hidden;">${listHtml}</div>
            <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:16px;border-top:1px solid #F0F0F0;">
                <button class="od-confirm-btn od-confirm-btn-cancel" data-action="cancel" style="padding:10px 24px;border-radius:12px;border:1.5px solid #E5E5EA;background:#fff;color:#1d1d1f;font-size: var(--fs-lg);font-weight:600;cursor:pointer;">忽略</button>
                <button class="od-confirm-btn od-confirm-btn-danger" data-action="confirm" style="padding:10px 24px;border-radius:12px;border:none;background:#DC2626;color:#fff;font-size: var(--fs-lg);font-weight:600;cursor:pointer;">加入黑名单</button>
            </div>
        </div>
    `;

    let resolved = false;
    const close = () => {
        if (resolved) return;
        resolved = true;
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 180ms ease-in';
        setTimeout(() => {
            overlay.remove();
        }, 180);
        document.removeEventListener('keydown', escHandler);
    };

    const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    };
    document.addEventListener('keydown', escHandler);

    overlay.addEventListener('click', (e) => {
        if ((e.target as HTMLElement) === overlay) {
            close();
        }
    });

    card.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        // 收集所有勾选的技能
        const checkboxes = card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
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

    card.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
        (window as any).skillBlacklistAPI?.dismissBlacklist(taskId);
        close();
    });

    overlay.appendChild(card);
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
