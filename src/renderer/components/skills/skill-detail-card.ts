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

import { escapeHtml } from '../../../common/utils/escape.js';

const PASTEL_COLORS = [
    { bg: '#EBF3FE', text: '#5B8DEF' },
    { bg: '#FEF1E6', text: '#E8935A' },
    { bg: '#E7F6EA', text: '#4CAF6E' },
    { bg: '#F2E8FD', text: '#9B6DD7' },
    { bg: '#FDE9E9', text: '#E06060' },
    { bg: '#E5F7F4', text: '#3DB49E' },
    { bg: '#FFF7E0', text: '#D4A028' },
    { bg: '#FBE5EE', text: '#D45D8A' }
];

export function getSkillInitial(name: string): string {
    if (!name) return '⚡';
    const first = name.charAt(0).toUpperCase();
    return /[A-Z0-9\u4e00-\u9fff]/.test(first) ? first : '⚡';
}

export function getSkillPastel(name: string): { bg: string; text: string } {
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) {
        hash = ((hash << 5) - hash + name.charCodeAt(index)) | 0;
    }
    return PASTEL_COLORS[Math.abs(hash) % PASTEL_COLORS.length];
}

export interface SkillDetailMetaItem {
    label: string;
    value: string;
}

export interface SkillDetailAction {
    id: string;
    label: string;
    variant?: 'default' | 'primary' | 'danger';
    data?: string;
}

export interface SkillDetailCardModel {
    id: string;
    name: string;
    closeLabel: string;
    description?: string;
    descriptionLabel?: string;
    bodyHtml?: string;
    bodyLabel?: string;
    metadata?: SkillDetailMetaItem[];
    metadataLabel?: string;
    headerExtraHtml?: string;
    extraSectionsHtml?: string;
    actions: SkillDetailAction[];
}

