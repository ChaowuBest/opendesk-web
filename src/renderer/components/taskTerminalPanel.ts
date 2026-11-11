/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import xtermStyles from '@xterm/xterm/css/xterm.css?inline';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { createRendererTranslator } from '../locale.js';

type TerminalProfile = Awaited<ReturnType<Window['terminalAPI']['listProfiles']>>[number];

const PROFILE_LABELS: Record<TerminalProfile['kind'], string> = {
    powershell: 'renderer.terminal.profile.powershell',
    bash: 'renderer.terminal.profile.bash',
    zsh: 'renderer.terminal.profile.zsh',
    cmd: 'renderer.terminal.profile.cmd'
};

const DEFAULT_TERMINAL_HEIGHT = 220;
const MIN_TERMINAL_HEIGHT = 120;
/** 拖高终端时为上方内容（文件树）保留的最小高度。 */
const MIN_SIBLING_HEIGHT = 120;
const HEIGHT_STORAGE_KEY = 'od-task-terminal-height';

function loadTerminalHeight(): number {
    try {
        const raw = window.localStorage?.getItem(HEIGHT_STORAGE_KEY);
        const value = raw ? Number(raw) : Number.NaN;
        if (!Number.isFinite(value)) return DEFAULT_TERMINAL_HEIGHT;
        return Math.min(Math.max(value, MIN_TERMINAL_HEIGHT), 2000);
    } catch {
        return DEFAULT_TERMINAL_HEIGHT;
    }
}

// 面板常驻 taskartifacts 的 shadow 树内，document head 的样式无法穿透 shadow 边界：
// xterm 基础样式必须以 ?inline 文本随面板 <style> 注入，否则 .xterm-viewport /
// .xterm-screen canvas 失去绝对定位，canvas 层错位被裁剪，表现为输入命令后内容不显示。
// 组件自身是 light DOM，这里不能用 :host —— 它会错配外层宿主 taskartifacts，
// 覆盖其 display:flex 布局；面板布局由 taskartifacts 的样式规则提供。
const PANEL_CSS = `
    ${xtermStyles}
    .task-terminal-resizer { position: relative; z-index: 5; height: 6px; margin-bottom: 3px; border-radius: 3px; background: transparent; cursor: row-resize; touch-action: none; }
    .task-terminal-resizer:hover, .task-terminal-resizer[dragging] { background: var(--od-accent, #4267b2); }
    .task-terminal-resizer::after { content: ''; position: absolute; left: 0; right: 0; top: -4px; bottom: -4px; }
    .task-terminal { border: 1px solid var(--od-border, #e5e7eb); border-radius: 10px; overflow: hidden; background: #101216; }
    .task-terminal-bar { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 4px 8px; background: var(--od-bg-elevated, #fff); border-bottom: 1px solid var(--od-border, #e5e7eb); }
    .task-terminal-title { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; color: var(--od-text, #374151); font-size: 12px; font-weight: 600; }
    .task-terminal-title i { color: var(--od-accent, #4267b2); }
    .task-terminal-status { flex: 1; min-width: 0; overflow: hidden; color: var(--od-text-muted, #6b7280); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .task-terminal-actions { display: flex; align-items: center; gap: 5px; margin-left: auto; }
    .task-terminal-actions select { height: 26px; max-width: 150px; padding: 0 5px; border: 1px solid var(--od-border-strong, #d1d5db); border-radius: 5px; background: var(--od-bg-elevated, #fff); color: var(--od-text, #374151); font: inherit; font-size: 11px; }
    .task-terminal-actions select:disabled { cursor: wait; opacity: .5; }
    .task-terminal-body { position: relative; height: 220px; padding: 6px 8px; box-sizing: border-box; }
    .task-terminal-host { width: 100%; height: 100%; overflow: hidden; }
    .task-terminal-message { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; background: #101216; color: #aab2c0; text-align: center; font-size: 12px; }
    .task-terminal-message.error { color: #fca5a5; }
    /* 上面的 display:grid 是作者源声明，恒覆盖 UA 样式表的 [hidden]{display:none}
       （hidden 属性只通过 UA 样式表生效）——空消息遮罩会从挂载起永久可见：
       纯黑背景盖住终端主体，absolute 定位还截获 mousedown 使 terminal.focus()
       永不触发（黑屏 + 输入无响应）。必须用同源规则显式恢复 hidden 语义。 */
    .task-terminal-message[hidden] { display: none !important; }
    .task-terminal-actions button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid var(--od-border-strong, #d1d5db); border-radius: 5px; background: var(--od-bg-elevated, #fff); color: var(--od-text, #374151); font: inherit; font-size: 11px; cursor: pointer; }
    .task-terminal-actions button:hover { background: var(--od-bg-hover, #f3f4f6); }
    /* 收起态依赖 [hidden] 折叠 body/resizer：作者源一旦为二者声明 display，
       将恒覆盖 UA 样式表的 [hidden]{display:none}（message 遮罩黑屏 bug 同构陷阱），
       必须用同源规则显式恢复 hidden 语义。 */
    .task-terminal-body[hidden] { display: none !important; }
    .task-terminal-resizer[hidden] { display: none !important; }
`;

