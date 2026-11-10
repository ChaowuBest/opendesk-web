import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 内置终端收起/展开（默认收起，展开才建联）：
 *
 * 1. 默认收起：面板常驻但只显示标题栏（body/resizer hidden），不建立 PTY 会话；
 *    profile 列表仍预载，展开即可用。用户主动展开才建联。
 * 2. 收起不销毁会话：收起只是折叠 UI，后台命令保持运行；再展开不重复建联。
 * 3. 收起态的一切建联兜底（visibilitychange / resize / 任务切换 / profile 切换）
 *    均被 collapsed 门禁拦截，等展开后按需补建。
 */

function rect(top: number, bottom: number): () => object {
    return () => ({
        left: 0,
        top,
        right: 1000,
        bottom,
        width: 1000,
        height: bottom - top,
        x: 0,
        y: top
    });
}

const flushMicrotasks = async (rounds = 16): Promise<void> => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe('task-terminal-panel 收起/展开（默认收起，展开才建联）', () => {
    let win: any;
    let doc: any;
    let visibilityState: string;
    let listProfilesCalls: number;
    let createCalls: number;
    let startCalls: number;
    let closeCalls: number;
    let terminalOpenCalls: number;
    let lastCreateOptions: Record<string, unknown> | null;

    beforeAll(async () => {
        jest.unstable_mockModule('@xterm/xterm', () => ({
            Terminal: class {
                cols = 80;
                rows = 24;
                loadAddon() {}
                onData() {
                    return { dispose() {} };
                }
                onResize() {
                    return { dispose() {} };
                }
                write() {}
                reset() {}
                dispose() {}
                open() {
                    terminalOpenCalls++;
                }
                focus() {}
            }
        }));
        jest.unstable_mockModule('@xterm/addon-fit', () => ({
            FitAddon: class {
                fit() {}
            }
        }));

        const parsed = parseHTML('<!doctype html><html><body></body></html>');
        win = parsed.window;
        doc = parsed.document;
        Object.assign(globalThis, {
            window: win,
            document: doc,
            HTMLElement: win.HTMLElement,
            Element: win.Element,
            CustomEvent: win.CustomEvent,
            customElements: win.customElements,
            Event: win.Event,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            },
            requestAnimationFrame: () => 0,
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        visibilityState = 'visible';
        Object.defineProperty(doc, 'visibilityState', {
            get: () => visibilityState,
            configurable: true
        });

        (win as any).localStorage = {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined
        };
        (win as any).terminalAPI = {
            onData: () => () => undefined,
            onExit: () => () => undefined,
            listProfiles: async () => {
                listProfilesCalls++;
                return [
                    { id: 'powershell:pwsh', kind: 'powershell' },
                    { id: 'bash:git-bash', kind: 'bash' }
                ];
            },
            create: async (options: Record<string, unknown>) => {
                createCalls++;
                lastCreateOptions = options;
                return { sessionId: `session-${createCalls}`, backend: 'pty' };
            },
            start: async () => {
                startCalls++;
            },
            close: async () => {
                closeCalls++;
            },
            resize: async () => undefined,
            acknowledge: async () => undefined,
            write: async () => undefined
        };
        (win as any).settingAPI = {
            loadSettingObject: async () => ({
                debug: { experimental_features: { builtin_terminal: true } }
            }),
            onSettingChanged: () => () => undefined
        };

        await import('../../../renderer/components/taskTerminalPanel.js');
    });

    beforeEach(() => {
        doc.body.innerHTML = '';
        visibilityState = 'visible';
        listProfilesCalls = 0;
        createCalls = 0;
        startCalls = 0;
        closeCalls = 0;
        terminalOpenCalls = 0;
        lastCreateOptions = null;
    });

    function createPanel(hostHeight: number): any {
        const container = doc.createElement('div');
        const panel = doc.createElement('task-terminal-panel');
        container.appendChild(panel);
        doc.body.appendChild(container);
        // host 几何可见：证明建联拦截靠 collapsed 门禁而非几何不可见
        panel.querySelector('[data-task-terminal-host]').getBoundingClientRect = rect(300, 300 + hostHeight);
        // linkedom 的 <select>.value 是 getter-only（真实浏览器可写）：
        // 补成可写数据属性，避免 loadProfiles 在填充 profile 时被环境限制打断。
        Object.defineProperty(panel.querySelector('[data-task-terminal-profile]'), 'value', {
            value: '',
            writable: true,
            configurable: true
        });
        return panel;
    }

    function getToggle(panel: any): any {
        return panel.querySelector('[data-task-terminal-toggle]');
    }

    function getBody(panel: any): any {
        return panel.querySelector('.task-terminal-body');
    }

    function getResizer(panel: any): any {
        return panel.querySelector('[data-task-terminal-resizer]');
    }

    function clickToggle(panel: any): void {
        getToggle(panel).dispatchEvent(new win.Event('click', { bubbles: true }));
    }

    test('默认收起：只显示标题栏（body/resizer hidden），预载 profile 但不建联', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        // 默认收起：面板可见（实验开关开启）但主体折叠
        expect(panel.style.display).toBe('');
        expect(getBody(panel).hasAttribute('hidden')).toBe(true);
        expect(getResizer(panel).hasAttribute('hidden')).toBe(true);
        expect(getToggle(panel).getAttribute('aria-expanded')).toBe('false');
        // profile 预载（展开即可用），但绝不主动建联
        expect(listProfilesCalls).toBe(1);
        expect(createCalls).toBe(0);
        expect(startCalls).toBe(0);
    });

    test('展开后建立会话并 open xterm', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        clickToggle(panel);
        await flushMicrotasks();
        expect(getBody(panel).hasAttribute('hidden')).toBe(false);
        expect(getResizer(panel).hasAttribute('hidden')).toBe(false);
        expect(getToggle(panel).getAttribute('aria-expanded')).toBe('true');
        // 展开动作直接触发 open + 建联（不依赖 rAF/ResizeObserver）
        expect(terminalOpenCalls).toBe(1);
        expect(createCalls).toBe(1);
        expect(startCalls).toBe(1);
        expect(lastCreateOptions!.profileId).toBe('powershell:pwsh');
    });

    test('收起保留会话现场（不 close），再展开不重复建联', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        // 收起：只折叠 UI，会话继续在后台运行（不杀 PTY、不清 scrollback）
        clickToggle(panel);
        await flushMicrotasks();
        expect(getBody(panel).hasAttribute('hidden')).toBe(true);
        expect(closeCalls).toBe(0);
        // 再展开：会话仍在，不得重建（否则收起/展开一次就丢一次现场）
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        expect(closeCalls).toBe(0);
    });

    test('收起态任务切换不建联；展开后按新任务建联', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        // 收起态切任务：cwd 变了但未建会话，无需重启；展开时才按新任务建联
        panel.setTaskContext('task-2');
        await flushMicrotasks();
        expect(createCalls).toBe(0);
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        expect(lastCreateOptions!.taskId).toBe('task-2');
    });

    test('收起态切换 profile 不建联；下次展开用新 profile 建联', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        const select = panel.querySelector('[data-task-terminal-profile]');
        select.value = 'bash:git-bash';
        select.dispatchEvent(new win.Event('change', { bubbles: true }));
        await flushMicrotasks();
        expect(createCalls).toBe(0);
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        expect(lastCreateOptions!.profileId).toBe('bash:git-bash');
    });

    test('收起态 host 可见时 visibilitychange 兜底也不建联', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        visibilityState = 'visible';
        doc.dispatchEvent(new win.Event('visibilitychange'));
        await flushMicrotasks();
        // collapsed 门禁拦截：即使几何可见、profile 就绪，也等用户主动展开
        expect(createCalls).toBe(0);
    });

    test('样式显式恢复 body/resizer 的 [hidden] display:none 语义', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        // 作者源一旦为这两个类声明 display（如 resizer 的块级修饰），将恒覆盖
        // UA 样式表 [hidden]{display:none}（message 遮罩黑屏 bug 同构陷阱），
        // 必须提供同源救场规则保证收起态真正折叠。
        const css = panel.querySelector('style').textContent;
        expect(css).toMatch(/\.task-terminal-body\[hidden\][^{}]*\{[^}]*display:\s*none/);
        expect(css).toMatch(/\.task-terminal-resizer\[hidden\][^{}]*\{[^}]*display:\s*none/);
    });
});
