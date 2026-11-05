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

import { OVERLAY_CSS } from '../../../common/overlay-styles.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import { bindOverlayDismiss } from '../confirmModal.ts';

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

/**
 * 元数据里的可点值只把 http(s) 渲染成链接。
 *
 * 详情卡是共用组件，`href` 由各个调用方给（插件主页、作者主页等），组件不该假定它们
 * 一定校验过协议：`javascript:` 之类的值在这里退化成纯文本，避免组件本身变成注入入口。
 */
function isExternalHref(href: string): boolean {
    return /^https?:\/\//i.test(href.trim());
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
    /**
     * 可选的链接地址：给值时 value 渲染成外链。
     *
     * 用 `<a target="_blank">`：主窗口的 window-open 策略会把外链交给系统浏览器打开
     * （见 main/utils/main-window-navigation.ts），不会在应用里新开窗口。
     */
    href?: string;
}

export interface SkillDetailAction {
    id: string;
    label: string;
    variant?: 'default' | 'primary' | 'danger';
    data?: string;
    /** 置灰且不可点击：用于当前上下文不允许执行的动作（如启停被清单固定的插件） */
    disabled?: boolean;
}

export interface SkillDetailCardModel {
    id: string;
    name: string;
    subtitle?: string;
    closeLabel: string;
    /** 设置后 header 左上角显示返回按钮，点击触发 skill-detail-action id='back' */
    backLabel?: string;
    /** 内容区切换动画方向：前进（进入下一级）或后退（返回上一级）；仅在弹窗已打开时生效 */
    transition?: 'forward' | 'back';
    description?: string;
    descriptionLabel?: string;
    bodyHtml?: string;
    bodyLabel?: string;
    metadata?: SkillDetailMetaItem[];
    metadataLabel?: string;
    headerExtraHtml?: string;
    extraSectionsHtml?: string;
    actions: SkillDetailAction[];
    /** 底部操作区左侧的小字说明：解释动作为何不可用等 */
    footerHint?: string;
}

