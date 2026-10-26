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
 * 反馈弹窗 — 首屏为「许愿池 / 有 Bug！」两个大选项卡。
 *
 * 设计规范参见 docs/designs/modal.html：
 *   - 顶部色带（info 语义）+ 实心图标 + 标题/副标题 + 关闭按钮
 *   - 16px 卡片圆角、深浅双模式、进入 250ms / 退出 180ms 动效
 *   - 复用 confirmModal 的 MODAL_CSS 变量体系（--mc-* ）
 *
 * 与 confirmModal 的差异：卡片更宽（520px）以容纳并排的两个选项卡，
 * 且**不绑定遮罩点击关闭**——用户需通过关闭按钮或 ESC 退出，避免误触丢失选择。
 */

import { MODAL_CSS, MODAL_ANIM_DURATION_OUT, detectDarkMode, renderIcon } from './confirmModal.js';
import { escapeHtml } from '../../common/utils/escape.js';
import { getSidebarRecentRootTasks } from '../sidebarTaskGroups.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type FeedbackOptionId = 'wish' | 'bug';

/** 服务端反馈类型：许愿池 → feature，Bug → bug */
export type FeedbackType = 'feature' | 'bug';

export interface FeedbackOption {
    id: FeedbackOptionId;
    /** 标题 locale key */
    titleKey: string;
    /** 描述 locale key（不含末尾颜文字） */
    descKey: string;
    /** 末尾颜文字 locale key，独立渲染以套用该卡片语义色 */
    emoticonKey: string;
    /** 卡片底部行动文案 locale key */
    actionKey: string;
    /** 语义色，决定图标底色、行动文案与颜文字颜色 */
    tone: 'green' | 'amber';
    /** 小号内联 SVG 图标（24×24 视窗 · 2px 描边 · 圆角端点，与侧边栏图标同族） */
    iconSvg: string;
}

/** 许愿池：灯泡 — 表达"提想法、提需求" */
const WISH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.4.9 1 .9 1.7v.4h5.2v-.4c0-.7.3-1.3.9-1.7A6 6 0 0 0 12 3z"/></svg>`;

/** 有 Bug：警示三角 — 表达"出问题了" */
const BUG_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.2v4"/><path d="M12 17h.01"/></svg>`;

