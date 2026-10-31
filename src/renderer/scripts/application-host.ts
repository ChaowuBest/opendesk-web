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
 * 子应用 iframe 宿主：主题初始化 → 动态加载 entry → 挂载 entry-widget。
 */

import Alpine from 'alpinejs';
import { installApplicationFrameProxies } from './application-frame-proxy.js';
import { initApplicationThemeHost, initApplicationThemeFromAPI } from '../theme/theme-iframe-bridge.js';
import { createRendererTranslator } from '../locale.js';
import { ApplicationTaskSession } from './application-task-session.js';

/** 将 iframe 内键盘/鼠标事件转发给父窗口，使父窗口的输入监听在子应用中仍能生效 */
function installParentInputForwarding(): void {
    if (window.parent === window) {
        return;
    }

    const forwardKeyboardEvent = (type: 'keydown' | 'keyup', e: KeyboardEvent) => {
        const isPlainTab = e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (isPlainTab) {
            return;
        }

        parent.document.dispatchEvent(
            new KeyboardEvent(type, {
                key: e.key,
                code: e.code,
                bubbles: true,
                cancelable: true,
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                repeat: e.repeat
            })
        );
    };
    document.addEventListener('keydown', (e) => forwardKeyboardEvent('keydown', e));
    document.addEventListener('keyup', (e) => forwardKeyboardEvent('keyup', e));

    let iframeOffsetX = 0;
    let iframeOffsetY = 0;
    function updateIframeOffset(): void {
        const rect = window.frameElement?.getBoundingClientRect();
        if (rect) {
            iframeOffsetX = rect.left;
            iframeOffsetY = rect.top;
        }
    }
    updateIframeOffset();
    window.addEventListener('resize', updateIframeOffset);

    function forwardMouseEvent(type: string, e: MouseEvent): void {
        parent.document.dispatchEvent(
            new MouseEvent(type, {
                clientX: e.clientX + iframeOffsetX,
                clientY: e.clientY + iframeOffsetY,
                screenX: e.screenX,
                screenY: e.screenY,
                button: e.button,
                buttons: e.buttons,
                bubbles: true,
                cancelable: true,
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey
            })
        );
    }
    let pendingMouseMove: MouseEvent | null = null;
    let mousemoveRafId: number | null = null;
    document.addEventListener('mousemove', (e) => {
        pendingMouseMove = e;
        if (!mousemoveRafId) {
            mousemoveRafId = requestAnimationFrame(() => {
                mousemoveRafId = null;
                if (pendingMouseMove) {
                    forwardMouseEvent('mousemove', pendingMouseMove);
                    pendingMouseMove = null;
                }
            });
        }
    });
    document.addEventListener('mousedown', (e) => forwardMouseEvent('mousedown', e));
    document.addEventListener('mouseup', (e) => forwardMouseEvent('mouseup', e));
}

let applicationHostT = createRendererTranslator();

type FloatingChatState = {
    showFloatingChatPanel: boolean;
    isMaximized: boolean;
    isTaskRunning: boolean;
    isTaskChanging: boolean;
};

function getFloatingChatState(): FloatingChatState {
    return Alpine.$data(document.body) as FloatingChatState;
}

function setFloatingChatOpen(open: boolean): void {
    getFloatingChatState().showFloatingChatPanel = open;
}

function setCurrentTaskRunning(running: boolean): void {
    getFloatingChatState().isTaskRunning = running;
}

async function runTaskControlAction(action: () => Promise<void>): Promise<void> {
    const state = getFloatingChatState();
    if (state.isTaskChanging) return;
    state.isTaskChanging = true;
    try {
        await action();
    } catch (error) {
        console.error('Floating task control failed:', error);
    } finally {
        state.isTaskChanging = false;
    }
}

function updateMaximizeButtonTranslation(): void {
    const maximizeButton = document.querySelector('#floating-ai-chat-panel-maximize-button');
    if (!maximizeButton) return;
    const key = getFloatingChatState().isMaximized
        ? 'renderer.applicationAgent.restore'
        : 'renderer.applicationAgent.maximize';
    const label = applicationHostT(key);
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.setAttribute('title', label);
}

function updateFloatingChatTranslations(): void {
    const title = applicationHostT('renderer.applicationAgent.title');
    const newTask = applicationHostT('renderer.applicationAgent.newTask');
    const open = applicationHostT('renderer.applicationAgent.open');
    const close = applicationHostT('renderer.applicationAgent.close');

    const titleElement = document.querySelector('#floating-ai-title');
    const newTaskLabel = document.querySelector('#floating-ai-new-task-label');
    const trigger = document.querySelector('#floating-ai-trigger');
    const newTaskButton = document.querySelector('#floating-ai-new-task-button');
    const closeButton = document.querySelector('#floating-ai-chat-panel-close-button');

    if (titleElement) titleElement.textContent = title;
    if (newTaskLabel) newTaskLabel.textContent = newTask;
    trigger?.setAttribute('aria-label', open);
    trigger?.setAttribute('title', open);
    newTaskButton?.setAttribute('aria-label', newTask);
    newTaskButton?.setAttribute('title', newTask);
    updateMaximizeButtonTranslation();
    closeButton?.setAttribute('aria-label', close);
    closeButton?.setAttribute('title', close);
}

