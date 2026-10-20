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
 * 触摸屏长按 → 右键点击（全局）。
 *
 * Chromium 桌面版在触摸屏上没有"长按 = 右键"手势（长按只用于选词/滚动），
 * 这里以主世界注入脚本补偿：
 *
 * 1. 单指按下起 120ms 判定期，期间抬起（多数是单击）不显示任何指示；
 *    超过 120ms 在触摸点显示圆环进度动画，触发计时从显示时从 0 起算
 *    （即按下后 120ms + 550ms 就绪），进度环与定时严格同步。
 *    圆环 80px 大于手指接触面，露在手指外缘可见；手指移动时圆环跟随，
 *    累计位移超过 36px（约手指半径）才判定为拖动/滚动意图取消；
 *    取消走快速淡出而非瞬间消失，避免视觉闪烁（含滚动接管时的 touchcancel）。
 *    配色对齐 taskview markdown 行内代码：底环 var(--chat-accent-soft)、
 *    进度环与中心点 var(--chat-accent)，深浅色主题自动跟随。
 * 2. 进度满后保持满环（就绪态），等用户松开手指才触发右键，位置为最新手指
 *    位置；就绪后移动超容差 / 多指 / touchcancel 仍会取消。触发时清除触摸
 *    选词产生的选区，并在命中元素上派发合成 contextmenu——这是菜单的唯一
 *    位置来源（局部坐标天然精确，不依赖合成输入事件与原生菜单 API 的平台
 *    坐标语义）。
 * 3. 编辑区（input / textarea / contenteditable）右键菜单在脚本内自绘：
 *    剪切/复制/粘贴/全选，视觉对齐公共 ctx-menu（同一套 --ctx-* 变量，
 *    深浅色主题自动切换）。真实鼠标右键与触摸长按的合成事件统一走该菜单
 *    （原生菜单只能弹在系统光标处、位置不可控，已从主进程移除）；仅宿主
 *    标记 data-od-lp-edit-menu（OpenDesk 自家 frame）时启用，避免浏览器网页
 *    等第三方 frame 出现双菜单。文案随页面 <html lang>（回退 navigator.language）；
 *    关闭途径：菜单外 pointerdown、Escape、任意非修饰键 keydown 或 beforeinput
 *    （开始输入即视为放弃菜单，焦点本就在输入框时没有 pointerdown 可依赖）；
 *    剪贴板读写经隔离世界的 preload 桥（CustomEvent 'od-clipboard-write' /
 *    'od-clipboard-read' + 'od-clipboard-read-result'），不把剪贴板暴露给网页。
 * 4. 触发后 Chromium 会补发模拟的 mousedown/mouseup/click 序列，
 *    在 window 捕获阶段拦截一轮，防止误触发按钮或刚弹出的菜单被"点击"掉。
 *
 * createTouchLongPressController 必须保持完全自包含（只引用全局与字面量）：
 * 它会被 toString() 序列化成 TOUCH_LONG_PRESS_SCRIPT 注入主世界，单测则直接调用。
 */