const ARROW_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>`;

/** Bug 反馈可附加的文件项。默认值同时驱动渲染与控件初始化，避免依赖 checked 属性反射 */
export const FEEDBACK_BUG_ATTACHMENTS = [
    { id: 'systemLog', labelKey: 'renderer.feedback.attachments.systemLog', defaultChecked: true },
    { id: 'taskJson', labelKey: 'renderer.feedback.attachments.taskJson', defaultChecked: false }
] as const;

export const FEEDBACK_MODAL_OPTIONS: FeedbackOption[] = [
    {
        id: 'wish',
        titleKey: 'renderer.feedback.wish.title',
        descKey: 'renderer.feedback.wish.desc',
        emoticonKey: 'renderer.feedback.wish.emoticon',
        actionKey: 'renderer.feedback.wish.action',
        tone: 'green',
        iconSvg: WISH_ICON
    },
    {
        id: 'bug',
        titleKey: 'renderer.feedback.bug.title',
        descKey: 'renderer.feedback.bug.desc',
        emoticonKey: 'renderer.feedback.bug.emoticon',
        actionKey: 'renderer.feedback.bug.action',
        tone: 'amber',
        iconSvg: BUG_ICON
    }
];

const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export const FEEDBACK_MODAL_CSS = `
/* 语义色补充（modal.html 色板中的 green / amber，MODAL_CSS 未导出这两组变量） */
.od-feedback-overlay {
    --mc-fb-green: #1F9D66;
    --mc-fb-green-soft: #E7F5EE;
    --mc-fb-amber: #B87503;
    --mc-fb-amber-soft: #FDF3E3;
}
.od-feedback-overlay.od-modal-dark {
    --mc-fb-green: #3DBF82;
    --mc-fb-green-soft: rgba(61, 191, 130, 0.15);
    --mc-fb-amber: #E2A23B;
    --mc-fb-amber-soft: rgba(226, 162, 59, 0.15);
}
.od-feedback-card { width: 560px; }
.od-feedback-body {
    padding: 20px 24px 24px;
    display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
}
/* 选项卡：顶部内容区 + 底部行动区，语义色驱动图标底色与行动文案 */
.od-feedback-option {
    display: flex; flex-direction: column; align-items: stretch;
    padding: 0; overflow: hidden;
    border: 1px solid var(--mc-line);
    border-radius: 14px;
    background: var(--mc-card-bg);
    cursor: pointer; text-align: left;
    font-family: inherit;
    transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.od-feedback-option-green { --fo-tone: var(--mc-fb-green); --fo-tone-soft: var(--mc-fb-green-soft); }
.od-feedback-option-amber { --fo-tone: var(--mc-fb-amber); --fo-tone-soft: var(--mc-fb-amber-soft); }
.od-feedback-option:hover {
    border-color: var(--fo-tone);
    transform: translateY(-2px);
}
.od-feedback-option:active { transform: translateY(0); }
.od-feedback-option-main {
    padding: 18px 18px 20px;
    display: flex; flex-direction: column; gap: 10px;
    flex: 1;
}
/* 小图标 + 语义色浅底圆角方块（与 modal.html 色带图标同一构造） */
.od-feedback-option-icon {
    width: 38px; height: 38px; border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
    flex: none;
    background: var(--fo-tone-soft); color: var(--fo-tone);
}
.od-feedback-option-icon svg { width: 19px; height: 19px; }
.od-feedback-option-title {
    font-size: 14.5px; font-weight: 700; color: var(--mc-ink); line-height: 1.3;
}
.od-feedback-option-desc {
    font-size: 12px; color: var(--mc-ink3); line-height: 1.65;
}
.od-feedback-emoticon {
    color: var(--fo-tone);
    font-weight: 700;
    font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
    margin-left: 2px;
    white-space: nowrap;
}
/* 底部行动区：语义色文案 + 右箭头，hover 时箭头右移 */
.od-feedback-option-action {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid var(--mc-line-soft);
    font-size: 12.5px; font-weight: 600;
    color: var(--fo-tone);
}
.od-feedback-option-action svg {
    width: 15px; height: 15px; flex: none;
    transition: transform 0.15s;
}
.od-feedback-option:hover .od-feedback-option-action svg { transform: translateX(3px); }

/* ===== 首屏 ↔ 表单的横向滑动：两个等宽面板并排，容器整体左移一屏 =====
   viewport 高度由 JS 按当前面板显式设置并做过渡，否则首屏与表单高度不同会导致
   弹窗高度瞬间跳变；align-items: flex-start 让两个面板各自保持自然高度，
   不会被 flex 默认的 stretch 拉成等高。 */
.od-feedback-viewport {
    overflow: hidden;
    transition: height 0.32s cubic-bezier(0.23, 1, 0.32, 1);
}
.od-feedback-track {
    display: flex;
    align-items: flex-start;
    width: 200%;
    transition: transform 0.32s cubic-bezier(0.23, 1, 0.32, 1);
}
.od-feedback-track.is-form { transform: translateX(-50%); }
.od-feedback-pane { width: 50%; flex: none; }
/* 未激活的一侧不可交互，避免 Tab 焦点落到屏幕外的控件上 */
.od-feedback-track:not(.is-form) .od-feedback-pane-form,
.od-feedback-track.is-form .od-feedback-pane-home { visibility: hidden; }

/* ===== 表单 ===== */
.od-feedback-form {
    padding: 20px 24px 22px;
    display: flex; flex-direction: column; gap: 14px;
}
.od-feedback-form-green { --fo-tone: var(--mc-fb-green); --fo-tone-soft: var(--mc-fb-green-soft); }
.od-feedback-form-amber { --fo-tone: var(--mc-fb-amber); --fo-tone-soft: var(--mc-fb-amber-soft); }
.od-feedback-field { display: flex; flex-direction: column; gap: 6px; }
.od-feedback-label {
    font-size: 12px; font-weight: 600; color: var(--mc-ink2);
}
.od-feedback-input, .od-feedback-textarea {
    width: 100%; box-sizing: border-box;
    padding: 9px 12px; border-radius: 9px;
    border: 1.5px solid var(--mc-line);
    background: var(--mc-card-bg); color: var(--mc-ink);
    font-size: 13px; font-family: inherit; line-height: 1.6;
    outline: none; transition: border-color 0.15s;
}
.od-feedback-textarea { min-height: 108px; resize: vertical; }
.od-feedback-input:focus, .od-feedback-textarea:focus { border-color: var(--fo-tone); }
.od-feedback-input::placeholder, .od-feedback-textarea::placeholder { color: var(--mc-ink4); }
/* 校验错误：在对应控件正下方直接显示红字，不用浮层通知 */
.od-feedback-error {
    font-size: 11.5px; color: var(--mc-red);
    min-height: 0; max-height: 0; opacity: 0;
    overflow: hidden;
    transition: max-height 0.18s ease, opacity 0.15s ease;
}
.od-feedback-error.is-visible { max-height: 40px; opacity: 1; }
.od-feedback-attachments { display: flex; flex-direction: column; gap: 8px; }
/* 任务下拉独占一行放在复选框下方，勾选时高度平滑展开而不影响复选框行高 */
.od-feedback-task-picker {
    display: flex; align-items: center; gap: 8px;
    padding-left: 22px;
    max-height: 0; opacity: 0; overflow: hidden;
    transition: max-height 0.22s ease, opacity 0.18s ease, margin-top 0.22s ease;
}
.od-feedback-task-picker.is-visible {
    max-height: 40px; opacity: 1; margin-top: 2px;
}
.od-feedback-task-picker-label {
    flex: none;
    font-size: 11.5px; color: var(--mc-ink3);
}
.od-feedback-task-select {
    flex: 1; min-width: 0;
    padding: 5px 8px; border-radius: 8px;
    border: 1.5px solid var(--mc-line);
    background: var(--mc-card-bg); color: var(--mc-ink);
    font-size: 11.5px; font-family: inherit;
    outline: none; cursor: pointer;
    transition: border-color 0.15s;
}
.od-feedback-task-select:focus { border-color: var(--fo-tone); }
.od-feedback-checkbox {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 12px; color: var(--mc-ink2); line-height: 1.5;
    cursor: pointer;
}
.od-feedback-checkbox input {
    accent-color: var(--fo-tone);
    width: 14px; height: 14px; margin-top: 1px; flex: none;
}
.od-feedback-form-footer {
    display: flex; align-items: center; justify-content: flex-end; gap: 10px;
    padding-top: 4px;
}
.od-feedback-btn {
    padding: 7px 16px; border-radius: 9px; border: none;
    font-size: 12.5px; font-weight: 600; cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, border-color 0.15s, color 0.15s, filter 0.15s;
}
.od-feedback-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.od-feedback-btn-back {
    background: var(--mc-card-bg); color: var(--mc-ink2);
    border: 1px solid var(--mc-line);
}
.od-feedback-btn-back:hover:not(:disabled) { border-color: var(--fo-tone); color: var(--fo-tone); }
.od-feedback-btn-submit { background: var(--fo-tone); color: #fff; }
.od-feedback-btn-submit:hover:not(:disabled) { filter: brightness(1.08); }

/* ===== 提交成功态 ===== */
.od-feedback-success {
    padding: 34px 24px 38px;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    text-align: center;
}
.od-feedback-success-icon {
    width: 46px; height: 46px; border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    background: var(--mc-fb-green-soft); color: var(--mc-fb-green);
}
.od-feedback-success-icon svg { width: 24px; height: 24px; }
.od-feedback-success-title { font-size: 15px; font-weight: 700; color: var(--mc-ink); }
.od-feedback-success-desc { font-size: 12.5px; color: var(--mc-ink3); line-height: 1.6; }
`;

/** 表单字段：wish 有名称 + 内容，bug 只有内容 + 附件勾选 */
interface FeedbackFormValues {
    name?: string;
    content: string;
}

/**
 * 把表单字段拼成服务端需要的单一 content 正文。
 * 服务端只有 content 一个正文字段，故 wish 的名称以标题行形式并入正文。
 */
export function composeFeedbackContent(id: FeedbackOptionId, values: FeedbackFormValues): string {
    const content = values.content?.trim() ?? '';
    if (id === 'bug') {
        return content;
    }
    const name = values.name?.trim() ?? '';
    return `${name}\n\n${content}`.trim();
}

function fieldHtml(options: {
    field: 'name' | 'content';
    label: string;
    placeholder: string;
    multiline: boolean;
}): string {
    const control = options.multiline
        ? `<textarea class="od-feedback-textarea" data-field="${options.field}" placeholder="${options.placeholder}" spellcheck="false"></textarea>`
        : `<input class="od-feedback-input" type="text" data-field="${options.field}" placeholder="${options.placeholder}" autocomplete="off" spellcheck="false" />`;
    return `
            <label class="od-feedback-field">
                <span class="od-feedback-label">${options.label}</span>
                ${control}
                <span class="od-feedback-error" data-error-for="${options.field}"></span>
            </label>`;
}

/**
 * 构建表单面板 HTML。导出以便单测直接断言字段与默认勾选状态。
 */
export function buildFeedbackFormPane(id: FeedbackOptionId, t: Translate): string {
    const option = FEEDBACK_MODAL_OPTIONS.find((item) => item.id === id)!;

    const nameField =
        id === 'wish'
            ? fieldHtml({
                  field: 'name',
                  label: t('renderer.feedback.wish.nameLabel'),
                  placeholder: t('renderer.feedback.wish.namePlaceholder'),
                  multiline: false
              })
            : '';

    const contentField = fieldHtml({
        field: 'content',
        label: t(id === 'wish' ? 'renderer.feedback.wish.contentLabel' : 'renderer.feedback.bug.contentLabel'),
        placeholder: t(
            id === 'wish' ? 'renderer.feedback.wish.contentPlaceholder' : 'renderer.feedback.bug.contentPlaceholder'
        ),
        multiline: true
    });

    // 附件仅 bug 反馈需要：系统日志默认勾选，任务内容默认不勾选。
    // 任务下拉独占一行放在复选框列表下方：与复选框同行会改变行高，勾选时导致跳动。
    const attachments =
        id === 'bug'
            ? `
            <div class="od-feedback-field">
                <span class="od-feedback-label">${t('renderer.feedback.attachments.label')}</span>
                <div class="od-feedback-attachments">
                    ${FEEDBACK_BUG_ATTACHMENTS.map(
                        (item) => `<label class="od-feedback-checkbox">
                        <input type="checkbox" data-attachment="${item.id}"${item.defaultChecked ? ' checked' : ''} />
                        <span>${t(item.labelKey)}</span>
                    </label>`
                    ).join('')}
                    <div class="od-feedback-task-picker" data-task-picker>
                        <span class="od-feedback-task-picker-label">${t(
                            'renderer.feedback.attachments.taskNameLabel'
                        )}</span>
                        <select class="od-feedback-task-select" data-task-select></select>
                    </div>
                </div>
            </div>`
            : '';

    return `
    <div class="od-feedback-form od-feedback-form-${option.tone}" data-feedback-form="${id}">
        ${nameField}
        ${contentField}
        ${attachments}
        <span class="od-feedback-error" data-error-for="submit"></span>
        <div class="od-feedback-form-footer">
            <button class="od-feedback-btn od-feedback-btn-back" data-action="back" type="button">${t(
                'renderer.feedback.back'
            )}</button>
            <button class="od-feedback-btn od-feedback-btn-submit" data-action="submit" type="button">${t(
                'renderer.feedback.submit'
            )}</button>
        </div>
    </div>`;
}

/**
 * 构建弹窗卡片 HTML（不含 <style> 与遮罩），便于单测直接断言结构与文案。
 * 首屏与表单并排放在滑轨里，切换时整条滑轨左移，实现卡片左滑出、表单右侧进入。
 */
export function buildFeedbackModalCard(t: Translate): string {
    const options = FEEDBACK_MODAL_OPTIONS.map(
        (option) => `
        <button class="od-feedback-option od-feedback-option-${option.tone}" data-feedback-option="${option.id}" type="button">
            <span class="od-feedback-option-main">
                <span class="od-feedback-option-icon">${option.iconSvg}</span>
                <span class="od-feedback-option-title">${t(option.titleKey)}</span>
                <span class="od-feedback-option-desc">${t(option.descKey)}<span class="od-feedback-emoticon">${t(
                    option.emoticonKey
                )}</span></span>
            </span>
            <span class="od-feedback-option-action">
                ${t(option.actionKey)}
                ${ARROW_SVG}
            </span>
        </button>`
    ).join('');

    return `
<div class="od-confirm-modal-card od-feedback-card">
    <div class="od-confirm-modal-banner info">
        <div class="od-confirm-modal-icon">${renderIcon('fa-comment')}</div>
        <div class="od-confirm-modal-banner-text">
            <div class="od-confirm-modal-title">${t('renderer.feedback.modal.title')}</div>
            <div class="od-confirm-modal-subtitle">${t('renderer.feedback.modal.subtitle')}</div>
        </div>
        <button class="od-confirm-modal-close" data-action="close" aria-label="${t('common.close')}">${CLOSE_SVG}</button>
    </div>
    <div class="od-feedback-viewport">
        <div class="od-feedback-track">
            <div class="od-feedback-pane od-feedback-pane-home">
                <div class="od-feedback-body">${options}</div>
            </div>
            <div class="od-feedback-pane od-feedback-pane-form"></div>
        </div>
    </div>
</div>`;
}

export interface CreateFeedbackOverlayDeps {
    /** 深色模式判定，默认复用 confirmModal 的 detectDarkMode */
    detectDark?: () => boolean;
}

/**
 * 构建反馈弹窗遮罩元素。刻意不绑定遮罩点击关闭：
 * 弹窗外点击时不应自动隐藏，关闭入口仅为关闭按钮与 ESC。
 */
export function createFeedbackModalOverlay(t: Translate, deps: CreateFeedbackOverlayDeps = {}): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'od-confirm-modal-overlay od-feedback-overlay';
    const isDark = deps.detectDark ? deps.detectDark() : detectDarkMode();
    if (isDark) {
        overlay.classList.add('od-modal-dark');
    }
    overlay.innerHTML = `<style>${MODAL_CSS}${FEEDBACK_MODAL_CSS}</style>${buildFeedbackModalCard(t)}`;
    return overlay;
}

export interface ShowFeedbackModalOptions {
    mountTarget?: HTMLElement;
}

/** 提交结果：与 preload 的 { status, message } 约定保持一致 */
interface SubmitResponse {
    status: string;
    message?: string;
}

export interface FeedbackModalDeps {
    /** 当前正在查看的任务 id，用于在下拉中标记「当前任务」并作为默认选中项 */
    getCurrentTaskId: () => string | null;
    /** 供任务下拉使用的候选任务列表，口径与侧边栏按时间分组一致 */
    listRecentTasks: () => Promise<FeedbackTaskOption[]>;
    submitFeedback: (submission: {
        type: FeedbackType;
        content: string;
        includeSystemLog: boolean;
        includeTaskJson: boolean;
        taskId: string | null;
    }) => Promise<SubmitResponse>;
    onClose: () => void;
}

/** 任务下拉的一个候选项 */
export interface FeedbackTaskOption {
    taskId: string;
    name: string;
}

/** 任务下拉最多展示的任务数 */
export const FEEDBACK_TASK_OPTION_LIMIT = 10;

const SUCCESS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

/** 首屏 ↔ 表单滑动时长，需与 FEEDBACK_MODAL_CSS 中的 transition 保持一致 */
const SLIDE_DURATION_MS = 320;

/**
 * 构建任务下拉的 option 列表。当前打开的任务排在首位并标注「(当前任务)」，
 * 便于用户在最常见的场景下直接提交而不必翻找。
 */
export function buildTaskSelectOptions(
    tasks: FeedbackTaskOption[],
    currentTaskId: string | null,
    t: Translate
): string {
    if (tasks.length === 0) {
        return `<option value="">${escapeHtml(t('renderer.feedback.attachments.taskEmpty'))}</option>`;
    }
    const current = tasks.find((task) => task.taskId === currentTaskId);
    const ordered = current ? [current, ...tasks.filter((task) => task.taskId !== currentTaskId)] : tasks;
    return ordered
        .map((task) => {
            const label =
                task.taskId === currentTaskId
                    ? t('renderer.feedback.attachments.taskCurrent', { name: task.name })
                    : task.name;
            const selected = task.taskId === currentTaskId ? ' selected' : '';
            return `<option value="${escapeHtml(task.taskId)}"${selected}>${escapeHtml(label)}</option>`;
        })
        .join('');
}

function setFieldError(overlay: HTMLElement, field: string, message: string): void {
    const el = overlay.querySelector(`[data-error-for="${field}"]`);
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('is-visible', message.length > 0);
}

function clearFormErrors(overlay: HTMLElement): void {
    overlay.querySelectorAll('[data-error-for]').forEach((el) => {
        el.textContent = '';
        el.classList.remove('is-visible');
    });
}

/** 在下一帧执行，用于等待 DOM 布局落定后再读取尺寸 */
function scheduleFrame(fn: () => void): void {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(fn);
    } else {
        setTimeout(fn, 0);
    }
}

/**
 * 绑定弹窗交互：卡片选择 → 滑向表单 → 校验 → 提交 → 成功态。
 * 与渲染分离导出，便于单测在无 Electron 环境下驱动完整流程。
 * 返回清理函数，用于关闭弹窗时断开尺寸监听。
 */
export function bindFeedbackModal(overlay: HTMLElement, t: Translate, deps: FeedbackModalDeps): () => void {
    const track = overlay.querySelector('.od-feedback-track') as HTMLElement | null;
    const formPane = overlay.querySelector('.od-feedback-pane-form') as HTMLElement | null;
    const homePane = overlay.querySelector('.od-feedback-pane-home') as HTMLElement | null;
    const viewport = overlay.querySelector('.od-feedback-viewport') as HTMLElement | null;
    if (!track || !formPane) return () => {};

    let submitting = false;

    /**
     * 把 viewport 高度锁定到当前激活面板的高度。
     * 首屏与表单高度不同，若让 viewport 保持 height:auto，切换时弹窗高度会瞬间跳变；
     * 显式设置像素高度后，CSS 的 height 过渡即可与横向滑动同步完成形变。
     */
    const syncViewportHeight = (): void => {
        if (!viewport) return;
        const active = track.classList.contains('is-form') ? formPane : homePane;
        const height = active?.offsetHeight ?? 0;
        if (height > 0) {
            viewport.style.height = `${height}px`;
        }
    };

    const setError = (field: string, message: string): void => {
        setFieldError(overlay, field, message);
        // 错误提示占位会改变表单高度，需同步 viewport
        syncViewportHeight();
    };

    const showHome = (): void => {
        track.classList.remove('is-form');
        syncViewportHeight();
        // 滑动结束后再清空表单，避免回退动画中内容突然消失
        setTimeout(() => {
            if (!track.classList.contains('is-form')) {
                formPane.innerHTML = '';
                syncViewportHeight();
            }
        }, SLIDE_DURATION_MS);
    };

    const openForm = (id: FeedbackOptionId): void => {
        formPane.innerHTML = buildFeedbackFormPane(id, t);
        track.classList.add('is-form');
        // 表单已插入 DOM，下一帧读到的才是它的真实高度
        scheduleFrame(syncViewportHeight);

        // 显式初始化勾选状态：innerHTML 注入的 checked 属性在部分 DOM 实现中
        // 不会反射到 checked 属性值上，统一以 FEEDBACK_BUG_ATTACHMENTS 为准
        for (const item of FEEDBACK_BUG_ATTACHMENTS) {
            const box = formPane.querySelector(`[data-attachment="${item.id}"]`) as HTMLInputElement | null;
            if (box) box.checked = item.defaultChecked;
        }

        formPane.querySelector('[data-action="back"]')?.addEventListener('click', showHome);
        formPane.querySelector('[data-action="submit"]')?.addEventListener('click', () => {
            void handleSubmit(id);
        });

        // 任务附件：勾选后在复选框下方展开任务下拉，选项按需异步加载一次
        const taskCheckbox = formPane.querySelector('[data-attachment="taskJson"]') as HTMLInputElement | null;
        const taskPicker = formPane.querySelector('[data-task-picker]') as HTMLElement | null;
        const taskSelect = formPane.querySelector('[data-task-select]') as HTMLSelectElement | null;
        if (taskCheckbox && taskPicker && taskSelect) {
            let optionsLoaded = false;
            taskCheckbox.addEventListener('change', () => {
                taskPicker.classList.toggle('is-visible', taskCheckbox.checked);
                syncViewportHeight();
                if (!taskCheckbox.checked || optionsLoaded) return;
                optionsLoaded = true;
                void deps
                    .listRecentTasks()
                    .then((tasks) => {
                        taskSelect.innerHTML = buildTaskSelectOptions(tasks, deps.getCurrentTaskId(), t);
                        syncViewportHeight();
                    })
                    .catch(() => {
                        // 任务列表加载失败时保持下拉为空，不阻断反馈正文提交
                        optionsLoaded = false;
                    });
            });
        }

        // 输入即清除该字段的错误提示，避免用户改完仍看到红字
        formPane.querySelectorAll('[data-field]').forEach((control) => {
            control.addEventListener('input', () => {
                setError((control as HTMLElement).dataset.field!, '');
                setError('submit', '');
            });
        });
        setTimeout(
            () => (formPane.querySelector('[data-field]') as HTMLElement | null)?.focus(),
            SLIDE_DURATION_MS + 20
        );
    };

    const handleSubmit = async (id: FeedbackOptionId): Promise<void> => {
        if (submitting) return;
        clearFormErrors(overlay);

        const nameInput = formPane.querySelector('[data-field="name"]') as HTMLInputElement | null;
        const contentInput = formPane.querySelector('[data-field="content"]') as HTMLTextAreaElement | null;
        const name = nameInput?.value.trim() ?? '';
        const content = contentInput?.value.trim() ?? '';

        if (id === 'wish' && !name) {
            setError('name', t('renderer.feedback.error.nameRequired'));
            return;
        }
        if (!content) {
            setError('content', t('renderer.feedback.error.contentRequired'));
            return;
        }

        const includeSystemLog =
            (formPane.querySelector('[data-attachment="systemLog"]') as HTMLInputElement | null)?.checked === true;
        const includeTaskJson =
            (formPane.querySelector('[data-attachment="taskJson"]') as HTMLInputElement | null)?.checked === true;
        // 用户在下拉中选定的任务；未选到有效任务时回落到当前打开的任务
        const selectedTaskId =
            (formPane.querySelector('[data-task-select]') as HTMLSelectElement | null)?.value || null;

        const submitBtn = formPane.querySelector('[data-action="submit"]') as HTMLButtonElement | null;
        submitting = true;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = t('renderer.feedback.submitting');
        }

        const result = await deps.submitFeedback({
            type: id === 'wish' ? 'feature' : 'bug',
            content: composeFeedbackContent(id, { name, content }),
            includeSystemLog,
            includeTaskJson,
            taskId: includeTaskJson ? (selectedTaskId ?? deps.getCurrentTaskId()) : null
        });

        submitting = false;
        if (result?.status === 'ok') {
            showSuccess();
            return;
        }
        // 失败时保留用户已填内容，仅在底部提示原因，便于重试
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = t('renderer.feedback.submit');
        }
        setError('submit', t('renderer.feedback.error.submitFailed', { message: result?.message ?? '' }));
    };

    const showSuccess = (): void => {
        formPane.innerHTML = `
        <div class="od-feedback-success">
            <div class="od-feedback-success-icon">${SUCCESS_SVG}</div>
            <div class="od-feedback-success-title">${t('renderer.feedback.success.title')}</div>
            <div class="od-feedback-success-desc">${t('renderer.feedback.success.desc')}</div>
        </div>`;
        // 成功态比表单矮，同步收起 viewport 高度而非瞬间跳变
        scheduleFrame(syncViewportHeight);
    };

    overlay.querySelector('[data-action="close"]')?.addEventListener('click', () => deps.onClose());
    overlay.querySelectorAll('[data-feedback-option]').forEach((button) => {
        button.addEventListener('click', () => {
            openForm((button as HTMLElement).dataset.feedbackOption as FeedbackOptionId);
        });
    });

    // 首屏挂载后锁定初始高度，作为后续过渡的起点
    scheduleFrame(syncViewportHeight);

    // 文本域可手动拖高、窗口宽度变化也会引起换行导致高度变化，跟随同步
    const ResizeObserverImpl = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!ResizeObserverImpl) {
        return () => {};
    }
    const observer = new ResizeObserverImpl(() => syncViewportHeight());
    if (homePane) observer.observe(homePane);
    observer.observe(formPane);
    return () => observer.disconnect();
}

/** 读取当前正在查看的任务 id（由 index.html 的 openTask 写入侧边栏组件） */
function readCurrentTaskId(): string | null {
    const sidebar = document.getElementById('main-sidebar') as (HTMLElement & { currentTaskId?: string | null }) | null;
    return sidebar?.currentTaskId ?? null;
}

/**
 * 读取任务下拉的候选项。与侧边栏「按时间」分组同源：同一份 getTaskList，
 * 同一套 getSidebarRecentRootTasks 口径（仅根任务、排除自动化任务、按活动时间降序）。
 */
async function listRecentTasks(t: Translate): Promise<FeedbackTaskOption[]> {
    const taskList = await window.taskManagerAPI.getTaskList();
    return getSidebarRecentRootTasks(taskList, FEEDBACK_TASK_OPTION_LIMIT).map((task) => ({
        taskId: task.task_id,
        name: task.task_name?.trim() || t('renderer.sidebar.unnamedTask')
    }));
}

/**
 * 展示反馈弹窗。关闭（关闭按钮 / ESC）时 resolve，点击遮罩不关闭。
 */
export function showFeedbackModal(t: Translate, options: ShowFeedbackModalOptions = {}): Promise<void> {
    return new Promise((resolve) => {
        const mountTarget = options.mountTarget ?? document.body;
        const overlay = createFeedbackModalOverlay(t, { detectDark: () => detectDarkMode(mountTarget) });

        let resolved = false;
        const close = (): void => {
            if (resolved) return;
            resolved = true;
            overlay.classList.add('od-modal-leaving');
            setTimeout(() => {
                overlay.remove();
                resolve();
            }, MODAL_ANIM_DURATION_OUT);
            document.removeEventListener('keydown', escHandler);
            dispose();
        };

        const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', escHandler);

        const dispose = bindFeedbackModal(overlay, t, {
            getCurrentTaskId: readCurrentTaskId,
            listRecentTasks: () => listRecentTasks(t),
            submitFeedback: (submission) => window.settingAPI.submitFeedback(submission),
            onClose: close
        });

        mountTarget.appendChild(overlay);
    });
}