// ── 终端专属右键菜单 ─────────────────────────────────────────────
// xterm 的选区在内部模型（非 DOM 选区），全局自绘编辑菜单（touchLongPressScript）
// 判定不了；xterm 右键还会把隐藏 helper textarea 停靠到指针处（下一次右键会被
// 误判为编辑区）。全局脚本已对 .xterm 表面放行，右键菜单由本面板自绘。
// 菜单挂 document.body、样式注入 document.head：面板位于 taskartifacts 的
// shadow 树内，面板内挂载会受 .task-terminal 的 overflow 裁剪且随 innerHTML
// 重绘丢失；多面板实例共享同一份样式（按 id 幂等注入）。
const TERMINAL_MENU_STYLE_ID = 'od-task-terminal-menu-style';

const TERMINAL_MENU_ICONS: Record<string, string> = {
    // 图标与 touchLongPressScript 自绘编辑菜单同风格（14px line 图标）
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 2h6v4H9z"/></svg>',
    selectAll:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 3"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5.6 13.5 5-5a2 2 0 0 1 2.8 0l3.1 3.1a2 2 0 0 1 0 2.8l-5 5a2 2 0 0 1-2.8 0l-3.1-3.1a2 2 0 0 1 0-2.8z"/><path d="M7 21h12"/></svg>'
};

const TERMINAL_MENU_CSS = [
    // 视觉对齐公共 ctx-menu 与自绘编辑菜单：同一套 --ctx-* 变量，
    // 深浅色主题随 html[data-theme='dark'] 自动切换。
    '.od-task-terminal-menu {',
    '    position: fixed;',
    '    inset: auto;',
    '    margin: 0;',
    '    z-index: 2147483646;',
    '    min-width: 150px;',
    '    padding: 5px;',
    '    background: var(--ctx-bg, #ffffff);',
    '    border: 1px solid var(--ctx-border, #e7e5e2);',
    '    border-radius: 12px;',
    '    box-shadow: var(--ctx-shadow, 0 1px 2px rgba(28, 25, 23, 0.04), 0 4px 14px rgba(28, 25, 23, 0.07));',
    '    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);',
    '    animation: od-task-terminal-menu-fade-in 0.2s ease-out;',
    '}',
    '@keyframes od-task-terminal-menu-fade-in {',
    '    from { opacity: 0; transform: scale(0.97) translateY(-3px); }',
    '    to { opacity: 1; transform: scale(1) translateY(0); }',
    '}',
    '.od-task-terminal-menu .od-task-terminal-menu-item {',
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
    '.od-task-terminal-menu .od-task-terminal-menu-item:hover {',
    '    background: var(--ctx-hover, #f0efec);',
    '    color: var(--ctx-ink, #1c1917);',
    '}',
    '.od-task-terminal-menu .od-task-terminal-menu-icon {',
    '    display: inline-flex;',
    '    align-items: center;',
    '    justify-content: center;',
    '    width: 14px;',
    '    height: 14px;',
    '    flex: none;',
    '    color: var(--ctx-ink3, #8a8580);',
    '}',
    // 无选区的复制 / 无会话的粘贴不适用，置灰
    '.od-task-terminal-menu .od-task-terminal-menu-item.disabled {',
    '    opacity: 0.45;',
    '    pointer-events: none;',
    '}',
    '.od-task-terminal-menu .od-task-terminal-menu-divider {',
    '    height: 1px;',
    '    margin: 4px 6px;',
    '    background: var(--ctx-sep, #efeeea);',
    '}'
].join('\n');

