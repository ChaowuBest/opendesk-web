import { describe, expect, jest, test, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { FileResourcePath } from '../../../main/aikernel/security/permission.js';

type PermissionRequestData = {
    requests: { resourceType: string; action: string; resourcePath: string }[];
    toolName: string;
    prefixOptions: { label: string; pattern: string }[];
    timeoutSec?: number;
    taskId?: string;
};

type PermissionRequestCallback = (requestId: string, data: PermissionRequestData) => void;
type PermissionDismissCallback = (requestId: string) => void;

function buildRequest(taskId: string, resourcePath: string): PermissionRequestData {
    return {
        requests: [{ resourceType: 'file', action: 'read', resourcePath }],
        toolName: 'readFile',
        prefixOptions: [{ label: resourcePath, pattern: resourcePath }],
        timeoutSec: 300,
        taskId
    };
}

describe('permission-prompt component', () => {
    const requestCallbacks = new Set<PermissionRequestCallback>();
    const dismissCallbacks = new Set<PermissionDismissCallback>();
    let respondPermission: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });

        await import('../../../renderer/components/permissionPrompt');
    });

    beforeEach(() => {
        jest.useFakeTimers();
        requestCallbacks.clear();
        dismissCallbacks.clear();
        respondPermission = jest.fn();
        document.body.innerHTML = '';
        window.permissionAPI = {
            onPermissionRequest: (callback: PermissionRequestCallback) => {
                requestCallbacks.add(callback);
            },
            offPermissionRequest: (callback: PermissionRequestCallback) => {
                requestCallbacks.delete(callback);
            },
            onPermissionDismiss: (callback: PermissionDismissCallback) => {
                dismissCallbacks.add(callback);
            },
            offPermissionDismiss: (callback: PermissionDismissCallback) => {
                dismissCallbacks.delete(callback);
            },
            respondPermission
        };
    });

    afterEach(() => {
        document.body.innerHTML = '';
        jest.useRealTimers();
    });

    test.each([
        ['D:/应用快照/需求SEG评审/动作说明.txt', '动作说明.txt'],
        ['D:\\应用快照\\需求SEG评审\\动作说明.txt', '动作说明.txt'],
        ['D:/应用快照/需求SEG评审/review notes.txt', 'review notes.txt'],
        ['D:/应用快照/需求SEG评审/report#1.txt', 'report#1.txt'],
        ['D:/应用快照/需求SEG评审/%E5%8A%A8.txt', '%E5%8A%A8.txt'],
        ['D:/应用快照/需求SEG评审/100%.txt', '100%.txt'],
        ['D:/应用快照/需求SEG评审/研发&说明.txt', '研发&说明.txt'],
        ['D:/应用快照/需求SEG评审/', '需求SEG评审/'],
        ['\\\\server\\共享\\动作说明.txt', '动作说明.txt'],
        ['/应用快照/需求SEG评审/动作说明.txt', '动作说明.txt']
    ])('shows literal file short names and preserves permission patterns for %s', (resourcePath, shortName) => {
        const prompt = document.createElement('permission-prompt');
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);

        const data = buildRequest('task-parent', resourcePath);
        data.prefixOptions = new FileResourcePath(resourcePath.replace(/\\/g, '/')).getPrefixes();
        for (const callback of requestCallbacks) {
            callback('perm-path', data);
        }

        const buttonText = (button: Element | null) => button?.textContent?.replace(/\s+/g, ' ').trim();
        expect(buttonText(prompt.querySelector('[data-action="allow"]'))).toBe(`允许读取 ${shortName}`);
        const prefixButtons = prompt.querySelectorAll<HTMLButtonElement>('[data-action="prefix"]');
        expect(buttonText(prefixButtons[0])).toBe(`始终允许读取 ${shortName}`);
        expect(buttonText(prefixButtons[1])).toBe(`始终允许读取 ${data.prefixOptions[1].label}`);
        expect(prefixButtons[0].dataset.pattern).toBe(data.prefixOptions[0].pattern);
        expect(prefixButtons[1].dataset.pattern).toBe(data.prefixOptions[1].pattern);

        prefixButtons[0].click();
        expect(respondPermission).toHaveBeenCalledWith('perm-path', {
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: data.prefixOptions[0].pattern
        });
    });

    test.each([
        ['https://example.com/api/report.json?download=1#result', 'report.json'],
        ['https://example.com', 'example.com']
    ])('preserves network URL short names for %s', (resourcePath, shortName) => {
        const prompt = document.createElement('permission-prompt');
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);

        const data = buildRequest('task-parent', resourcePath);
        data.requests[0].resourceType = 'network';
        data.requests[0].action = 'access';
        for (const callback of requestCallbacks) {
            callback('perm-url', data);
        }

        const text = prompt.querySelector('[data-action="allow"]')?.textContent?.replace(/\s+/g, ' ').trim();
        expect(text).toBe(`允许访问 ${shortName}`);
    });

    test('does not let a previous hide animation clear the next queued request', () => {
        const prompt = document.createElement('permission-prompt') as HTMLElement & {
            connectedCallback?: () => void;
            _visible?: boolean;
            _requestId?: string | null;
            _data?: PermissionRequestData | null;
        };
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);
        if (requestCallbacks.size === 0) {
            prompt.connectedCallback?.();
        }

        for (const callback of requestCallbacks) {
            callback('perm-1', buildRequest('task-parent', '/etc/master.passwd'));
        }
        expect(prompt._requestId).toBe('perm-1');

        prompt.querySelector<HTMLButtonElement>('[data-action="allow"]')?.click();
        expect(respondPermission).toHaveBeenCalledWith('perm-1', { decision: 'allow', rememberScope: 'none' });

        for (const callback of requestCallbacks) {
            callback('perm-2', buildRequest('task-parent', '/var/log/system.log'));
        }
        expect(prompt._requestId).toBe('perm-2');
        expect(prompt._data?.requests[0].resourcePath).toBe('/var/log/system.log');

        jest.advanceTimersByTime(200);

        expect(prompt._visible).toBe(true);
        expect(prompt._requestId).toBe('perm-2');
        expect(prompt._data?.requests[0].resourcePath).toBe('/var/log/system.log');
        expect(prompt.textContent).toContain('/var/log/system.log');
    });

    test('denies an older visible request before showing a different request', () => {
        const prompt = document.createElement('permission-prompt') as HTMLElement & {
            connectedCallback?: () => void;
            _requestId?: string | null;
            _data?: PermissionRequestData | null;
        };
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);
        if (requestCallbacks.size === 0) {
            prompt.connectedCallback?.();
        }

        for (const callback of requestCallbacks) {
            callback('perm-1', buildRequest('task-parent', '/tmp/first.txt'));
        }
        for (const callback of requestCallbacks) {
            callback('perm-2', buildRequest('task-parent', '/tmp/second.txt'));
        }

        expect(respondPermission).toHaveBeenCalledWith('perm-1', { decision: 'deny', rememberScope: 'none' });
        expect(prompt._requestId).toBe('perm-2');
        expect(prompt._data?.requests[0].resourcePath).toBe('/tmp/second.txt');
    });

    test('clears the countdown timer when disconnected', () => {
        const prompt = document.createElement('permission-prompt') as HTMLElement & {
            connectedCallback?: () => void;
            disconnectedCallback?: () => void;
            _countdownTimer?: ReturnType<typeof setInterval> | null;
        };
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);
        if (requestCallbacks.size === 0) {
            prompt.connectedCallback?.();
        }

        for (const callback of requestCallbacks) {
            callback('perm-1', buildRequest('task-parent', '/tmp/first.txt'));
        }

        expect(prompt._countdownTimer).not.toBeNull();
        prompt.remove();
        prompt.disconnectedCallback?.();

        expect(prompt._countdownTimer).toBeNull();
    });

    test('sends a deny response when the countdown expires', () => {
        const prompt = document.createElement('permission-prompt') as HTMLElement & {
            connectedCallback?: () => void;
        };
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);
        if (requestCallbacks.size === 0) {
            prompt.connectedCallback?.();
        }

        for (const callback of requestCallbacks) {
            callback('perm-1', { ...buildRequest('task-parent', '/tmp/first.txt'), timeoutSec: 1 });
        }

        jest.advanceTimersByTime(1000);

        expect(respondPermission).toHaveBeenCalledWith('perm-1', {
            decision: 'deny',
            rememberScope: 'none',
            denyReason: 'timeout'
        });
    });

    test('does not send duplicate responses during the hide animation window', () => {
        const prompt = document.createElement('permission-prompt') as HTMLElement & {
            connectedCallback?: () => void;
        };
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);
        if (requestCallbacks.size === 0) {
            prompt.connectedCallback?.();
        }

        for (const callback of requestCallbacks) {
            callback('perm-1', buildRequest('task-parent', '/tmp/first.txt'));
        }

        const allowButton = prompt.querySelector<HTMLButtonElement>('[data-action="allow"]');
        allowButton?.click();
        allowButton?.click();

        expect(respondPermission).toHaveBeenCalledTimes(1);
    });

    test('dispatches waiting=false event when destroyed while visible', () => {
        const dispatched: { taskId: string; waiting: boolean }[] = [];
        const originalDispatch = document.dispatchEvent.bind(document);
        jest.spyOn(document, 'dispatchEvent').mockImplementation((event: Event) => {
            if (event.type === 'task-waiting-state') {
                const detail = (event as CustomEvent).detail;
                dispatched.push({ taskId: detail.taskId, waiting: detail.waiting });
            }
            return originalDispatch(event);
        });

        const prompt = document.createElement('permission-prompt') as HTMLElement & {
            connectedCallback?: () => void;
            disconnectedCallback?: () => void;
            _visible?: boolean;
        };
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);
        if (requestCallbacks.size === 0) {
            prompt.connectedCallback?.();
        }

        for (const callback of requestCallbacks) {
            callback('perm-1', buildRequest('task-parent', '/tmp/first.txt'));
        }
        // 显示中销毁：应 dispatch waiting=false 兜底清理浮窗标记
        expect(dispatched).toEqual([{ taskId: 'task-parent', waiting: true }]);

        prompt.remove();

        const lastEvent = dispatched[dispatched.length - 1];
        expect(lastEvent).toEqual({ taskId: 'task-parent', waiting: false });
    });

    test('renders theme tokens instead of light-only palette classes so dark mode adapts', () => {
        const prompt = document.createElement('permission-prompt') as HTMLElement & {
            connectedCallback?: () => void;
        };
        prompt.setAttribute('data-task-id', 'task-parent');
        document.body.appendChild(prompt);
        if (requestCallbacks.size === 0) {
            prompt.connectedCallback?.();
        }

        for (const callback of requestCallbacks) {
            callback('perm-1', buildRequest('task-parent', '/tmp/first.txt'));
        }

        const html = prompt.innerHTML;
        // 深浅色自适应依赖 html[data-theme] 切换的语义 token（theme.css）；
        // 这些硬编码浅色类在深色模式下无法跟随主题，禁止回归。
        const lightOnlyPalette = [
            'bg-white',
            'bg-gray-',
            'text-gray-',
            'border-gray-',
            'amber-50',
            'amber-100',
            'amber-200',
            'emerald-',
            'blue-50',
            'blue-100',
            'blue-200',
            'blue-500',
            'blue-700',
            'red-50',
            'red-100',
            'red-200',
            'purple-50',
            'purple-600',
            'to-white'
        ];
        for (const palette of lightOnlyPalette) {
            expect(html).not.toContain(palette);
        }
        expect(html).toContain('var(--chat-');
        expect(html).toContain('var(--od-');
    });
});