const STYLE = `
:host { position:relative; z-index:10000; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','PingFang SC','Microsoft YaHei','Helvetica Neue',sans-serif; color:#1d1d1f; }
* { box-sizing:border-box; }
button { font:inherit; }
.detail-overlay { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(0,0,0,.18); backdrop-filter:blur(8px); animation:fade-in .15s ease; }
.detail-dialog { width:680px; max-width:94%; max-height:80vh; overflow:hidden; display:flex; flex-direction:column; border:1px solid rgba(0,0,0,.05); border-radius:18px; background:#fff; box-shadow:0 24px 80px -16px rgba(0,0,0,.22); animation:dialog-in .2s ease-out; }
.detail-header { display:flex; align-items:center; gap:14px; padding:20px 24px 16px; border-bottom:1px solid #f0f0f0; }
.detail-icon { width:48px; height:48px; display:flex; align-items:center; justify-content:center; flex:none; border-radius:13px; font-size:22px; font-weight:700; }
.detail-header-info { min-width:0; flex:1; }.detail-name { overflow:hidden; margin-bottom:2px; color:#1d1d1f; font-size:17px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }.detail-id { overflow:hidden; color:#999; font-size: var(--fs-md); text-overflow:ellipsis; white-space:nowrap; }
.detail-close { width:28px; height:28px; display:flex; align-items:center; justify-content:center; flex:none; border:0; border-radius:50%; background:#f5f5f5; color:#999; font-size: var(--fs-xl); cursor:pointer; transition:background .12s,color .12s; }.detail-close:hover { background:#ebebeb; color:#555; }
.detail-body { flex:1; overflow-y:auto; padding:20px 24px 24px; }.detail-section { margin-bottom:16px; }.detail-section:last-child { margin-bottom:0; }.detail-section-label { margin-bottom:6px; color:#999; font-size: var(--fs-sm); font-weight:600; letter-spacing:.04em; text-transform:uppercase; }.detail-desc { color:#1d1d1f; font-size: var(--fs-base); line-height:1.6; }
.detail-body-content { max-height:480px; overflow-y:auto; padding:16px 20px; border:1px solid #f0f0f0; border-radius:10px; background:#fff; color:#1d1d1f; }.detail-body-content.markdown-body { font-size: var(--fs-base); }
.markdown-body > :first-child { margin-top:0; }.markdown-body > :last-child { margin-bottom:0; }.markdown-body p { margin:0 0 .75em; }.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6 { margin:1em 0 .45em; line-height:1.3; }.markdown-body h1 { font-size:1.45em; }.markdown-body h2 { font-size:1.3em; }.markdown-body h3 { font-size:1.15em; }.markdown-body ul,.markdown-body ol { padding-left:1.6em; }.markdown-body blockquote { margin:.8em 0; padding:.15em .9em; border-left:3px solid #6ba3ef; color:#777; }.markdown-body code { padding:.12em .35em; border-radius:4px; background:#f5f5f5; font-family:'SF Mono','Cascadia Code',monospace; font-size:.9em; }.markdown-body pre { max-width:100%; overflow:auto; padding:12px; border:1px solid #f0f0f0; border-radius:8px; background:#f8f8f8; }.markdown-body pre code { padding:0; background:transparent; }.markdown-body table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; }.markdown-body th,.markdown-body td { padding:6px 8px; border:1px solid #e5e5e5; text-align:left; }.markdown-body a { color:#5b8def; }.markdown-body img { max-width:100%; }
.detail-meta-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }.detail-meta-item { min-width:0; padding:8px 12px; border-radius:8px; background:#fafafa; color:#555; font-size: var(--fs-md); }.meta-label { margin-bottom:2px; color:#999; font-size: var(--fs-xs); letter-spacing:.03em; text-transform:uppercase; }.meta-value { overflow-wrap:anywhere; font-weight:500; }
.detail-resources { display:flex; flex-wrap:wrap; gap:6px; }.detail-resource-tag { padding:4px 10px; border-radius:6px; background:#f5f5f5; color:#555; font-size: var(--fs-sm); }
.detail-footer { display:flex; justify-content:flex-end; gap:8px; padding:12px 24px; border-top:1px solid #f0f0f0; background:#fff; }.detail-action { display:inline-flex; align-items:center; gap:6px; padding:7px 16px; border:1px solid rgba(0,0,0,.08); border-radius:8px; background:#fff; color:#333; font-size: var(--fs-md); font-weight:500; cursor:pointer; transition:background .15s,transform .15s; }.detail-action:hover { background:#f8f8f8; }.detail-action:active { transform:scale(.97); }.detail-action.primary { border-color:#6ba3ef; background:#6ba3ef; color:#fff; }.detail-action.primary:hover { background:#7db0f3; }.detail-action.danger { border-color:rgba(224,96,96,.2); color:#e06060; }.detail-action.danger:hover { background:#fff5f5; }
.tag-pill { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:12px; font-size: var(--fs-sm); font-weight:500; }.tag-star { background:#fff7e0; color:#d4a028; }.tag-download { background:#ebf3fe; color:#5b8def; }
.detail-tools-list { display:flex; flex-direction:column; gap:8px; }.detail-tool-item { padding:12px 14px; border:1px solid #f0f0f0; border-radius:10px; background:#fafafa; }.detail-tool-header { margin-bottom:8px; }.detail-tool-name { margin-bottom:3px; color:#1d1d1f; font-size: var(--fs-base); font-weight:600; }.detail-tool-desc { color:#777; font-size: var(--fs-md); line-height:1.5; }.detail-tool-no-params { margin-top:4px; color:#bbb; font-size: var(--fs-sm); }.detail-tool-params-toggle { display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border:1px solid rgba(0,0,0,.06); border-radius:6px; background:#fff; color:#555; font:inherit; font-size: var(--fs-sm); font-weight:500; cursor:pointer; }.detail-tool-params-toggle:hover { background:#f0f0f0; color:#333; }.toggle-icon { display:inline-block; font-size: var(--icon-xs); transition:transform .15s; }.detail-tool-params-toggle.expanded .toggle-icon { transform:rotate(90deg); }.detail-tool-params { margin-top:10px; overflow:hidden; border:1px solid #f0f0f0; border-radius:8px; }.detail-tool-params-header,.detail-tool-param { display:grid; grid-template-columns:1fr .7fr .5fr 1.5fr; gap:8px; padding:6px 12px; }.detail-tool-params-header { background:#f5f5f5; color:#999; font-size: var(--fs-xs); font-weight:600; letter-spacing:.03em; text-transform:uppercase; }.detail-tool-param { border-top:1px solid #f5f5f5; font-size: var(--fs-sm); }.param-name { color:#333; font-family:'SF Mono','Cascadia Code',monospace; font-weight:500; }
.detail-body::-webkit-scrollbar,.detail-body-content::-webkit-scrollbar { width:4px; height:4px; }.detail-body::-webkit-scrollbar-track,.detail-body-content::-webkit-scrollbar-track { background:transparent; }.detail-body::-webkit-scrollbar-thumb,.detail-body-content::-webkit-scrollbar-thumb { border-radius:2px; background:#d1d5db; }
:host([data-theme='dark']),:host-context([data-theme='dark']) { color:#ccc; color-scheme:dark; }
:host([data-theme='dark']) .detail-overlay,:host-context([data-theme='dark']) .detail-overlay { background:rgba(0,0,0,.55); }
:host([data-theme='dark']) .detail-dialog,:host-context([data-theme='dark']) .detail-dialog { border-color:rgba(255,255,255,.2); background:#252526; color:#ccc; }
:host([data-theme='dark']) .detail-header,:host-context([data-theme='dark']) .detail-header { border-bottom-color:rgba(255,255,255,.12); }
:host([data-theme='dark']) .detail-name,:host-context([data-theme='dark']) .detail-name { color:#e4e4e4; }
:host([data-theme='dark']) .detail-id,:host-context([data-theme='dark']) .detail-id { color:#ababab; }
:host([data-theme='dark']) .detail-close,:host-context([data-theme='dark']) .detail-close { background:#3f3f46; color:#ccc; }
:host([data-theme='dark']) .detail-close:hover,:host-context([data-theme='dark']) .detail-close:hover { background:#4a4a4d; color:#fff; }
:host([data-theme='dark']) .detail-section-label,:host-context([data-theme='dark']) .detail-section-label { color:#9d9d9d; }
:host([data-theme='dark']) .detail-desc,:host-context([data-theme='dark']) .detail-desc { color:#e4e4e4; }
:host([data-theme='dark']) .detail-body-content,:host-context([data-theme='dark']) .detail-body-content { border-color:rgba(255,255,255,.12); background:#333; color:#e4e4e4; }
:host([data-theme='dark']) .detail-meta-item,:host-context([data-theme='dark']) .detail-meta-item { background:#333; color:#ccc; }
:host([data-theme='dark']) .meta-label,:host-context([data-theme='dark']) .meta-label { color:#9d9d9d; }
:host([data-theme='dark']) .meta-value,:host-context([data-theme='dark']) .meta-value { color:#e4e4e4; }
:host([data-theme='dark']) .detail-resource-tag,:host-context([data-theme='dark']) .detail-resource-tag { background:#3f3f46; color:#ccc; }
:host([data-theme='dark']) .detail-footer,:host-context([data-theme='dark']) .detail-footer { border-top-color:rgba(255,255,255,.12); background:#252526; }
:host([data-theme='dark']) .detail-action,:host-context([data-theme='dark']) .detail-action { border-color:rgba(255,255,255,.2); background:#333; color:#ccc; }
:host([data-theme='dark']) .detail-action:hover,:host-context([data-theme='dark']) .detail-action:hover { background:#3f3f46; }
:host([data-theme='dark']) .detail-action.primary,:host-context([data-theme='dark']) .detail-action.primary { border-color:#3b82f6; background:#3b82f6; color:#fff; }
:host([data-theme='dark']) .detail-action.danger,:host-context([data-theme='dark']) .detail-action.danger { border-color:rgba(224,96,96,.3); color:#f08a8a; }
:host([data-theme='dark']) .detail-action.danger:hover,:host-context([data-theme='dark']) .detail-action.danger:hover { background:rgba(224,96,96,.12); }
:host([data-theme='dark']) .detail-tool-item,:host-context([data-theme='dark']) .detail-tool-item { border-color:rgba(255,255,255,.12); background:#333; }:host([data-theme='dark']) .detail-tool-name,:host-context([data-theme='dark']) .detail-tool-name { color:inherit; }
:host([data-theme='dark']) .detail-tool-params-toggle,:host-context([data-theme='dark']) .detail-tool-params-toggle { border-color:rgba(255,255,255,.16); background:#3f3f46; color:#ccc; }
:host([data-theme='dark']) .detail-tool-params,:host-context([data-theme='dark']) .detail-tool-params { border-color:rgba(255,255,255,.12); }:host([data-theme='dark']) .detail-tool-params-header,:host-context([data-theme='dark']) .detail-tool-params-header { background:#3f3f46; }:host([data-theme='dark']) .detail-tool-param,:host-context([data-theme='dark']) .detail-tool-param { border-top-color:rgba(255,255,255,.1); }:host([data-theme='dark']) .param-name,:host-context([data-theme='dark']) .param-name { color:inherit; }
:host([data-theme='dark']) .markdown-body blockquote,:host-context([data-theme='dark']) .markdown-body blockquote { color:#ababab; }:host([data-theme='dark']) .markdown-body code,:host-context([data-theme='dark']) .markdown-body code { background:#3f3f46; }:host([data-theme='dark']) .markdown-body pre,:host-context([data-theme='dark']) .markdown-body pre { border-color:rgba(255,255,255,.12); background:#292929; }:host([data-theme='dark']) .markdown-body th,:host([data-theme='dark']) .markdown-body td,:host-context([data-theme='dark']) .markdown-body th,:host-context([data-theme='dark']) .markdown-body td { border-color:rgba(255,255,255,.16); }:host([data-theme='dark']) .markdown-body a,:host-context([data-theme='dark']) .markdown-body a { color:#93c5fd; }
:host([data-theme='dark']) .detail-body::-webkit-scrollbar-thumb,:host([data-theme='dark']) .detail-body-content::-webkit-scrollbar-thumb,:host-context([data-theme='dark']) .detail-body::-webkit-scrollbar-thumb,:host-context([data-theme='dark']) .detail-body-content::-webkit-scrollbar-thumb { background:rgba(255,255,255,.18); }
@media(max-width:620px){.detail-overlay{padding:10px}.detail-dialog{max-width:100%;max-height:92vh}.detail-header{padding:16px}.detail-body{padding:16px}.detail-footer{padding:12px 16px}.detail-meta-grid{grid-template-columns:1fr}.detail-tool-params-header,.detail-tool-param{grid-template-columns:1fr .65fr .5fr}.detail-tool-params-header span:last-child,.detail-tool-param span:last-child{display:none}}
@keyframes fade-in { from { opacity:0; } to { opacity:1; } } @keyframes dialog-in { from { opacity:0; transform:scale(.95) translateY(8px); } to { opacity:1; transform:scale(1) translateY(0); } }
`;