export function createTouchLongPressController(): void {
    const w = window as any;
    if (w.__odTouchLongPressInstalled) return;
    w.__odTouchLongPressInstalled = true;

    const LONG_PRESS_MS = 550;
    const SHOW_DELAY_MS = 120;
    const CANCEL_SLOP_PX = 36;
    // 移动意图阈值：超过即视为用户在做滚动/拖拽而非长按（用于区分 touchcancel）
    const MOVE_INTENT_SLOP_PX = 8;
    const CANCEL_FADE_MS = 120;
    const SUPPRESS_MOUSE_MS = 150;
    const INDICATOR_ID = 'od-longpress-indicator';
    const STYLE_ID = 'od-longpress-style';
    const EDIT_MENU_HOST_ATTR = 'data-od-lp-edit-menu';
    const EDIT_MENU_ID = 'od-edit-menu';
    const CLIP_WRITE_EVENT = 'od-clipboard-write';
    const CLIP_READ_EVENT = 'od-clipboard-read';
    const CLIP_READ_RESULT_EVENT = 'od-clipboard-read-result';
    const TOUCH_ACTIVE_EVENT = 'od-touch-active';
    // 指示器尺寸大于手指接触面（约 60-70px），圆环露在手指外缘可见；
    // 定位（外层 transform）与触发反馈（内层 scale 动画）分离，互不覆盖。
    const INDICATOR_SIZE = 80;
    const HALF = INDICATOR_SIZE / 2;
    // 进度环 r=35（viewBox 80）的周长，dashoffset 从满到 0 即进度 0 → 100%
    const RING_CIRCUMFERENCE = 219.911;

    const INDICATOR_CSS = [
        `#${INDICATOR_ID} {`,
        '    position: fixed;',
        '    left: 0;',
        '    top: 0;',
        `    width: ${INDICATOR_SIZE}px;`,
        `    height: ${INDICATOR_SIZE}px;`,
        '    z-index: 2147483647;',
        '    pointer-events: none;',
        `    transition: opacity ${CANCEL_FADE_MS}ms ease-out;`,
        '}',
        `#${INDICATOR_ID}.cancelling {`,
        '    opacity: 0;',
        '}',
        '.od-longpress-ring {',
        '    width: 100%;',
        '    height: 100%;',
        '}',
        // 淡色底环 + 主题强调色前景，与 taskview markdown 行内代码同源
        `#${INDICATOR_ID} .ring-halo {`,
        '    stroke: var(--chat-accent-soft, #fdeeec);',
        '    stroke-width: 4.6;',
        '}',
        `#${INDICATOR_ID} .ring-fg {`,
        '    stroke: var(--chat-accent, #df4436);',
        '    stroke-width: 4.5;',
        '    stroke-linecap: round;',
        `    stroke-dasharray: ${RING_CIRCUMFERENCE};`,
        `    stroke-dashoffset: ${RING_CIRCUMFERENCE};`,
        '    transform: rotate(-90deg);',
        '    transform-origin: center;',
        '    transform-box: fill-box;',
        '}',
        `#${INDICATOR_ID}.visible .ring-fg {`,
        `    animation: od-lp-progress ${LONG_PRESS_MS}ms linear forwards;`,
        '}',
        `#${INDICATOR_ID} .dot {`,
        '    fill: var(--chat-accent, #df4436);',
        '    fill-opacity: 0.75;',
        '}',
        // 触发反馈：内层扩散淡出（外层 transform 负责定位，避免动画覆盖定位）
        `#${INDICATOR_ID}.fired .od-longpress-ring {`,
        '    animation: od-lp-fired 180ms ease-out forwards;',
        '}',
        '@keyframes od-lp-progress {',
        '    to { stroke-dashoffset: 0; }',
        '}',
        '@keyframes od-lp-fired {',
        '    from { transform: scale(1); opacity: 1; }',
        '    to { transform: scale(1.35); opacity: 0; }',
        '}'
    ].join('\n');

    const EDIT_MENU_CSS = [
        // 视觉对齐公共 ctx-menu（context-menu.css）：同一套 --ctx-* 变量，
        // 深浅色主题随 html[data-theme='dark'] 自动切换。
        // 菜单以 popover 进入浏览器 top layer，任何 z-index 的浮层都盖不住；
        // 需覆盖 popover 的 UA 默认样式（inset:0 / margin:auto 居中 / 边框内边距）。
        `#${EDIT_MENU_ID} {`,
        '    position: fixed;',
        '    inset: auto;',
        '    margin: 0;',
        '    z-index: 2147483646;',
        '    min-width: 180px;',
        '    padding: 5px;',
        '    background: var(--ctx-bg, #ffffff);',
        '    border: 1px solid var(--ctx-border, #e7e5e2);',
        '    border-radius: 12px;',
        '    box-shadow: var(--ctx-shadow, 0 1px 2px rgba(28, 25, 23, 0.04), 0 4px 14px rgba(28, 25, 23, 0.07));',
        '    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);',
        '    animation: od-edit-menu-fade-in 0.2s ease-out;',
        '}',
        '@keyframes od-edit-menu-fade-in {',
        '    from { opacity: 0; transform: scale(0.97) translateY(-3px); }',
        '    to { opacity: 1; transform: scale(1) translateY(0); }',
        '}',
        `#${EDIT_MENU_ID} .od-edit-menu-item {`,
        '    display: flex;',
        '    align-items: center;',
        '    gap: 8px;',
        '    padding: 6px 12px;',
        '    font-size: 12.5px;',
        '    cursor: pointer;',
        '    white-space: nowrap;',
        '    transition: background 0.12s ease, color 0.12s ease;',
        '    border: 0;',
        '    background: none;',
        '    font-family: inherit;',
        '    width: 100%;',
        '    text-align: left;',
        '    border-radius: 7px;',
        '    color: var(--ctx-ink2, #4a4642);',
        '}',
        `#${EDIT_MENU_ID} .od-edit-menu-item:hover {`,
        '    background: var(--ctx-hover, #f0efec);',
        '    color: var(--ctx-ink, #1c1917);',
        '}',
        `#${EDIT_MENU_ID} .od-edit-menu-icon {`,
        '    display: inline-flex;',
        '    align-items: center;',
        '    justify-content: center;',
        '    width: 14px;',
        '    height: 14px;',
        '    flex: none;',
        '    color: var(--ctx-ink3, #8a8580);',
        '}',
        // 快捷键提示（右侧对齐，风格对齐 ctx-shortcut）
        `#${EDIT_MENU_ID} .od-edit-menu-shortcut {`,
        '    font-size: 11px;',
        '    color: var(--ctx-ink4, #b4afa9);',
        '    font-family: var(--font-mono, monospace);',
        '    margin-left: auto;',
        '    flex: none;',
        '}',
        // 只读选区场景（代码/markdown 预览等）：剪切/粘贴不适用，置灰
        `#${EDIT_MENU_ID} .od-edit-menu-item.disabled {`,
        '    opacity: 0.45;',
        '    pointer-events: none;',
        '}',
        `#${EDIT_MENU_ID} .od-edit-menu-divider {`,
        '    height: 1px;',
        '    margin: 4px 6px;',
        '    background: var(--ctx-sep, #efeeea);',
        '}'
    ].join('\n');

    const INDICATOR_SVG = [
        '<svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">',
        '<circle class="ring-halo" cx="40" cy="40" r="37" />',
        '<circle class="ring-fg" cx="40" cy="40" r="35" />',
        '<circle class="dot" cx="40" cy="40" r="6" />',
        '</svg>'
    ].join('');

    function ensureStyle(): void {
        if (document.getElementById(STYLE_ID)) return;
        const styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        styleEl.textContent = INDICATOR_CSS + '\n' + EDIT_MENU_CSS;
        (document.head || document.documentElement).appendChild(styleEl);
    }

    function removeIndicator(): void {
        const el = document.getElementById(INDICATOR_ID);
        if (el && el.remove) el.remove();
    }

    // 取消路径：快速淡出后移除，避免突兀闪烁。
    // 回调只移除自己捕获的元素——期间可能已有新一轮长按创建的同 id 指示器。
    function fadeOutIndicator(): void {
        const el = document.getElementById(INDICATOR_ID);
        if (!el) return;
        el.classList.add('cancelling');
        setTimeout(() => {
            if (el && el.remove) el.remove();
        }, CANCEL_FADE_MS);
    }

    function positionIndicator(el: any, x: number, y: number): void {
        el.style.transform = 'translate(' + (x - HALF) + 'px, ' + (y - HALF) + 'px)';
    }

    function showIndicator(x: number, y: number): void {
        ensureStyle();
        removeIndicator();
        const el = document.createElement('div');
        el.id = INDICATOR_ID;
        const ring = document.createElement('div');
        ring.className = 'od-longpress-ring';
        ring.innerHTML = INDICATOR_SVG;
        el.appendChild(ring);
        positionIndicator(el, x, y);
        (document.body || document.documentElement).appendChild(el);
        el.classList.add('visible');
    }

    function repositionIndicator(x: number, y: number): void {
        const el = document.getElementById(INDICATOR_ID);
        if (el) positionIndicator(el, x, y);
    }

    // 触发反馈：进度环扩散淡出后再移除（同 fadeOutIndicator，回调只删自己）
    function completeIndicator(): void {
        const el = document.getElementById(INDICATOR_ID);
        if (!el) return;
        el.classList.add('fired');
        setTimeout(() => {
            if (el && el.remove) el.remove();
        }, 180);
    }

    function clearPageSelection(): void {
        try {
            const selection = window.getSelection();
            if (selection && typeof selection.removeAllRanges === 'function') {
                selection.removeAllRanges();
            }
        } catch {
            /* 页面可能未就绪 */
        }
    }

    function elementAt(x: number, y: number): Element | null {
        try {
            if (typeof document.elementFromPoint !== 'function') return null;
            return document.elementFromPoint(x, y);
        } catch {
            return null;
        }
    }

    // ── 编辑区自绘菜单 ──────────────────────────────────────────────

    function isEditableElement(el: any): boolean {
        if (!el) return false;
        if (el.isContentEditable === true) return true;
        if (typeof el.closest === 'function') {
            return !!el.closest('input, textarea, [contenteditable="true"]');
        }
        return false;
    }

    function editMenuEnabled(): boolean {
        try {
            return document.documentElement.hasAttribute(EDIT_MENU_HOST_ATTR);
        } catch {
            return false;
        }
    }

    function menuLabels(): { cut: string; copy: string; paste: string; selectAll: string } {
        // 语言来源：页面 <html lang>（各窗口页面已设置）→ navigator.language → 英文
        let lang = '';
        try {
            lang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
        } catch {
            /* 忽略 */
        }
        if (!lang) {
            try {
                lang = ((window.navigator && window.navigator.language) || '').toLowerCase();
            } catch {
                /* 忽略 */
            }
        }
        if (lang.indexOf('zh') === 0) {
            return { cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选' };
        }
        return { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' };
    }

    function removeEditMenu(): void {
        const el = document.getElementById(EDIT_MENU_ID);
        if (el && el.remove) el.remove();
    }

    function getSelectedText(target: any): string {
        try {
            const tag = (target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') {
                const start =
                    target.selectionStart === null || target.selectionStart === undefined ? 0 : target.selectionStart;
                const end = target.selectionEnd === null || target.selectionEnd === undefined ? 0 : target.selectionEnd;
                return (target.value || '').slice(start, end);
            }
            const selection = window.getSelection();
            if (!selection) return '';
            const text = selection.toString();
            if (text) return text;
            // Shadow DOM 内选区：Selection.toString() 可能被边界裁剪为空，
            // 再尝试取 Range 文本（open shadow 下通常可读）
            if (typeof selection.getRangeAt === 'function' && selection.rangeCount > 0) {
                return selection.getRangeAt(0).toString() || '';
            }
            return '';
        } catch {
            return '';
        }
    }

    function clipboardWrite(text: string): void {
        try {
            // 构造器取自 window：隔离宿主（如 linkedom）的事件类与全局不同
            const CustomEventCtor = window.CustomEvent || CustomEvent;
            window.dispatchEvent(new CustomEventCtor(CLIP_WRITE_EVENT, { detail: { text } }));
        } catch {
            /* 剪贴板不可用时静默 */
        }
    }

    function execDelete(target: any): void {
        try {
            if (document.execCommand && document.execCommand('delete')) return;
        } catch {
            /* 走手工兜底 */
        }
        try {
            const tag = (target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') {
                const start = target.selectionStart ?? 0;
                const end = target.selectionEnd ?? 0;
                if (end > start) {
                    const value = target.value || '';
                    target.value = value.slice(0, start) + value.slice(end);
                    target.selectionStart = start;
                    target.selectionEnd = start;
                }
            }
        } catch {
            /* 忽略 */
        }
    }

    function execCut(target: any): void {
        const text = getSelectedText(target);
        if (!text) return;
        clipboardWrite(text);
        execDelete(target);
    }

    let clipboardRequestId = 0;

    function execPaste(target: any): void {
        const requestId = ++clipboardRequestId;
        const onResult = (event: any) => {
            const detail = event && event.detail;
            if (!detail || detail.requestId !== requestId) return;
            window.removeEventListener(CLIP_READ_RESULT_EVENT, onResult);
            const text = typeof detail.text === 'string' ? detail.text : '';
            if (!text) return;
            try {
                if (document.execCommand && document.execCommand('insertText', false, text)) return;
            } catch {
                /* 走手工兜底 */
            }
            try {
                const tag = (target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea') {
                    const start =
                        target.selectionStart === null || target.selectionStart === undefined
                            ? (target.value || '').length
                            : target.selectionStart;
                    const end =
                        target.selectionEnd === null || target.selectionEnd === undefined ? start : target.selectionEnd;
                    const value = target.value || '';
                    target.value = value.slice(0, start) + text + value.slice(end);
                    const caret = start + text.length;
                    target.selectionStart = caret;
                    target.selectionEnd = caret;
                }
            } catch {
                /* 忽略 */
            }
        };
        window.addEventListener(CLIP_READ_RESULT_EVENT, onResult);
        try {
            const CustomEventCtor = window.CustomEvent || CustomEvent;
            window.dispatchEvent(new CustomEventCtor(CLIP_READ_EVENT, { detail: { requestId } }));
        } catch {
            window.removeEventListener(CLIP_READ_RESULT_EVENT, onResult);
        }
    }

    function execSelectAll(target: any): void {
        try {
            const tag = (target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') {
                target.select();
                return;
            }
            // 只读场景选中的文本区：全选内容容器（代码块/表格/markdown 正文）
            const scope =
                typeof target.closest === 'function'
                    ? target.closest('pre, code, table, .markdown-body, .code-block-body') || target
                    : target;
            const selection = window.getSelection();
            if (selection && typeof selection.selectAllChildren === 'function') {
                selection.selectAllChildren(scope);
            }
        } catch {
            /* 忽略 */
        }
    }

    // 菜单图标（14px line 图标，与 ctx-menu 的小图标风格一致）
    const EDIT_MENU_ICONS = {
        cut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 2h6v4H9z"/></svg>',
        selectAll:
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 3"/></svg>'
    };

    // 菜单项右侧的快捷键提示（macOS 用 ⌘，其余 Ctrl）
    function editMenuShortcuts(): { cut: string; copy: string; paste: string; selectAll: string } {
        let isMac = false;
        try {
            const platform = (window.navigator && window.navigator.platform) || '';
            isMac = platform.indexOf('Mac') === 0;
        } catch {
            /* 平台不可得时按 Ctrl 处理 */
        }
        return isMac
            ? { cut: '⌘X', copy: '⌘C', paste: '⌘V', selectAll: '⌘A' }
            : { cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', selectAll: 'Ctrl+A' };
    }

    function showEditMenu(
        x: number,
        y: number,
        target: any,
        options?: { readOnly?: boolean; textContainer?: any; aceEditor?: any }
    ): void {
        ensureStyle();
        removeEditMenu();
        const readOnly = !!(options && options.readOnly);
        const textContainer = (options && options.textContainer) || target;
        const aceEditor = (options && options.aceEditor) || null;
        const menu = document.createElement('div');
        menu.id = EDIT_MENU_ID;
        const labels = menuLabels();
        const shortcuts = editMenuShortcuts();
        // 分组与系统编辑菜单一致：剪切/复制/粘贴 + 分隔 + 全选；
        // 只读选区场景剪切/粘贴置灰；Ace 编辑器的复制/全选走其内置快捷键
        const items: Array<{
            key: string;
            label: string;
            shortcut: string;
            run: () => void;
            divider?: boolean;
            disabled?: boolean;
        }> = [
            {
                key: 'cut',
                label: labels.cut,
                shortcut: shortcuts.cut,
                run: () => execCut(target),
                disabled: readOnly
            },
            {
                key: 'copy',
                label: labels.copy,
                shortcut: shortcuts.copy,
                run: aceEditor ? () => dispatchAceShortcut(aceEditor, 'c') : () => execCopy(target)
            },
            {
                key: 'paste',
                label: labels.paste,
                shortcut: shortcuts.paste,
                run: () => execPaste(target),
                disabled: readOnly
            },
            {
                key: 'selectAll',
                label: labels.selectAll,
                shortcut: shortcuts.selectAll,
                run: aceEditor ? () => dispatchAceShortcut(aceEditor, 'a') : () => execSelectAll(textContainer),
                divider: true
            }
        ];
        for (const item of items) {
            if (item.divider) {
                const divider = document.createElement('div');
                divider.className = 'od-edit-menu-divider';
                menu.appendChild(divider);
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'od-edit-menu-item' + (item.disabled ? ' disabled' : '');
            const icon = document.createElement('span');
            icon.className = 'od-edit-menu-icon';
            icon.innerHTML = EDIT_MENU_ICONS[item.key];
            const label = document.createElement('span');
            label.className = 'od-edit-menu-label';
            label.textContent = item.label;
            const shortcut = document.createElement('span');
            shortcut.className = 'od-edit-menu-shortcut';
            shortcut.textContent = item.shortcut;
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.appendChild(shortcut);
            // 阻止焦点转移，保持输入框的选区与焦点
            btn.addEventListener('pointerdown', (e: any) => {
                e.preventDefault();
            });
            btn.addEventListener('click', (e: any) => {
                e.preventDefault();
                e.stopPropagation();
                removeEditMenu();
                try {
                    if (typeof target.focus === 'function') target.focus();
                } catch {
                    /* 目标可能已移除 */
                }
                item.run();
            });
            menu.appendChild(btn);
        }
        (document.body || document.documentElement).appendChild(menu);
        // 放入浏览器 top layer：popover 层级高于任何 z-index 的浮层（搜索浮层、
        // 模态等），保证菜单始终置顶。宿主不支持 popover 时退回固定 z-index。
        try {
            if (typeof (menu as any).showPopover === 'function') {
                menu.setAttribute('popover', 'manual');
                (menu as any).showPopover();
            }
        } catch {
            /* 降级为普通层 */
        }
        // 视口内定位（先挂载再量尺寸；宿主无 innerWidth 时直接用触发点）
        const menuWidth = menu.offsetWidth || 200;
        const menuHeight = menu.offsetHeight || 160;
        let left = x;
        let top = y;
        if (typeof window.innerWidth === 'number' && window.innerWidth > 0) {
            left = Math.max(4, Math.min(x, window.innerWidth - menuWidth - 4));
            top = Math.max(4, Math.min(y, window.innerHeight - menuHeight - 4));
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
    }

    function execCopy(target: any): void {
        const text = getSelectedText(target);
        if (text) clipboardWrite(text);
    }

    // 只读文本区（代码/markdown/表格预览等）选中文字后右键同样弹编辑菜单：
    // 有可见选区、或命中只读文本容器（含 Shadow DOM 内部的预览/编辑器）即可触发，
    // 剪切/粘贴置灰，复制/全选可用。
    function hasVisibleSelection(): boolean {
        try {
            const selection = window.getSelection();
            if (!selection) return false;
            if (selection.isCollapsed) return false;
            return (selection.toString() || '').length > 0;
        } catch {
            return false;
        }
    }

    function pathOf(event: any): any[] {
        try {
            if (typeof event.composedPath === 'function') {
                const path = event.composedPath();
                if (path && path.length) return path;
            }
        } catch {
            /* 忽略 */
        }
        return [];
    }

    // 命中只读文本容器（含 Shadow DOM 内部：markdown 预览 / 代码预览 / 表格 / Ace 编辑器）
    function pickTextContainer(path: any[], fallback: any): any {
        const selector = '.markdown-body, pre, code, table, .code-block-body, .ace_editor';
        for (let i = 0; i < path.length; i++) {
            const el = path[i];
            if (el && el.nodeType === 1 && typeof el.matches === 'function' && el.matches(selector)) {
                return el;
            }
        }
        try {
            if (fallback && typeof fallback.closest === 'function') {
                return fallback.closest(selector);
            }
        } catch {
            /* 忽略 */
        }
        return null;
    }

    function pickAceEditor(path: any[], fallback: any): any {
        for (let i = 0; i < path.length; i++) {
            const el = path[i];
            if (el && el.nodeType === 1 && typeof el.matches === 'function' && el.matches('.ace_editor')) {
                return el;
            }
        }
        try {
            if (fallback && typeof fallback.closest === 'function') {
                return fallback.closest('.ace_editor');
            }
        } catch {
            /* 忽略 */
        }
        return null;
    }

    // Ace 的选区/剪贴板在编辑器内部模型里，直接读不到；用模拟快捷键让 Ace 自己执行
    function dispatchAceShortcut(aceEditor: any, key: string): void {
        try {
            const input = aceEditor.querySelector('.ace_text-input');
            if (!input || typeof input.dispatchEvent !== 'function') return;
            try {
                if (typeof input.focus === 'function') input.focus();
            } catch {
                /* 忽略 */
            }
            const KeyboardEventCtor = window.KeyboardEvent || window.Event;
            const evt = new KeyboardEventCtor('keydown', {
                key,
                code: 'Key' + key.toUpperCase(),
                ctrlKey: true,
                bubbles: true,
                cancelable: true
            });
            input.dispatchEvent(evt);
        } catch {
            /* 忽略 */
        }
    }

    // 节点是否在 open Shadow DOM 内（nodeType 11 为 ShadowRoot）
    function isInShadow(node: any): boolean {
        try {
            if (!node || typeof node.getRootNode !== 'function') return false;
            const root = node.getRootNode();
            return !!root && root.nodeType === 11;
        } catch {
            return false;
        }
    }

    function onDocumentContextMenu(event: any): void {
        // 真实右键与触摸长按的合成事件统一走自绘菜单。用 composedPath 取真实
        // 目标：fileExplorer 等组件的预览/编辑器在 open Shadow DOM 内，document
        // 收到的事件 target 已被重定向为 shadow host，且 shadow 内选区
        // getSelection().toString() 可能为空，需按容器命中兜底判定。
        // 普通 DOM 文本区保持「有选区才弹」，避免抢占链接菜单等既有右键行为。
        if (!editMenuEnabled()) return;
        const path = pathOf(event);
        const realTarget = path.length ? path[0] : event.target;
        const editable = isEditableElement(realTarget) || isEditableElement(event.target);
        const textContainer = editable ? null : pickTextContainer(path, realTarget);
        const aceEditor = editable ? null : pickAceEditor(path, realTarget);
        const shadowText =
            !editable && !!textContainer && (isInShadow(textContainer) || isInShadow(realTarget) || !!aceEditor);
        const readOnlyText = !editable && (hasVisibleSelection() || shadowText);
        if (!editable && !readOnlyText) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (readOnlyText && typeof event.stopPropagation === 'function') {
            // 只读文本区明确指向文本操作，避免链接菜单等同时弹出
            event.stopPropagation();
        }
        // 菜单弹出即收掉长按圆环（可编辑元素由 Chromium 长按触发时，圆环还在显示中）
        completeIndicator();
        showEditMenu(event.clientX, event.clientY, realTarget, {
            readOnly: !editable,
            textContainer: textContainer || realTarget,
            aceEditor
        });
    }

    function onDocumentPointerDown(event: any): void {
        try {
            if (event.target && typeof event.target.closest === 'function') {
                if (event.target.closest('#' + EDIT_MENU_ID)) return;
            }
        } catch {
            /* target 判定失败时按菜单外处理 */
        }
        removeEditMenu();
    }

    // 纯修饰键单独按下不构成编辑意图（如单按 Shift 呼出输入法）
    const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta'];

    function onDocumentKeyDown(event: any): void {
        if (event.key === 'Escape') {
            removeEditMenu();
            return;
        }
        // 菜单是纯动作菜单：开始输入（焦点本就在输入框时没有 pointerdown 可依赖）
        // 菜单应随输入消失
        if (MODIFIER_KEYS.indexOf(event.key) !== -1) return;
        removeEditMenu();
    }

    // 部分输入法确认等输入事件不走常规 keydown 判定：beforeinput 兜底，
    // 即将插入文本即已开始编辑
    function onDocumentBeforeInput(_event: any): void {
        removeEditMenu();
    }

    // ── 长按手势状态机 ──────────────────────────────────────────────

    // 拦截触发后手指抬起产生的模拟事件序列；拦到 click 或超时即解除。
    // 序列含 pointerdown：Chromium 补发的模拟 pointerdown 不拦的话会立刻关掉
    // 刚弹出的编辑菜单（菜单外的 pointerdown 即关闭）。窗口收窄到 150ms：
    // 模拟序列在抬手后数帧内到达，而用户最快的手动点击也要 200ms 以上，
    // 避免刚弹出的编辑菜单首次点击被误拦。
    function armClickSuppress(): void {
        const types = ['pointerdown', 'mousedown', 'mouseup', 'click'];
        let done = false;
        let timeout: any = null;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            for (const type of types) {
                window.removeEventListener(type, handler, true);
            }
        };
        const handler = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.type === 'click') finish();
        };
        for (const type of types) {
            window.addEventListener(type, handler, true);
        }
        timeout = setTimeout(finish, SUPPRESS_MOUSE_MS);
    }

    function findTouch(touchList: any, identifier: number): any {
        if (!touchList) return null;
        for (let i = 0; i < touchList.length; i++) {
            if (touchList[i].identifier === identifier) return touchList[i];
        }
        return null;
    }

    let active: {
        touchId: number;
        startX: number;
        startY: number;
        curX: number;
        curY: number;
        showTimer: any;
        timer: any;
        ready: boolean;
        moved: boolean;
    } | null = null;

    function clearShowTimer(state: NonNullable<typeof active>): void {
        if (state.showTimer !== null) {
            clearTimeout(state.showTimer);
            state.showTimer = null;
        }
    }

    function onProgressDone(): void {
        if (!active) return;
        active.timer = null;
        active.ready = true;
        // 进度环已满（dashoffset 归 0）：保持满环等待手指松开，不立即触发
    }

    // 触发右键：在命中元素上派发合成 contextmenu（自绘菜单与页面菜单的唯一
    // 位置来源，局部坐标天然精确）
    function triggerRightClick(x: number, y: number): void {
        const target = elementAt(x, y) || document.body || document.documentElement;
        if (!target || typeof target.dispatchEvent !== 'function') return;
        try {
            const MouseEventCtor = window.MouseEvent || window.Event;
            target.dispatchEvent(
                new MouseEventCtor('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: x,
                    clientY: y,
                    button: 2,
                    buttons: 2
                })
            );
        } catch {
            /* 忽略派发失败 */
        }
    }

    function cancelPress(): void {
        if (active) {
            clearShowTimer(active);
            if (active.timer !== null) {
                clearTimeout(active.timer);
                active.timer = null;
            }
        }
        fadeOutIndicator();
    }

    function onTouchStart(event: any): void {
        if (active && active.ready) return;
        if (active) cancelPress();
        // 仅单指支持长按；多指视为缩放/双指手势
        if (!event.touches || event.touches.length !== 1) return;
        const touch = event.changedTouches && event.changedTouches[0];
        if (!touch) return;
        // 可编辑元素/可选文本区的长按：Chromium 会在按住 ~500ms 后进入文本
        // 选择手势并派发 touchcancel（此时不会再有 touchend）。圆环进度照常
        // 显示，touchcancel 时按移动意图判定为长按成立（无移动）或滚动接管
        // （有移动），见 onTouchEnd。
        active = {
            touchId: touch.identifier,
            startX: touch.clientX,
            startY: touch.clientY,
            curX: touch.clientX,
            curY: touch.clientY,
            showTimer: null,
            timer: null,
            ready: false,
            moved: false
        };
        // 按下不立即显示指示器（多数触摸是单击），延迟 120ms 后出现；
        // 触发计时从圆环显示时从 0 起算，进度环与定时严格同步。
        const state = active;
        state.showTimer = setTimeout(() => {
            if (active === state) {
                state.showTimer = null;
                showIndicator(state.curX, state.curY);
                state.timer = setTimeout(onProgressDone, LONG_PRESS_MS);
                // 长按候选态通知：Chromium 对可编辑元素的触摸长按会派发真实
                // contextmenu（随后弹主进程原生菜单，弹在系统光标位置）；主进程
                // 据此跳过原生菜单，把菜单位置交给本脚本的自绘编辑菜单。
                try {
                    const CustomEventCtor = window.CustomEvent || CustomEvent;
                    window.dispatchEvent(new CustomEventCtor(TOUCH_ACTIVE_EVENT));
                } catch {
                    /* 桥不可用不影响手势 */
                }
            }
        }, SHOW_DELAY_MS);
    }

    function onTouchMove(event: any): void {
        if (!active) return;
        const touch = findTouch(event.changedTouches, active.touchId);
        if (!touch) return;
        const dx = touch.clientX - active.startX;
        const dy = touch.clientY - active.startY;
        const distSq = dx * dx + dy * dy;
        // 有移动意图（滚动/拖拽）：记录，供 touchcancel 时区分「文本选择手势接管」
        if (distSq > MOVE_INTENT_SLOP_PX * MOVE_INTENT_SLOP_PX) {
            active.moved = true;
        }
        // 位移超过约手指半径视为拖动/滚动意图；容差内的移动跟随手指（就绪态同样有效）
        if (distSq > CANCEL_SLOP_PX * CANCEL_SLOP_PX) {
            cancelPress();
            active = null;
            return;
        }
        active.curX = touch.clientX;
        active.curY = touch.clientY;
        repositionIndicator(active.curX, active.curY);
    }

    function onTouchEnd(event: any): void {
        if (!active) return;
        const touch = findTouch(event.changedTouches, active.touchId);
        if (!touch) return;
        const state = active;
        clearShowTimer(state);
        if (state.timer !== null) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        active = null;
        if (event.type === 'touchcancel') {
            // Chromium 手势接管：无移动意图 = 文本选择手势（可编辑元素或可选文本区
            // 长按），视为长按成立，立即完成并弹菜单（此后不会再有 touchend）；
            // 有移动意图 = 滚动接管，正常取消。
            if (!state.moved) {
                completeIndicator();
                const target = elementAt(state.curX, state.curY);
                if (!isEditableElement(target)) clearPageSelection();
                triggerRightClick(state.curX, state.curY);
                armClickSuppress();
                return;
            }
            fadeOutIndicator();
            return;
        }
        const wasReady = state.ready;
        if (wasReady) {
            // 进度已满，等手指松开才触发右键；位置为最新手指位置。
            // 编辑区保留 Chromium 触摸长按产生的选词（自绘菜单的复制/剪切据此
            // 工作），非编辑区清掉杂散选区。
            completeIndicator();
            const target = elementAt(state.curX, state.curY);
            if (!isEditableElement(target)) clearPageSelection();
            triggerRightClick(state.curX, state.curY);
            armClickSuppress();
        } else {
            fadeOutIndicator();
        }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    document.addEventListener('contextmenu', onDocumentContextMenu, true);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    document.addEventListener('beforeinput', onDocumentBeforeInput);
}

/**
 * 注入主世界执行的脚本（幂等，重复执行无害）。
 * 控制器经 toString 序列化，注入后以无参形式调用。
 */
export const TOUCH_LONG_PRESS_SCRIPT = `(${createTouchLongPressController})();`;