function ensureTerminalMenuStyle(): void {
    if (document.getElementById(TERMINAL_MENU_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = TERMINAL_MENU_STYLE_ID;
    style.textContent = TERMINAL_MENU_CSS;
    (document.head || document.documentElement).appendChild(style);
}

/**
 * 常驻于任务面板“工作空间”tab 底部的内置终端。
 * 默认收起：挂载后只显示标题栏、不建立会话，用户展开（toggle）才建联；收起不销毁会话。
 * 目录不提供手动选择：始终由主进程按任务工作区解析（回落全局工作区）。
 */
export class TaskTerminalPanel extends HTMLElement {
    private readonly t = createRendererTranslator();
    private readonly terminal = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        scrollback: 4000,
        theme: { background: '#101216', foreground: '#e5e7eb', cursor: '#93c5fd' }
    });
    private readonly fitAddon = new FitAddon();
    private profiles: TerminalProfile[] = [];
    private sessionId: string | null = null;
    private profileId = '';
    private taskId = '';
    private taskWorkspace = '';
    private generation = 0;
    private dataUnsubscribe: (() => void) | null = null;
    private exitUnsubscribe: (() => void) | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private statusElement: HTMLElement | null = null;
    private profileSelect: HTMLSelectElement | null = null;
    private messageElement: HTMLElement | null = null;
    private resizerElement: HTMLElement | null = null;
    private opened = false;
    private currentHeight = loadTerminalHeight();
    private dragPointerId: number | null = null;
    private dragStartY = 0;
    private dragStartHeight = 0;
    private dragMaxHeight = Number.POSITIVE_INFINITY;
    /** 实验性功能（builtin_terminal）开关状态：设置读取完成前视为关闭。 */
    private featureEnabled = false;
    private settingUnsubscribe: (() => void) | null = null;
    /** 默认收起：只显示标题栏、不建联，用户展开（toggle）才建联；收起不销毁已有会话。 */
    private collapsed = true;
    /** 会话建立时的上下文快照：收起期间上下文变化不立即生效（会话保活），
     * 展开时与当前值比对，不一致才按新上下文重建；切回原值则无感保留。 */
    private sessionProfileId = '';
    private sessionTaskId = '';
    private sessionWorkspace = '';
    /** 终端专属右键菜单（挂 document.body）：null 表示当前未显示。 */
    private menuElement: HTMLElement | null = null;
    private menuDismissPointerHandler: ((event: Event) => void) | null = null;
    private menuDismissKeyHandler: ((event: KeyboardEvent) => void) | null = null;

    // 拖拽监听挂在 window 上（指针可能移出面板甚至窗口），以 pointerId 过滤多指。
    private readonly onDragPointerMove = (event: PointerEvent): void => {
        if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) return;
        event.preventDefault();
        this.applyHeight(this.dragStartHeight + (this.dragStartY - event.clientY));
    };

    private readonly onDragPointerEnd = (event: PointerEvent): void => {
        if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) return;
        this.stopDrag();
    };

    // 后台页面（窗口遮挡/最小化）的 ResizeObserver 回调同样被冻结：
    // hidden 期间切换 tab 的 display 变化不会补发 resize。恢复可见时
    // 兜底补启动尚未建立的会话；已有会话则不动（防切窗丢会话）。
    private readonly onVisibilityChange = (): void => {
        if (document.visibilityState !== 'visible') return;
        if (this.sessionId || !this.profileId) return;
        if (!this.isTerminalVisible()) return;
        void this.restartSession();
    };

    connectedCallback(): void {
        this.render();
        this.terminal.loadAddon(this.fitAddon);
        const host = this.querySelector<HTMLElement>('[data-task-terminal-host]');
        if (!host) return;
        // 宿主 tab 用 display:none 切换，面板挂载时可能不可见；xterm 在隐藏容器上
        // open 会导致字符测量失败、后续渲染错乱（表现为黑屏），因此推迟到 openTerminal。
        this.dataUnsubscribe = window.terminalAPI.onData((event) => {
            if (event.sessionId !== this.sessionId) return;
            this.terminal.write(event.data);
            // Report consumption so the main process can resume a paused PTY.
            void window.terminalAPI.acknowledge(event.sessionId, event.data.length).catch(() => undefined);
        });
        this.exitUnsubscribe = window.terminalAPI.onExit((event) => {
            if (event.sessionId !== this.sessionId) return;
            this.sessionId = null;
            this.setStatus(this.t('renderer.taskTerminal.exited', { code: event.exitCode }));
        });
        this.terminal.onData((data) => {
            if (this.sessionId) {
                void window.terminalAPI.write(this.sessionId, data).catch((error) => this.showError(error));
            }
        });
        this.terminal.onResize(({ cols, rows }) => {
            if (this.sessionId) void window.terminalAPI.resize(this.sessionId, cols, rows).catch(() => undefined);
        });
        host.addEventListener('mousedown', () => {
            if (this.opened) this.terminal.focus();
        });
        // 终端表面右键弹面板自绘菜单（全局 touchLongPressScript 已对 .xterm 放行）
        host.addEventListener('contextmenu', (event) => this.handleContextMenu(event));
        this.resizeObserver = new ResizeObserver(() => this.handleHostResize());
        this.resizeObserver.observe(host);
        // 等宽字体加载完成后字符度量会变化：首次 open 与 fit 都要基于正确度量，
        // 否则按旧度量拟合的行数会溢出容器。
        void document.fonts?.ready.then(() => {
            this.openTerminal();
            this.resizeTerminal();
        });
        // 实验性功能门禁（默认关闭）：设置读取完成前不加载 profile、不建立会话。
        // 读取走 IPC、晚于宿主 setTaskContext 的同步调用，首次启动仍落在任务工作区；
        // 后台页面（backgroundThrottling）冻结渲染帧不影响 IPC，原 rAF 卡死问题不会复发。
        void this.setupBuiltinTerminalFeature();
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    disconnectedCallback(): void {
        this.closeMenu();
        this.stopDrag(false);
        this.dataUnsubscribe?.();
        this.exitUnsubscribe?.();
        this.settingUnsubscribe?.();
        this.resizeObserver?.disconnect();
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.dataUnsubscribe = null;
        this.exitUnsubscribe = null;
        this.settingUnsubscribe = null;
        this.resizeObserver = null;
        void this.closeSession();
        this.terminal.dispose();
    }

    /**
     * 实验性功能门禁（debug.experimental_features.builtin_terminal，默认关闭）。
     * 隔离必须用内联 style.display：宿主 taskartifacts 对本元素声明了
     * display:block 作者样式，恒覆盖 hidden 属性的 UA 规则（黑屏 bug 同构陷阱）。
     * 读取失败保持隐藏，与 homepage 的 immersive_desktop 消费模式一致。
     */
    private async setupBuiltinTerminalFeature(): Promise<void> {
        try {
            const setting = await window.settingAPI?.loadSettingObject?.();
            if (!this.isConnected) return;
            await this.applyExperimentalFeature(setting);
        } catch {
            // 读取设置失败时保持隐藏（默认关闭），不阻断面板其余初始化。
        }
        try {
            this.settingUnsubscribe =
                (await window.settingAPI?.onSettingChanged?.((setting) => {
                    void this.applyExperimentalFeature(setting);
                })) ?? null;
        } catch {
            // 订阅失败时忽略：仅失去动态切换能力，面板维持当前状态。
        }
    }

    private async applyExperimentalFeature(setting: unknown): Promise<void> {
        const enabled =
            (setting as { debug?: { experimental_features?: { builtin_terminal?: boolean } } } | null | undefined)
                ?.debug?.experimental_features?.builtin_terminal === true;
        this.featureEnabled = enabled;
        this.style.display = enabled ? '' : 'none';
        if (!enabled) {
            // 关闭时使在途 restartSession 失效并停掉已有会话，避免后台 PTY 进程泄漏。
            this.generation++;
            await this.closeSession();
            return;
        }
        // 开启时按需补启动：profile 未加载（此前被门禁拦截）则加载；
        // 已加载但无会话（关闭期间被清理）且当前可见则重启。
        if (!this.profileId) {
            await this.loadProfiles();
        } else if (this.isTerminalVisible() && !this.sessionId) {
            await this.restartSession();
        }
    }

    setTaskContext(taskId: string, workspace?: string): void {
        const taskChanged = taskId !== this.taskId;
        this.taskId = taskId;
        if (workspace) this.setTaskWorkspace(workspace);
        if (taskChanged && this.sessionId) void this.restartSession();
    }

    setTaskWorkspace(workspace: string): void {
        if (!workspace || workspace === this.taskWorkspace) return;
        this.taskWorkspace = workspace;
        if (this.sessionId) void this.restartSession();
    }

    private render(): void {
        this.innerHTML = `
            <style>${PANEL_CSS}</style>
            <div class="task-terminal-resizer" data-task-terminal-resizer data-od-no-longpress="1"
                role="separator" aria-orientation="horizontal" aria-label="${this.t('renderer.taskTerminal.resize')}"${this.collapsed ? ' hidden' : ''}></div>
            <section class="task-terminal" data-task-terminal>
                <div class="task-terminal-bar">
                    <span class="task-terminal-title">
                        <i class="fa-solid fa-terminal" aria-hidden="true"></i>
                        <span>${this.t('renderer.taskTerminal.title')}</span>
                    </span>
                    <span class="task-terminal-status" data-task-terminal-status>${this.t('renderer.taskTerminal.closed')}</span>
                    <div class="task-terminal-actions">
                        <select data-task-terminal-profile aria-label="${this.t('renderer.taskTerminal.profile')}"></select>
                        <button type="button" class="task-terminal-toggle" data-task-terminal-toggle
                            aria-expanded="${this.collapsed ? 'false' : 'true'}"
                            title="${this.t('renderer.taskTerminal.expand')}"
                            aria-label="${this.t('renderer.taskTerminal.expand')}">
                            <i class="fa-solid ${this.collapsed ? 'fa-chevron-up' : 'fa-chevron-down'}" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
                <div class="task-terminal-body" style="height: ${this.currentHeight}px"${this.collapsed ? ' hidden' : ''}>
                    <div class="task-terminal-host" data-task-terminal-host></div>
                    <div class="task-terminal-message" data-task-terminal-message hidden></div>
                </div>
            </section>
        `;
        this.statusElement = this.querySelector('[data-task-terminal-status]');
        this.profileSelect = this.querySelector('[data-task-terminal-profile]');
        this.messageElement = this.querySelector('[data-task-terminal-message]');
        this.resizerElement = this.querySelector('[data-task-terminal-resizer]');
        // 触摸拖动不派发 mousemove，必须走 pointer 事件；stopPropagation 避免触发焦点转移。
        this.resizerElement?.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            this.startDrag(event.pointerId, event.clientY);
        });
        this.profileSelect?.addEventListener('change', () => {
            this.profileId = this.profileSelect?.value || '';
            void this.restartSession();
        });
        this.querySelector('[data-task-terminal-toggle]')?.addEventListener('click', () => this.toggleCollapsed());
    }

    private startDrag(pointerId: number, startClientY: number): void {
        this.dragPointerId = pointerId;
        this.dragStartY = startClientY;
        this.dragStartHeight = this.currentHeight;
        // 手柄不能越过宿主容器顶部：为上方内容（文件树）至少保留 MIN_SIBLING_HEIGHT。
        const panelTop = this.getBoundingClientRect().top;
        const containerTop = this.parentElement?.getBoundingClientRect().top ?? panelTop;
        const growable = Math.max(0, panelTop - containerTop) - MIN_SIBLING_HEIGHT;
        this.dragMaxHeight = Math.max(this.dragStartHeight, this.dragStartHeight + growable);
        this.resizerElement?.setAttribute('dragging', '');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', this.onDragPointerMove);
        window.addEventListener('pointerup', this.onDragPointerEnd);
        window.addEventListener('pointercancel', this.onDragPointerEnd);
    }

    private stopDrag(persist = true): void {
        if (this.dragPointerId === null) return;
        this.dragPointerId = null;
        this.dragMaxHeight = Number.POSITIVE_INFINITY;
        this.resizerElement?.removeAttribute('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', this.onDragPointerMove);
        window.removeEventListener('pointerup', this.onDragPointerEnd);
        window.removeEventListener('pointercancel', this.onDragPointerEnd);
        if (persist) {
            try {
                window.localStorage?.setItem(HEIGHT_STORAGE_KEY, String(this.currentHeight));
            } catch {
                // file:// 下 localStorage 可能受限，高度不持久化即可。
            }
            // 测试/隐藏环境下 ResizeObserver 可能不回调，显式重新拟合一次。
            this.resizeTerminal();
        }
    }

    private applyHeight(height: number): void {
        this.currentHeight = Math.round(Math.min(Math.max(height, MIN_TERMINAL_HEIGHT), this.dragMaxHeight));
        const body = this.querySelector<HTMLElement>('.task-terminal-body');
        if (body) body.style.height = `${this.currentHeight}px`;
    }

    private async loadProfiles(): Promise<void> {
        // 实验性功能未开启时不加载（面板保持隐藏，设置读取完成后由门禁补调）。
        if (!this.featureEnabled) return;
        try {
            this.profiles = await window.terminalAPI.listProfiles();
            if (this.profiles.length === 0) {
                this.showMessage(this.t('renderer.taskTerminal.unavailable'));
                return;
            }
            this.profileId = this.profileId || this.profiles[0].id;
            this.profileSelect!.innerHTML = this.profiles
                .map(
                    (profile) =>
                        `<option value="${this.escape(profile.id)}">${this.escape(this.t(PROFILE_LABELS[profile.kind]))}</option>`
                )
                .join('');
            this.profileSelect!.value = this.profileId;
            // 可见时立即拉起会话；不可见时等 ResizeObserver 在 tab 首次激活时拉起。
            if (this.isTerminalVisible()) await this.restartSession();
        } catch (error) {
            this.showError(error);
        }
    }

    /** 面板尺寸变化（tab 激活、窗口缩放）时重新拟合；首次可见时自动拉起会话。 */
    private handleHostResize(): void {
        if (!this.isTerminalVisible()) return;
        this.openTerminal();
        this.resizeTerminal();
        if (!this.sessionId && this.profileId) void this.restartSession();
    }

    /** xterm 只能在可见容器上 open（幂等）；不可见时由 ResizeObserver 在激活后再触发。 */
    private openTerminal(): void {
        if (this.opened) return;
        const host = this.querySelector<HTMLElement>('[data-task-terminal-host]');
        if (!host || !this.isTerminalVisible()) return;
        this.opened = true;
        this.terminal.open(host);
    }

    private isTerminalVisible(): boolean {
        const host = this.querySelector<HTMLElement>('[data-task-terminal-host]');
        return !!host && host.getBoundingClientRect().height > 0;
    }

    /** 收起/展开终端主体。收起只折叠 UI，不销毁会话（后台命令继续跑）；展开是建联的唯一主动入口。 */
    private toggleCollapsed(): void {
        this.collapsed = !this.collapsed;
        this.applyCollapsedState();
        if (this.collapsed) return;
        // 展开走局部更新而非重绘 render：已 open 的 xterm 实例挂在旧 host 上，
        // 重绘 innerHTML 会使其脱挂（黑屏）。这里直接补 open/fit 并按需建联；
        // host 几何不可见（tab 未激活）时留待 visibilitychange / resize 兜底。
        this.openTerminal();
        this.resizeTerminal();
        // 按需建联覆盖两种情况：尚无会话（首次展开），或收起期间上下文
        // （profile/任务/工作区）已变而会话还活着——后者按新上下文重建。
        if (
            this.featureEnabled &&
            this.profileId &&
            (!this.sessionId || this.isSessionStale()) &&
            this.isTerminalVisible()
        ) {
            void this.restartSession();
        }
    }

    /** 会话建立时的上下文快照与当前值不一致：视为过期（收起期间被切换过），需按新上下文重建。 */
    private isSessionStale(): boolean {
        return (
            this.profileId !== this.sessionProfileId ||
            this.taskId !== this.sessionTaskId ||
            this.taskWorkspace !== this.sessionWorkspace
        );
    }

    private applyCollapsedState(): void {
        const toggle = this.querySelector<HTMLElement>('[data-task-terminal-toggle]');
        if (toggle) {
            const label = this.t(this.collapsed ? 'renderer.taskTerminal.expand' : 'renderer.taskTerminal.collapse');
            toggle.setAttribute('aria-expanded', this.collapsed ? 'false' : 'true');
            toggle.setAttribute('title', label);
            toggle.setAttribute('aria-label', label);
            const icon = toggle.querySelector('i');
            if (icon) icon.className = `fa-solid ${this.collapsed ? 'fa-chevron-up' : 'fa-chevron-down'}`;
        }
        const body = this.querySelector<HTMLElement>('.task-terminal-body');
        for (const element of [this.resizerElement, body]) {
            if (!element) continue;
            if (this.collapsed) element.setAttribute('hidden', '');
            else element.removeAttribute('hidden');
        }
    }

    private async restartSession(): Promise<void> {
        // 实验性功能未开启或面板收起时不建立会话（visibilitychange / resize /
        // 任务切换 / profile 切换等兜底都被拦截）：建联的唯一主动路径是用户展开。
        if (!this.featureEnabled || this.collapsed) return;
        const generation = ++this.generation;
        await this.closeSession();
        if (generation !== this.generation || !this.profileId) return;
        this.terminal.reset();
        this.hideMessage();
        this.setStatus(this.t('renderer.taskTerminal.starting'));
        try {
            this.openTerminal();
            this.resizeTerminal();
            const session = await window.terminalAPI.create({
                profileId: this.profileId,
                taskId: this.taskId || undefined,
                cols: this.terminal.cols,
                rows: this.terminal.rows
            });
            if (generation !== this.generation) {
                await window.terminalAPI.close(session.sessionId).catch(() => undefined);
                return;
            }
            // The PTY spawns only now: the first prompt needs a registered consumer.
            await window.terminalAPI.start(session.sessionId);
            if (generation !== this.generation) {
                await window.terminalAPI.close(session.sessionId).catch(() => undefined);
                return;
            }
            this.sessionId = session.sessionId;
            // 记录会话建立时的上下文快照：收起期间上下文再变，展开时据此判定过期。
            this.sessionProfileId = this.profileId;
            this.sessionTaskId = this.taskId;
            this.sessionWorkspace = this.taskWorkspace;
            this.setStatus(
                session.backend === 'pty'
                    ? this.t('renderer.taskTerminal.ready')
                    : this.t('renderer.taskTerminal.compatibility')
            );
        } catch (error) {
            this.showError(error);
        }
    }

    private async closeSession(): Promise<void> {
        const sessionId = this.sessionId;
        this.sessionId = null;
        if (sessionId) await window.terminalAPI.close(sessionId).catch(() => undefined);
    }

    private resizeTerminal(): void {
        // fit 依赖已渲染的字符度量，open 之前无法拟合。
        if (!this.opened) return;
        try {
            this.fitAddon.fit();
        } catch {
            return;
        }
        if (this.sessionId) {
            void window.terminalAPI
                .resize(this.sessionId, this.terminal.cols, this.terminal.rows)
                .catch(() => undefined);
        }
    }

    /** 终端表面右键：弹面板自绘菜单并抑制原生菜单；未 open（首次可见前的窗口期）放行默认行为。 */
    private handleContextMenu(event: MouseEvent): void {
        if (!this.opened) return;
        if (event.cancelable) event.preventDefault();
        this.openMenu(event.clientX, event.clientY);
    }

    private openMenu(x: number, y: number): void {
        this.closeMenu();
        ensureTerminalMenuStyle();
        const menu = document.createElement('div');
        menu.className = 'od-task-terminal-menu';
        menu.setAttribute('role', 'menu');
        // 复制随选区启停（xterm 选区在内部模型，只能经 hasSelection 判定）；
        // 粘贴需有会话承接输入；全选/清屏恒可用。
        const items: Array<{
            action: string;
            label: string;
            disabled: boolean;
            divider?: boolean;
            run: () => void;
        }> = [
            {
                action: 'copy',
                label: this.t('renderer.taskTerminal.menu.copy'),
                disabled: !this.terminal.hasSelection(),
                run: () => void this.copySelection()
            },
            {
                action: 'paste',
                label: this.t('renderer.taskTerminal.menu.paste'),
                disabled: !this.sessionId,
                run: () => void this.pasteFromClipboard()
            },
            {
                action: 'selectAll',
                label: this.t('renderer.taskTerminal.menu.selectAll'),
                disabled: false,
                run: () => this.terminal.selectAll()
            },
            {
                action: 'clear',
                label: this.t('renderer.taskTerminal.menu.clear'),
                disabled: false,
                divider: true,
                run: () => this.terminal.clear()
            }
        ];
        for (const item of items) {
            if (item.divider) {
                const divider = document.createElement('div');
                divider.className = 'od-task-terminal-menu-divider';
                menu.appendChild(divider);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'od-task-terminal-menu-item' + (item.disabled ? ' disabled' : '');
            button.setAttribute('data-action', item.action);
            button.setAttribute('role', 'menuitem');
            const icon = document.createElement('span');
            icon.className = 'od-task-terminal-menu-icon';
            icon.innerHTML = TERMINAL_MENU_ICONS[item.action];
            const label = document.createElement('span');
            label.className = 'od-task-terminal-menu-label';
            label.textContent = item.label;
            button.appendChild(icon);
            button.appendChild(label);
            // 阻止焦点转移：保持 xterm helper textarea 的焦点与选区
            button.addEventListener('pointerdown', (e) => e.preventDefault());
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (item.disabled) return;
                this.closeMenu();
                this.terminal.focus();
                item.run();
            });
            menu.appendChild(button);
        }
        (document.body || document.documentElement).appendChild(menu);
        // 放入浏览器 top layer：popover 层级高于任何 z-index 的浮层（任务视图内
        // 的搜索浮层、模态等），保证菜单始终置顶。宿主不支持 popover 时退回固定 z-index。
        try {
            if (typeof (menu as unknown as { showPopover?: () => void }).showPopover === 'function') {
                menu.setAttribute('popover', 'manual');
                (menu as unknown as { showPopover: () => void }).showPopover();
            }
        } catch {
            /* 降级为普通层 */
        }
        // 视口内定位（先挂载再量尺寸；测试/无 innerWidth 环境直接用触发点）
        const menuWidth = menu.offsetWidth || 150;
        const menuHeight = menu.offsetHeight || 120;
        let left = x;
        let top = y;
        if (typeof window.innerWidth === 'number' && window.innerWidth > 0) {
            left = Math.max(4, Math.min(x, window.innerWidth - menuWidth - 4));
            top = Math.max(4, Math.min(y, window.innerHeight - menuHeight - 4));
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        this.menuElement = menu;
        this.menuDismissPointerHandler = (event) => {
            const target = event.target as HTMLElement | null;
            if (target && typeof target.closest === 'function' && target.closest('.od-task-terminal-menu')) {
                return;
            }
            this.closeMenu();
        };
        document.addEventListener('pointerdown', this.menuDismissPointerHandler, true);
        this.menuDismissKeyHandler = (event) => {
            if (event.key === 'Escape') this.closeMenu();
        };
        document.addEventListener('keydown', this.menuDismissKeyHandler, true);
    }

    private closeMenu(): void {
        if (this.menuDismissPointerHandler) {
            document.removeEventListener('pointerdown', this.menuDismissPointerHandler, true);
            this.menuDismissPointerHandler = null;
        }
        if (this.menuDismissKeyHandler) {
            document.removeEventListener('keydown', this.menuDismissKeyHandler, true);
            this.menuDismissKeyHandler = null;
        }
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
    }

    private async copySelection(): Promise<void> {
        const text = this.terminal.getSelection();
        if (!text) return;
        try {
            await navigator.clipboard?.writeText(text);
        } catch {
            // 剪贴板不可用时静默
        }
    }

    private async pasteFromClipboard(): Promise<void> {
        try {
            // 读取优先走 preload 剪贴板桥（沙箱渲染器的 navigator.clipboard.readText
            // 不可靠，主进程代执行 IPC 与自绘编辑菜单同一通道）
            const bridge = window.childFrameClipboard;
            const text = bridge ? await bridge.readText() : ((await navigator.clipboard?.readText?.()) ?? '');
            // paste 由 xterm 处理括号粘贴模式等转义后写入会话
            if (text) this.terminal.paste(text);
        } catch {
            // 剪贴板不可用时静默
        }
    }

    private setStatus(text: string): void {
        if (this.statusElement) this.statusElement.textContent = text;
    }

    private showMessage(text: string, error = false): void {
        if (!this.messageElement) return;
        this.messageElement.hidden = false;
        this.messageElement.textContent = text;
        this.messageElement.classList.toggle('error', error);
    }

    private hideMessage(): void {
        if (this.messageElement) this.messageElement.hidden = true;
    }

    private showError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(message);
        this.showMessage(message, true);
    }

    private escape(value: string): string {
        return value.replace(
            /[&<>"']/g,
            (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
        );
    }
}

customElements.define('task-terminal-panel', TaskTerminalPanel);