export class SkillDetailCard extends HTMLElement {
    private _model?: SkillDetailCardModel;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    set model(value: SkillDetailCardModel) {
        this._model = value;
        this.render();
    }

    get model(): SkillDetailCardModel | undefined {
        return this._model;
    }

    connectedCallback(): void {
        this.render();
    }

    private emitAction(id: string, data?: string): void {
        this.dispatchEvent(
            new CustomEvent('skill-detail-action', {
                bubbles: true,
                composed: true,
                detail: { id, data }
            })
        );
    }

    private render(): void {
        if (!this.shadowRoot || !this._model) return;
        const model = this._model;
        const color = getSkillPastel(model.name || model.id);
        const metadata = model.metadata?.length
            ? `<section class="detail-section"><div class="detail-section-label">${escapeHtml(model.metadataLabel ?? '')}</div><div class="detail-meta-grid">${model.metadata.map((item) => `<div class="detail-meta-item"><div class="meta-label">${escapeHtml(item.label)}</div><div class="meta-value">${escapeHtml(item.value)}</div></div>`).join('')}</div></section>`
            : '';
        const actions = model.actions
            .map(
                (action) =>
                    `<button type="button" class="detail-action ${action.variant === 'default' || !action.variant ? '' : action.variant}" data-detail-action="${escapeHtml(action.id)}" data-detail-action-value="${escapeHtml(action.data ?? '')}">${escapeHtml(action.label)}</button>`
            )
            .join('');
        this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="detail-overlay"><div class="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="shared-skill-detail-title"><div class="detail-header"><div class="detail-icon" style="background:${color.bg};color:${color.text}">${escapeHtml(getSkillInitial(model.name || model.id))}</div><div class="detail-header-info"><div class="detail-name" id="shared-skill-detail-title">${escapeHtml(model.name || model.id)}</div><div class="detail-id">${escapeHtml(model.id)}</div>${model.headerExtraHtml ?? ''}</div><button type="button" class="detail-close" aria-label="${escapeHtml(model.closeLabel)}">×</button></div><div class="detail-body">${model.description ? `<section class="detail-section"><div class="detail-section-label">${escapeHtml(model.descriptionLabel ?? '')}</div><div class="detail-desc">${escapeHtml(model.description)}</div></section>` : ''}${model.bodyHtml ? `<section class="detail-section"><div class="detail-section-label">${escapeHtml(model.bodyLabel ?? '')}</div><div class="detail-body-content markdown-body">${model.bodyHtml}</div></section>` : ''}${metadata}${model.extraSectionsHtml ?? ''}</div><div class="detail-footer">${actions}</div></div></div>`;

        this.shadowRoot.querySelector('.detail-overlay')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) this.emitAction('close');
        });
        this.shadowRoot.querySelector('.detail-close')?.addEventListener('click', () => this.emitAction('close'));
        this.shadowRoot
            .querySelectorAll<HTMLElement>('[data-detail-action]')
            .forEach((button) =>
                button.addEventListener('click', () =>
                    this.emitAction(button.dataset.detailAction!, button.dataset.detailActionValue || undefined)
                )
            );
        this.shadowRoot.querySelectorAll<HTMLElement>('.detail-tool-params-toggle').forEach((button) =>
            button.addEventListener('click', () => {
                const index = button.dataset.toolToggle;
                const parameters = this.shadowRoot?.querySelector<HTMLElement>(`[data-tool-params="${index}"]`);
                if (!parameters) return;
                const expanded = parameters.style.display === 'none';
                parameters.style.display = expanded ? 'block' : 'none';
                button.classList.toggle('expanded', expanded);
            })
        );
    }
}

if (!customElements.get('skill-detail-card')) {
    customElements.define('skill-detail-card', SkillDetailCard);
}