const STYLE = `
${OVERLAY_CSS}
:host { position:relative; z-index:10000; font-family:var(--font-sans); color:#1d1d1f; }
* { box-sizing:border-box; }
button { font:inherit; }
button, input, select, option, optgroup, textarea { font-family:inherit; }
.detail-overlay { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; padding:20px; animation:fade-in .15s ease; }
.detail-dialog { width:680px; max-width:94%; max-height:80vh; overflow:hidden; display:flex; flex-direction:column; border:1px solid rgba(0,0,0,.05); border-radius:16px; background:#fff; box-shadow:0 24px 80px -16px rgba(0,0,0,.22); animation:dialog-in .2s ease-out; }
.detail-header { display:flex; align-items:center; gap:12px; padding:16px 24px; border-bottom:1px solid #f0f0f0; }
.detail-header.info { background:#EBF1FB; }
.detail-back { width:28px; height:28px; display:flex; align-items:center; justify-content:center; flex:none; border:0; border-radius:8px; background:rgba(0,0,0,0.06); color:#555; cursor:pointer; transition:background .12s,color .12s,transform .12s; }.detail-back:hover { background:rgba(0,0,0,0.12); color:#333; transform:translateX(-1px); }.detail-back svg { width:15px; height:15px; }.detail-back[hidden] { display:none; }
.detail-icon { width:36px; height:36px; display:flex; align-items:center; justify-content:center; flex:none; border-radius:10px; font-size:16px; font-weight:700; box-shadow:0 1px 3px rgba(0,0,0,0.1); }

.detail-header-info { min-width:0; flex:1; }.detail-name { overflow:hidden; margin-bottom:2px; color:#1d1d1f; font-size:15px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }.detail-id { overflow:hidden; color:#86868B; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.detail-close { width:26px; height:26px; display:flex; align-items:center; justify-content:center; flex:none; border:0; border-radius:7px; background:rgba(0,0,0,0.06); color:#555; cursor:pointer; transition:background .12s,color .12s; }.detail-close:hover { background:rgba(0,0,0,0.12); color:#333; }.detail-close svg { width:14px; height:14px; }
.detail-body { flex:1; overflow-y:auto; padding:20px 24px 24px; }.detail-section { margin-bottom:16px; }.detail-section:last-child { margin-bottom:0; }.detail-section-label { margin-bottom:6px; color:#999; font-size: var(--fs-sm); font-weight:600; letter-spacing:.04em; text-transform:uppercase; }.detail-desc { color:#1d1d1f; font-size: var(--fs-base); line-height:1.6; }
.detail-body.body-switch-forward { animation:body-switch-forward .22s cubic-bezier(.23,1,.32,1); }
.detail-body.body-switch-back { animation:body-switch-back .22s cubic-bezier(.23,1,.32,1); }
.detail-body-content { max-height:480px; overflow-y:auto; padding:16px 20px; border:1px solid #f0f0f0; border-radius:10px; background:#fff; color:#1d1d1f; }.detail-body-content.markdown-body { font-size: var(--fs-base); }
.markdown-body > :first-child { margin-top:0; }.markdown-body > :last-child { margin-bottom:0; }.markdown-body p { margin:0 0 .75em; }.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6 { margin:1em 0 .45em; line-height:1.3; }.markdown-body h1 { font-size:1.45em; }.markdown-body h2 { font-size:1.3em; }.markdown-body h3 { font-size:1.15em; }.markdown-body ul,.markdown-body ol { padding-left:1.6em; }.markdown-body blockquote { margin:.8em 0; padding:.15em .9em; border-left:3px solid #6ba3ef; color:#777; }.markdown-body code { padding:.12em .35em; border-radius:4px; background:#f5f5f5; font-family:'SF Mono','Cascadia Code',monospace; font-size:.9em; }.markdown-body pre { max-width:100%; overflow:auto; padding:12px; border:1px solid #f0f0f0; border-radius:8px; background:#f8f8f8; }.markdown-body pre code { padding:0; background:transparent; }.markdown-body table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; }.markdown-body th,.markdown-body td { padding:6px 8px; border:1px solid #e5e5e5; text-align:left; }.markdown-body a { color:#5b8def; }.markdown-body img { max-width:100%; }
.detail-meta-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }.detail-meta-item { min-width:0; padding:8px 12px; border-radius:8px; background:#fafafa; color:#555; font-size: var(--fs-md); }.meta-label { margin-bottom:2px; color:#999; font-size: var(--fs-xs); letter-spacing:.03em; text-transform:uppercase; }.meta-value { overflow-wrap:anywhere; font-weight:500; }
/* 可点击的元数据值（如作者主页）：交给系统浏览器打开 */
.meta-link { color:#2f6bc4; text-decoration:none; }
.meta-link:hover { text-decoration:underline; }
.detail-resources { display:flex; flex-wrap:wrap; gap:6px; }.detail-resource-tag { padding:4px 10px; border-radius:6px; background:#f5f5f5; color:#555; font-size: var(--fs-sm); }
.hook-list { display:flex; flex-wrap:wrap; gap:6px; }.hook-pill { padding:4px 10px; border-radius:6px; background:#f5f5f5; color:#555; font-family:'SF Mono','Cascadia Code',monospace; font-size: var(--fs-sm); }
.agent-list { display:flex; flex-direction:column; gap:8px; }
.agent-row { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; border:1px solid #f0f0f0; border-radius:10px; background:#fafafa; cursor:pointer; outline:none; text-align:left; font:inherit; color:inherit; transition:border-color .15s, box-shadow .15s, transform .15s; }
.agent-row:hover,.agent-row:focus-visible { border-color:rgba(91,141,239,.35); box-shadow:0 6px 20px rgba(0,0,0,.05); transform:translateY(-1px); }
.agent-avatar { display:flex; width:30px; height:30px; align-items:center; justify-content:center; flex:none; border-radius:8px; font-size:13px; font-weight:700; }
.agent-row-info { min-width:0; flex:1; }
.agent-row-name { overflow:hidden; margin-bottom:2px; color:#1d1d1f; font-size: var(--fs-base); font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
.agent-row-usage { overflow:hidden; color:#777; font-size: var(--fs-sm); line-height:1.4; text-overflow:ellipsis; white-space:nowrap; }
.agent-flag { flex:none; padding:2px 8px; color:#999; background:#f0f0f0; border-radius:10px; font-size:10px; font-weight:600; }
.agent-chevron { width:15px; height:15px; flex:none; color:#b6b9be; }
.detail-footer { display:flex; justify-content:flex-end; gap:8px; padding:12px 24px; border-top:1px solid #f0f0f0; background:#fff; }.detail-footer[hidden] { display:none; }.detail-footer-hint { margin-right:auto; align-self:center; color:#999; font-size: var(--fs-sm); line-height:1.4; }.detail-action { display:inline-flex; align-items:center; gap:6px; padding:7px 16px; border:1px solid rgba(0,0,0,.08); border-radius:8px; background:#fff; color:#333; font-size:12.5px; font-weight:600; cursor:pointer; transition:background .15s,transform .15s; }.detail-action:not(:disabled):hover { background:#f8f8f8; }.detail-action:not(:disabled):active { transform:scale(.97); }.detail-action:disabled { opacity:.45; cursor:not-allowed; }.detail-action.primary { border-color:#DF4436; background:#DF4436; color:#fff; }.detail-action.primary:not(:disabled):hover { background:#C43A2E; }.detail-action.danger { border-color:rgba(224,96,96,.2); color:#e06060; }.detail-action.danger:not(:disabled):hover { background:#fff5f5; }
.tag-pill { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:12px; font-size: var(--fs-sm); font-weight:500; }.tag-star { background:#fff7e0; color:#d4a028; }.tag-download { background:#ebf3fe; color:#5b8def; }
.detail-tools-list { display:flex; flex-direction:column; gap:8px; }.detail-tool-item { padding:12px 14px; border:1px solid #f0f0f0; border-radius:10px; background:#fafafa; }.detail-tool-header { margin-bottom:8px; }.detail-tool-name { margin-bottom:3px; color:#1d1d1f; font-size: var(--fs-base); font-weight:600; }.detail-tool-desc { color:#777; font-size: var(--fs-md); line-height:1.5; }.detail-tool-no-params { margin-top:4px; color:#bbb; font-size: var(--fs-sm); }.detail-tool-params-toggle { display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border:1px solid rgba(0,0,0,.06); border-radius:6px; background:#fff; color:#555; font:inherit; font-size: var(--fs-sm); font-weight:500; cursor:pointer; }.detail-tool-params-toggle:hover { background:#f0f0f0; color:#333; }.toggle-icon { display:inline-block; font-size: var(--icon-xs); transition:transform .15s; }.detail-tool-params-toggle.expanded .toggle-icon { transform:rotate(90deg); }.detail-tool-params { margin-top:10px; overflow:hidden; border:1px solid #f0f0f0; border-radius:8px; }.detail-tool-params-header,.detail-tool-param { display:grid; grid-template-columns:1fr .7fr .5fr 1.5fr; gap:8px; padding:6px 12px; }.detail-tool-params-header { background:#f5f5f5; color:#999; font-size: var(--fs-xs); font-weight:600; letter-spacing:.03em; text-transform:uppercase; }.detail-tool-param { border-top:1px solid #f5f5f5; font-size: var(--fs-sm); }.param-name { color:#333; font-family:'SF Mono','Cascadia Code',monospace; font-weight:500; }
.detail-body::-webkit-scrollbar,.detail-body-content::-webkit-scrollbar { width:4px; height:4px; }.detail-body::-webkit-scrollbar-track,.detail-body-content::-webkit-scrollbar-track { background:transparent; }.detail-body::-webkit-scrollbar-thumb,.detail-body-content::-webkit-scrollbar-thumb { border-radius:2px; background:#d1d5db; }
:host([data-theme='dark']),:host-context([data-theme='dark']) { color:#ccc; color-scheme:dark; }
:host([data-theme='dark']) .detail-dialog,:host-context([data-theme='dark']) .detail-dialog { border-color:rgba(255,255,255,.2); background:#2A2826; color:#ccc; }
:host([data-theme='dark']) .detail-header.info,:host-context([data-theme='dark']) .detail-header.info { background:rgba(122,162,232,0.16); }
:host([data-theme='dark']) .detail-icon,:host-context([data-theme='dark']) .detail-icon { box-shadow:0 1px 3px rgba(0,0,0,0.3); }
:host([data-theme='dark']) .detail-header,:host-context([data-theme='dark']) .detail-header { border-bottom-color:rgba(255,255,255,.12); }
:host([data-theme='dark']) .detail-name,:host-context([data-theme='dark']) .detail-name { color:#e4e4e4; }
:host([data-theme='dark']) .detail-id,:host-context([data-theme='dark']) .detail-id { color:#ababab; }
:host([data-theme='dark']) .hook-pill,:host-context([data-theme='dark']) .hook-pill { background:rgba(255,255,255,.08); color:#ccc; }
:host([data-theme='dark']) .detail-close,:host-context([data-theme='dark']) .detail-close { background:rgba(255,255,255,.08); color:#ccc; }
:host([data-theme='dark']) .detail-close:hover,:host-context([data-theme='dark']) .detail-close:hover { background:rgba(255,255,255,.15); color:#fff; }
:host([data-theme='dark']) .detail-back,:host-context([data-theme='dark']) .detail-back { background:rgba(255,255,255,.08); color:#ccc; }
:host([data-theme='dark']) .detail-back:hover,:host-context([data-theme='dark']) .detail-back:hover { background:rgba(255,255,255,.15); color:#fff; }
:host([data-theme='dark']) .detail-section-label,:host-context([data-theme='dark']) .detail-section-label { color:#9d9d9d; }
:host([data-theme='dark']) .detail-desc,:host-context([data-theme='dark']) .detail-desc { color:#e4e4e4; }
:host([data-theme='dark']) .detail-body-content,:host-context([data-theme='dark']) .detail-body-content { border-color:rgba(255,255,255,.12); background:#333; color:#e4e4e4; }
:host([data-theme='dark']) .detail-meta-item,:host-context([data-theme='dark']) .detail-meta-item { background:#333; color:#ccc; }
:host([data-theme='dark']) .meta-label,:host-context([data-theme='dark']) .meta-label { color:#9d9d9d; }
:host([data-theme='dark']) .meta-value,:host-context([data-theme='dark']) .meta-value { color:#e4e4e4; }
:host([data-theme='dark']) .meta-link,:host-context([data-theme='dark']) .meta-link { color:#8bb8f0; }
:host([data-theme='dark']) .detail-resource-tag,:host-context([data-theme='dark']) .detail-resource-tag { background:#3f3f46; color:#ccc; }
:host([data-theme='dark']) .detail-footer,:host-context([data-theme='dark']) .detail-footer { border-top-color:rgba(255,255,255,.12); background:#252526; }
:host([data-theme='dark']) .detail-footer-hint,:host-context([data-theme='dark']) .detail-footer-hint { color:#858990; }
:host([data-theme='dark']) .detail-action,:host-context([data-theme='dark']) .detail-action { border-color:rgba(255,255,255,.2); background:#333; color:#ccc; }
:host([data-theme='dark']) .detail-action:not(:disabled):hover,:host-context([data-theme='dark']) .detail-action:not(:disabled):hover { background:#3f3f46; }
:host([data-theme='dark']) .detail-action.primary,:host-context([data-theme='dark']) .detail-action.primary { border-color:#E85A5A; background:#E85A5A; color:#fff; }
:host([data-theme='dark']) .detail-action.danger,:host-context([data-theme='dark']) .detail-action.danger { border-color:rgba(224,96,96,.3); color:#f08a8a; }
:host([data-theme='dark']) .detail-action.danger:not(:disabled):hover,:host-context([data-theme='dark']) .detail-action.danger:not(:disabled):hover { background:rgba(224,96,96,.12); }
:host([data-theme='dark']) .detail-tool-item,:host-context([data-theme='dark']) .detail-tool-item { border-color:rgba(255,255,255,.12); background:#333; }:host([data-theme='dark']) .detail-tool-name,:host-context([data-theme='dark']) .detail-tool-name { color:inherit; }
:host([data-theme='dark']) .detail-tool-params-toggle,:host-context([data-theme='dark']) .detail-tool-params-toggle { border-color:rgba(255,255,255,.16); background:#3f3f46; color:#ccc; }
:host([data-theme='dark']) .detail-tool-params,:host-context([data-theme='dark']) .detail-tool-params { border-color:rgba(255,255,255,.12); }:host([data-theme='dark']) .detail-tool-params-header,:host-context([data-theme='dark']) .detail-tool-params-header { background:#3f3f46; }:host([data-theme='dark']) .detail-tool-param,:host-context([data-theme='dark']) .detail-tool-param { border-top-color:rgba(255,255,255,.1); }:host([data-theme='dark']) .param-name,:host-context([data-theme='dark']) .param-name { color:inherit; }
:host([data-theme='dark']) .markdown-body blockquote,:host-context([data-theme='dark']) .markdown-body blockquote { color:#ababab; }:host([data-theme='dark']) .markdown-body code,:host-context([data-theme='dark']) .markdown-body code { background:#3f3f46; }:host([data-theme='dark']) .markdown-body pre,:host-context([data-theme='dark']) .markdown-body pre { border-color:rgba(255,255,255,.12); background:#292929; }:host([data-theme='dark']) .markdown-body th,:host([data-theme='dark']) .markdown-body td,:host-context([data-theme='dark']) .markdown-body th,:host-context([data-theme='dark']) .markdown-body td { border-color:rgba(255,255,255,.16); }:host([data-theme='dark']) .markdown-body a,:host-context([data-theme='dark']) .markdown-body a { color:#93c5fd; }
:host([data-theme='dark']) .detail-body::-webkit-scrollbar-thumb,:host([data-theme='dark']) .detail-body-content::-webkit-scrollbar-thumb,:host-context([data-theme='dark']) .detail-body::-webkit-scrollbar-thumb,:host-context([data-theme='dark']) .detail-body-content::-webkit-scrollbar-thumb { background:rgba(255,255,255,.18); }
:host([data-theme='dark']) .agent-row,:host-context([data-theme='dark']) .agent-row { border-color:rgba(255,255,255,.12); background:#333; }
:host([data-theme='dark']) .agent-row:hover,:host-context([data-theme='dark']) .agent-row:hover,:host([data-theme='dark']) .agent-row:focus-visible,:host-context([data-theme='dark']) .agent-row:focus-visible { border-color:rgba(91,141,239,.4); }
:host([data-theme='dark']) .agent-row-name,:host-context([data-theme='dark']) .agent-row-name { color:#e4e4e4; }
:host([data-theme='dark']) .agent-row-usage,:host-context([data-theme='dark']) .agent-row-usage { color:#a4a7ad; }
:host([data-theme='dark']) .agent-flag,:host-context([data-theme='dark']) .agent-flag { color:#c8cad0; background:rgba(255,255,255,.1); }
:host([data-theme='dark']) .agent-chevron,:host-context([data-theme='dark']) .agent-chevron { color:#858990; }
@media(max-width:620px){.detail-overlay{padding:10px}.detail-dialog{max-width:100%;max-height:92vh}.detail-header{padding:16px}.detail-body{padding:16px}.detail-footer{padding:12px 16px}.detail-meta-grid{grid-template-columns:1fr}.detail-tool-params-header,.detail-tool-param{grid-template-columns:1fr .65fr .5fr}.detail-tool-params-header span:last-child,.detail-tool-param span:last-child{display:none}}
/* 整树重绘时被复挂的弹窗不重播入场动画（见 suppressEnterAnimation） */
.detail-overlay.od-detail-no-enter-animation,.detail-overlay.od-detail-no-enter-animation .detail-dialog { animation:none; }
@keyframes fade-in { from { opacity:0; } to { opacity:1; } } @keyframes dialog-in { from { opacity:0; transform:scale(.95) translateY(8px); } to { opacity:1; transform:scale(1) translateY(0); } }
@keyframes body-switch-forward { from { opacity:0; transform:translateX(24px); } to { opacity:1; transform:none; } }
@keyframes body-switch-back { from { opacity:0; transform:translateX(-24px); } to { opacity:1; transform:none; } }
`;