function getApplicationEntryWidget(): HTMLElement & {
    getToolset?: () => { toJSON: () => unknown; callTool: (...args: unknown[]) => unknown };
    getAgentInstruct?: () => string;
} {
    const widget = document.querySelector('#application-entry-widget');
    if (!(widget instanceof HTMLElement)) {
        throw new Error('application-entry-widget not found');
    }
    return widget;
}

async function configureTask(taskId: string): Promise<void> {
    const widget = getApplicationEntryWidget();
    const currentToolset = widget.getToolset?.();
    if (currentToolset) {
        await window.taskManagerAPI.attachToolset(
            taskId,
            currentToolset.toJSON(),
            currentToolset.callTool.bind(currentToolset)
        );
    }
    const agentInstruct = widget.getAgentInstruct?.();
    if (agentInstruct) {
        await window.taskManagerAPI.setSystemPrompt(taskId, agentInstruct);
    }
}

async function mountTask(taskId: string): Promise<void> {
    const taskViewContainer = document.querySelector('#floating-ai-task-view-container');
    if (!taskViewContainer) {
        throw new Error('floating-ai-task-view-container not found');
    }

    const taskView = document.createElement('task-view');
    taskView.id = `task-view-${taskId}`;
    taskView.setAttribute('task_id', taskId);
    taskView.setAttribute('embedded', '');
    taskView.setAttribute('data-od-widget', '');
    taskView.className = 'block w-full h-full';
    taskViewContainer.replaceChildren(taskView);

    await configureTask(taskId);
}

function unmountTask(): void {
    setCurrentTaskRunning(false);
    document.querySelector('#floating-ai-task-view-container')?.replaceChildren();
}

const taskSession = new ApplicationTaskSession({
    createTask: () => window.taskManagerAPI.createTask(),
    mountTask,
    unmountTask,
    discardTask: async (taskId) => {
        await window.taskManagerAPI.removeTask(taskId);
    }
});

async function submitRequestToTask(taskId: string, request: { message: string }): Promise<void> {
    if (taskSession.isCurrent(taskId)) {
        setCurrentTaskRunning(true);
        setFloatingChatOpen(true);
    }
    try {
        await window.taskManagerAPI.submitMessage(taskId, request);
    } catch (error) {
        if (taskSession.isCurrent(taskId)) {
            setCurrentTaskRunning(false);
        }
        throw error;
    }
    if (!taskSession.isCurrent(taskId)) {
        return;
    }
    const taskView = document.querySelector(`#task-view-${taskId}`) as HTMLElement & {
        reload?: () => void;
    };
    taskView?.reload?.();
}

async function submitRequest(request: { message: string }): Promise<void> {
    const existingTaskId = taskSession.taskId;
    const taskId = await taskSession.ensureTask();
    if (existingTaskId === taskId) {
        await configureTask(taskId);
    }
    await submitRequestToTask(taskId, request);
}

let newTaskSubmissionPromise: Promise<void> | null = null;

function submitRequestInNewTask(request: string): Promise<void> {
    if (newTaskSubmissionPromise) {
        return newTaskSubmissionPromise;
    }
    const submissionPromise = (async () => {
        const taskId = await taskSession.startNewTask();
        await submitRequestToTask(taskId, { message: request });
    })();
    newTaskSubmissionPromise = submissionPromise;
    void submissionPromise.then(
        () => {
            if (newTaskSubmissionPromise === submissionPromise) {
                newTaskSubmissionPromise = null;
            }
        },
        () => {
            if (newTaskSubmissionPromise === submissionPromise) {
                newTaskSubmissionPromise = null;
            }
        }
    );
    return submissionPromise;
}

function bindFloatingChatControls(): void {
    document.querySelector('#floating-ai-trigger')?.addEventListener('click', (event) => {
        event.stopPropagation();
        void runTaskControlAction(async () => {
            await taskSession.ensureTask();
            setFloatingChatOpen(!getFloatingChatState().showFloatingChatPanel);
        });
    });
    document.querySelector('#floating-ai-new-task-button')?.addEventListener('click', () => {
        void runTaskControlAction(async () => {
            await taskSession.startNewTask();
            setFloatingChatOpen(true);
        });
    });
    document.querySelector('#floating-ai-chat-panel-maximize-button')?.addEventListener('click', () => {
        queueMicrotask(updateMaximizeButtonTranslation);
    });
    document.addEventListener('task-status-changed', (event) => {
        const detail = (event as CustomEvent<{ taskId?: string; status?: string }>).detail;
        if (!detail || !detail.taskId || !taskSession.isCurrent(detail.taskId)) {
            return;
        }
        setCurrentTaskRunning(detail.status === 'running');
    });
}

