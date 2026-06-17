import { describe, expect, jest, test, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { parseHTML } from 'linkedom';

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
});
