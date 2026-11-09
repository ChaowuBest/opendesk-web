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
`;

/**
 * 常驻于任务面板“工作空间”tab 底部的内置终端。
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
        this.resizeObserver = new ResizeObserver(() => this.handleHostResize());
        this.resizeObserver.observe(host);
        // 等宽字体加载完成后字符度量会变化：首次 open 与 fit 都要基于正确度量，
        // 否则按旧度量拟合的行数会溢出容器。
        void document.fonts?.ready.then(() => {
            this.openTerminal();
            this.resizeTerminal();
        });
        // 延迟到宿主 setTaskId 同步完成后，首次启动即落在任务工作区。
        // 用微任务而非 rAF：后台页面（窗口被遮挡/最小化，Electron
        // backgroundThrottling）会冻结渲染帧，rAF 回调永不执行，
        // profile 加载被卡死 → sessionId 恒为 null → 终端黑屏且无法输入。
        queueMicrotask(() => {
            if (this.isConnected) void this.loadProfiles();
        });
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    disconnectedCallback(): void {
        this.stopDrag(false);
        this.dataUnsubscribe?.();
        this.exitUnsubscribe?.();
        this.resizeObserver?.disconnect();
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.dataUnsubscribe = null;
        this.exitUnsubscribe = null;
        this.resizeObserver = null;
        void this.closeSession();
        this.terminal.dispose();
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
                role="separator" aria-orientation="horizontal" aria-label="${this.t('renderer.taskTerminal.resize')}"></div>
            <section class="task-terminal" data-task-terminal>
                <div class="task-terminal-bar">
                    <span class="task-terminal-title">
                        <i class="fa-solid fa-terminal" aria-hidden="true"></i>
                        <span>${this.t('renderer.taskTerminal.title')}</span>
                    </span>
                    <span class="task-terminal-status" data-task-terminal-status>${this.t('renderer.taskTerminal.closed')}</span>
                    <div class="task-terminal-actions">
                        <select data-task-terminal-profile aria-label="${this.t('renderer.taskTerminal.profile')}"></select>
                    </div>
                </div>
                <div class="task-terminal-body" style="height: ${this.currentHeight}px">
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

    private async restartSession(): Promise<void> {
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