async function configureFloatingAgentBar(applicationBundleName: string): Promise<void> {
    let enabled = false;
    try {
        const registry = window.applicationRegistryAPI;
        if (!registry) {
            throw new Error('window.applicationRegistryAPI 未注入，无法读取应用 GUI 配置');
        }
        const config = (await registry.getApplicationGUIConfig(applicationBundleName)) as
            { needAgentBar?: boolean } | undefined;
        enabled = config?.needAgentBar === true;
    } catch (error) {
        console.warn(`Failed to load floating agent bar config for ${applicationBundleName}:`, error);
    }
    document.querySelector('#floating-ai-trigger')?.toggleAttribute('hidden', !enabled);
    document.querySelector('#floating-ai-chat-panel')?.toggleAttribute('hidden', !enabled);
}

function showBootstrapError(message: string): void {
    const container = document.querySelector('#application-container');
    if (!container) {
        return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'w-full h-full flex flex-col items-center justify-center gap-3 p-8';
    wrap.style.color = 'var(--od-text, #ccc)';
    wrap.style.background = 'var(--od-bg, #1e1e1e)';
    const title = document.createElement('p');
    title.className = 'text-sm font-medium';
    title.textContent = '子应用加载失败';
    const pre = document.createElement('pre');
    pre.className = 'text-xs max-w-full overflow-auto opacity-80';
    pre.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'flex flex-row gap-2 mt-2';
    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'text-xs px-3 py-1.5 rounded-md border border-gray-400/40 hover:bg-white/10';
    homeBtn.textContent = '返回首页';
    homeBtn.addEventListener('click', () => {
        try {
            window.parent?.globalControlAPI?.openHomePage?.();
        } catch {
            /* cross-origin guard */
        }
    });
    const hint = document.createElement('p');
    hint.className = 'text-xs opacity-70 text-center max-w-md';
    hint.textContent = '也可在左侧边栏点击「应用」切换其他子应用。';
    actions.append(homeBtn);
    wrap.append(title, pre, actions, hint);
    container.replaceChildren(wrap);
}

async function bootstrapApplication(): Promise<void> {
    initApplicationThemeHost();
    await initApplicationThemeFromAPI();

    const apps = import.meta.glob('../../main/applications/**/renderer/entry.{js,ts}');
    const applicationBundleName = new URLSearchParams(window.location.search).get('applicationBundleName');
    if (!applicationBundleName) {
        throw new Error('applicationBundleName query parameter is missing');
    }

    installApplicationFrameProxies(applicationBundleName);
    if (!window.applicationAPI?.setApplicationBundleName) {
        throw new Error('applicationAPI 未注入。请完全退出后执行 npm run build 再启动；开发模式需重启 electron-vite。');
    }

    await window.applicationAPI.setApplicationBundleName(applicationBundleName);
    await configureFloatingAgentBar(applicationBundleName);

    const entryJSPath = `../../main/applications/${applicationBundleName}/renderer/entry.js`;
    const entryTSPath = `../../main/applications/${applicationBundleName}/renderer/entry.ts`;
    if (apps[entryJSPath]) {
        await apps[entryJSPath]();
    } else if (apps[entryTSPath]) {
        await apps[entryTSPath]();
    } else {
        throw new Error(`Entry file not found for application ${applicationBundleName}`);
    }

    const entryName = `${applicationBundleName}-entry-widget`;

    window.aiBarAPI = {
        submitRequest: (request: string) => submitRequest({ message: request }),
        submitRequestInNewTask
    };

    const container = document.querySelector('#application-container');
    if (!container) {
        throw new Error('application-container not found');
    }
    container.innerHTML = `<${entryName} id="application-entry-widget" class="w-full h-full" data-od-widget></${entryName}>`;
    bindFloatingChatControls();
    updateFloatingChatTranslations();
}

void (async () => {
    installParentInputForwarding();

    try {
        if (window.settingAPI?.loadSettingObject) {
            const settings = await window.settingAPI.loadSettingObject();
            const fontPreset = settings.gui_config?.font_preset || 'default';
            document.documentElement.setAttribute('data-font-preset', fontPreset);
            applicationHostT = createRendererTranslator(settings);
        }
    } catch {
        /* optional */
    }

    window.addEventListener('message', (e) => {
        if (e.data?.type === 'FONT_SETTINGS') {
            document.documentElement.setAttribute('data-font-preset', e.data.fontPreset);
        }
    });

    window.settingAPI?.onSettingChanged?.((settings) => {
        applicationHostT = createRendererTranslator(settings);
        updateFloatingChatTranslations();
    });

    try {
        await bootstrapApplication();
    } catch (err) {
        console.error('[application-host] bootstrap failed', err);
        showBootstrapError(err instanceof Error ? err.message : String(err));
    }
})();