const BACK_ARROW_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export class SkillDetailCard extends HTMLElement {
    private _model?: SkillDetailCardModel;
    /** 上一次渲染的视图标识：同一视图的数据刷新要保住内容区滚动位置，切对象/切层级则回到顶部 */
    private renderedViewKey?: string;

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

    /**
     * 关掉入场动画。
     *
     * 宿主在做整树重绘时会把正在显示的弹窗摘要下来再挂回去（避免销毁重建），
     * 元素被移出文档再插回去会让 fade-in / dialog-in 重播一次——看起来像弹窗重新打开。
     */
    suppressEnterAnimation(): void {
        this.shadowRoot?.querySelector('.detail-overlay')?.classList.add('od-detail-no-enter-animation');
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

    /**
     * 弹窗骨架只构建一次；此后 model 更新走增量更新，
     * 保证视图切换时遮罩与窗口框架完全静止，仅内容区做滑动过渡。
     */
    private render(): void {
        if (!this.shadowRoot || !this._model) return;
        if (!this.shadowRoot.querySelector('.detail-overlay')) {
            this.buildSkeleton();
        }
        this.updateContent();
    }

    private buildSkeleton(): void {
        const shadowRoot = this.shadowRoot;
        if (!shadowRoot) return;
        shadowRoot.innerHTML = `<style>${STYLE}</style><div class="detail-overlay od-overlay"><div class="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="shared-skill-detail-title"><div class="detail-header info"><button type="button" class="detail-back" hidden>${BACK_ARROW_SVG}</button><div class="detail-icon"></div><div class="detail-header-info"><div class="detail-name" id="shared-skill-detail-title"></div><div class="detail-id"></div><span class="header-extra"></span></div><button type="button" class="detail-close">${CLOSE_SVG}</button></div><div class="detail-body"></div><div class="detail-footer" hidden></div></div></div>`;

        const overlay = shadowRoot.querySelector('.detail-overlay');
        if (overlay) {
            bindOverlayDismiss(overlay as HTMLElement, () => this.emitAction('close'));
        }
        shadowRoot.querySelector('.detail-close')?.addEventListener('click', () => this.emitAction('close'));
        shadowRoot.querySelector('.detail-back')?.addEventListener('click', () => this.emitAction('back'));
        // footer 按钮与工具参数折叠使用事件委托，内容更新后无需重复绑定
        shadowRoot.querySelector('.detail-footer')?.addEventListener('click', (event) => {
            const button = (event.target as Element).closest<HTMLElement>('[data-detail-action]');
            // 禁用态按钮不派发动作：防御性拦截，避免其它前端用脚本点击绕过
            if (!button || (button as HTMLButtonElement).disabled) return;
            this.emitAction(button.dataset.detailAction!, button.dataset.detailActionValue || undefined);
        });
        shadowRoot.querySelector('.detail-body')?.addEventListener('click', (event) => {
            const toggle = (event.target as Element).closest<HTMLElement>('.detail-tool-params-toggle');
            if (!toggle) return;
            const index = toggle.dataset.toolToggle;
            const parameters = shadowRoot.querySelector<HTMLElement>(`[data-tool-params="${index}"]`);
            if (!parameters) return;
            const expanded = parameters.style.display === 'none';
            parameters.style.display = expanded ? 'block' : 'none';
            toggle.classList.toggle('expanded', expanded);
        });
    }

    private updateContent(): void {
        if (!this.shadowRoot || !this._model) return;
        const model = this._model;
        const subtitle = model.subtitle ?? model.id;
        const color = getSkillPastel(model.name || model.id);
        const dialog = this.shadowRoot.querySelector<HTMLElement>('.detail-dialog');
        const body = this.shadowRoot.querySelector<HTMLElement>('.detail-body');
        if (!dialog || !body) return;

        // 内容区是整体重写的：同一视图被外部刷新（宿主广播变更等）时把滚动位置放回去，
        // 换插件或进出下一级视图则该从顶部开始
        const viewKey = `${model.id}\u0000${model.name}\u0000${model.subtitle ?? ''}\u0000${model.backLabel ?? ''}`;
        const keepScrollTop = viewKey === this.renderedViewKey ? body.scrollTop : 0;
        this.renderedViewKey = viewKey;

        // 视图切换时锁定窗口尺寸，避免内容高度不同导致窗口大小与居中位置跳动
        const lockSize =
            model.transition && dialog.offsetWidth > 0 && dialog.offsetHeight > 0
                ? { width: dialog.offsetWidth, height: dialog.offsetHeight }
                : undefined;

        const backButton = this.shadowRoot.querySelector<HTMLButtonElement>('.detail-back');
        if (backButton) {
            backButton.hidden = !model.backLabel;
            if (model.backLabel) {
                backButton.setAttribute('aria-label', model.backLabel);
                backButton.title = model.backLabel;
            }
        }
        const closeButton = this.shadowRoot.querySelector<HTMLButtonElement>('.detail-close');
        if (closeButton) {
            closeButton.setAttribute('aria-label', model.closeLabel);
        }
        const icon = this.shadowRoot.querySelector<HTMLElement>('.detail-icon');
        if (icon) {
            icon.style.background = color.bg;
            icon.style.color = color.text;
            icon.textContent = getSkillInitial(model.name || model.id);
        }
        const nameElement = this.shadowRoot.querySelector<HTMLElement>('.detail-name');
        if (nameElement) nameElement.textContent = model.name || model.id;
        const subtitleElement = this.shadowRoot.querySelector<HTMLElement>('.detail-id');
        if (subtitleElement) subtitleElement.textContent = subtitle;
        const headerExtra = this.shadowRoot.querySelector<HTMLElement>('.header-extra');
        if (headerExtra) headerExtra.innerHTML = model.headerExtraHtml ?? '';

        const metadata = model.metadata?.length
            ? `<section class="detail-section"><div class="detail-section-label">${escapeHtml(model.metadataLabel ?? '')}</div><div class="detail-meta-grid">${model.metadata
                  .map(
                      (item) =>
                          `<div class="detail-meta-item"><div class="meta-label">${escapeHtml(item.label)}</div><div class="meta-value">${
                              item.href && isExternalHref(item.href)
                                  ? `<a class="meta-link" href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.value)}</a>`
                                  : escapeHtml(item.value)
                          }</div></div>`
                  )
                  .join('')}</div></section>`
            : '';
        body.innerHTML = `${model.description ? `<section class="detail-section"><div class="detail-section-label">${escapeHtml(model.descriptionLabel ?? '')}</div><div class="detail-desc">${escapeHtml(model.description)}</div></section>` : ''}${model.bodyHtml ? `<section class="detail-section"><div class="detail-section-label">${escapeHtml(model.bodyLabel ?? '')}</div><div class="detail-body-content markdown-body">${model.bodyHtml}</div></section>` : ''}${metadata}${model.extraSectionsHtml ?? ''}`;
        body.scrollTop = keepScrollTop;

        const footer = this.shadowRoot.querySelector<HTMLElement>('.detail-footer');
        if (footer) {
            if (model.actions.length > 0 || model.footerHint) {
                footer.hidden = false;
                const hint = model.footerHint
                    ? `<span class="detail-footer-hint">${escapeHtml(model.footerHint)}</span>`
                    : '';
                footer.innerHTML = `${hint}${model.actions
                    .map(
                        (action) =>
                            `<button type="button" class="detail-action ${action.variant === 'default' || !action.variant ? '' : action.variant}" data-detail-action="${escapeHtml(action.id)}" data-detail-action-value="${escapeHtml(action.data ?? '')}"${action.disabled ? ' disabled' : ''}>${escapeHtml(action.label)}</button>`
                    )
                    .join('')}`;
            } else {
                footer.hidden = true;
                footer.innerHTML = '';
            }
        }

        if (lockSize) {
            dialog.style.width = `${lockSize.width}px`;
            dialog.style.height = `${lockSize.height}px`;
        } else {
            dialog.style.width = '';
            dialog.style.height = '';
        }

        if (model.transition) {
            const direction = model.transition === 'forward' ? 'body-switch-forward' : 'body-switch-back';
            // 先移除同名动画类并强制回流，保证连续切换时动画能重新播放
            body.classList.remove('body-switch-forward', 'body-switch-back');
            void body.offsetWidth;
            body.classList.add(direction);
            body.addEventListener(
                'animationend',
                () => {
                    body.classList.remove('body-switch-forward', 'body-switch-back');
                },
                { once: true }
            );
        }
    }
}

if (!customElements.get('skill-detail-card')) {
    customElements.define('skill-detail-card', SkillDetailCard);
}
