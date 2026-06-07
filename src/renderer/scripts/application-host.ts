/**
 * 子应用 iframe 宿主：主题初始化 → 动态加载 entry → 挂载 entry-widget。
 */

import Alpine from 'alpinejs';
import { installApplicationFrameProxies } from './application-frame-proxy.js';
import { initApplicationThemeHost, initApplicationThemeFromAPI } from '../theme/theme-iframe-bridge.js';

/** 将 iframe 内键盘/鼠标事件转发给父窗口，使 magic pointer 在子应用中仍可用 */
function installParentInputForwarding(): void {
    if (window.parent === window) {
        return;
    }

    const forwardKeyboardEvent = (type: 'keydown' | 'keyup', e: KeyboardEvent) => {
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

let currentTaskId: string | null = null;

async function clearTask(): Promise<void> {
    currentTaskId = null;
}

async function submitRequest(request: { message: string }): Promise<void> {
    const applicationEntryWidget = document.querySelector('#application-entry-widget');

    if (currentTaskId === null) {
        currentTaskId = await window.taskManagerAPI.createTask();
        const taskViewContainer = document.querySelector('#floating-ai-task-view-container');
        if (!taskViewContainer) {
            throw new Error('floating-ai-task-view-container not found');
        }
        taskViewContainer.innerHTML = `
                    <header class="w-full px-2.5 py-1.5 text-xs flex justify-left items-center text-center">
                        <button id='floating-ai-chat-panel-maximize-button' class="group flex items-center px-2 py-1 rounded-full
                            bg-transparent hover:bg-white/60 hover:shadow-md
                            transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]
                            text-gray-700 hover:text-blue-600"
                            @click="isMaximized = !isMaximized"
                        >
                            <i class="fa-solid fa-maximize"></i>
                            <span class="max-w-0 overflow-hidden opacity-0
                                group-hover:max-w-[120px] group-hover:opacity-100
                                group-hover:ml-2 transition-all duration-500 ease-in-out
                                whitespace-nowrap font-medium tracking-tight"
                                x-text="isMaximized ? '还原' : '最大化'"
                            >
                            </span>
                        </button>
                    </header>
                    <embedded-task-view id='task-view-${currentTaskId}' task_id="${currentTaskId}" class="flex-1 overflow-y-auto" />
                    `;

        const taskView = document.querySelector(`#task-view-${currentTaskId}`);
        const agentInput = document.querySelector('#application-agent-input');
        if (taskView && agentInput) {
            taskView.addEventListener('task-status-changed', (e: Event) => {
                const { taskId, status } = (e as CustomEvent).detail;
                if (taskId === currentTaskId) {
                    if (status === 'running') {
                        (agentInput as HTMLElement & { setTaskStatus: (...args: unknown[]) => void }).setTaskStatus(
                            'running',
                            async () => {
                                try {
                                    await window.taskManagerAPI.stopTask(currentTaskId!);
                                } catch (error) {
                                    console.error('Failed to stop task:', error);
                                }
                            }
                        );
                    } else {
                        (agentInput as HTMLElement & { setTaskStatus: (...args: unknown[]) => void }).setTaskStatus(
                            status
                        );
                    }
                }
            });
        }
    }

    const widget = applicationEntryWidget as HTMLElement & {
        getToolset?: () => { toJSON: () => unknown; callTool: (...args: unknown[]) => unknown };
        getAgentInstruct?: () => string;
    };
    const currentToolset = widget.getToolset?.();
    if (currentToolset) {
        await window.taskManagerAPI.attachToolset(
            currentTaskId,
            currentToolset.toJSON(),
            currentToolset.callTool.bind(currentToolset)
        );
    }
    const agentInstruct = widget.getAgentInstruct?.();
    if (agentInstruct) {
        await window.taskManagerAPI.setSystemPrompt(currentTaskId, agentInstruct);
    }

    await window.taskManagerAPI.submitMessage(currentTaskId, request);
    const taskView = document.querySelector(`#task-view-${currentTaskId}`) as HTMLElement & {
        reload?: () => void;
    };
    taskView?.reload?.();
    Alpine.$data(document.body).showFloatingChatPanel = true;
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

    if (!window.applicationAPI?.setApplicationBundleName) {
        installApplicationFrameProxies(applicationBundleName);
    }
    if (!window.applicationAPI?.setApplicationBundleName) {
        throw new Error('applicationAPI 未注入。请完全退出后执行 npm run build 再启动；开发模式需重启 electron-vite。');
    }

    await window.applicationAPI.setApplicationBundleName(applicationBundleName);

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

    let showAgentBar = false;
    try {
        showAgentBar = await window.applicationAPI.callMainWorld('needAgentBar');
    } catch (err) {
        console.warn('Failed to check needAgentBar:', err);
    }

    if (showAgentBar) {
        const agentInputWrapper = document.querySelector('#agent-input-wrapper');
        if (agentInputWrapper) {
            (agentInputWrapper as HTMLElement).style.display = '';
        }
    }

    window.aiBarAPI = {
        submitRequest: (request: string) => submitRequest({ message: request }),
        submitRequestInNewTask: async (request: string) => {
            await clearTask();
            await submitRequest({ message: request });
        }
    };

    const container = document.querySelector('#application-container');
    if (!container) {
        throw new Error('application-container not found');
    }
    container.innerHTML = `<${entryName} id="application-entry-widget" class="w-full h-full" data-od-widget></${entryName}>`;

    if (showAgentBar) {
        document.querySelector('#application-agent-input')?.addEventListener('focus', () => {
            if (currentTaskId !== null) {
                Alpine.$data(document.body).showFloatingChatPanel = true;
            }
        });
        document.querySelector('#application-agent-input')?.addEventListener('submit', (e: Event) => {
            void submitRequest((e as CustomEvent).detail);
        });
    }
}

void (async () => {
    installParentInputForwarding();

    try {
        if (window.settingAPI?.loadSettingObject) {
            const settings = await window.settingAPI.loadSettingObject();
            const fontPreset = settings?.gui_config?.font_preset || 'default';
            document.documentElement.setAttribute('data-font-preset', fontPreset);
        }
    } catch {
        /* optional */
    }

    window.addEventListener('message', (e) => {
        if (e.data?.type === 'FONT_SETTINGS') {
            document.documentElement.setAttribute('data-font-preset', e.data.fontPreset);
        }
    });

    try {
        await bootstrapApplication();
    } catch (err) {
        console.error('[application-host] bootstrap failed', err);
        showBootstrapError(err instanceof Error ? err.message : String(err));
    }
})();
