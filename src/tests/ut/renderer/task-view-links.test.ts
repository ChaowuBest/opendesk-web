import { describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { handleTaskViewLinkClick } from '../../../renderer/utils/task-view-links.js';

function clickLink(href: string, options: { shadow?: boolean; type?: string; button?: number } = {}) {
    const { document, window } = parseHTML('<html><body><task-view></task-view></body></html>');
    const task = document.querySelector('task-view')!;
    const openFileInSidebar = jest.fn();
    const openUrlInSidebar = jest.fn();
    Object.assign(task, { openFileInSidebar, openUrlInSidebar });
    const host = document.createElement('div');
    task.append(host);
    const container = options.shadow ? host.attachShadow({ mode: 'open' }) : host;
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    container.append(anchor);
    const event = new window.Event(options.type ?? 'click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'button', { value: options.button ?? 0 });
    document.addEventListener(event.type, handleTaskViewLinkClick as EventListener);
    if (options.shadow) {
        // A real composed event exposes the anchor even when its target is the shadow host.
        Object.defineProperty(event, 'composedPath', { value: () => [anchor, container, host, task, document] });
        host.dispatchEvent(event);
    } else {
        anchor.dispatchEvent(event);
    }
    return { event, openFileInSidebar, openUrlInSidebar };
}

describe('task-view link routing', () => {
    test('opens legacy/raw file URL links in the sidebar and cancels default navigation', () => {
        const result = clickLink('file:///tmp/report%20%231.html');
        expect(result.event.defaultPrevented).toBe(true);
        expect(result.openFileInSidebar).toHaveBeenCalledTimes(1);
        expect(result.openFileInSidebar).toHaveBeenCalledWith('/tmp/report #1.html');
    });

    test('routes links inside a Shadow DOM preview', () => {
        const result = clickLink('file:///tmp/report.html', { shadow: true });
        expect(result.event.defaultPrevented).toBe(true);
        expect(result.openFileInSidebar).toHaveBeenCalledTimes(1);
        expect(result.openFileInSidebar).toHaveBeenCalledWith('/tmp/report.html');
    });

    test.each(['https://example.com/', 'http://localhost:5173/report', 'http://127.0.0.1:9000/'])(
        'opens web links in the browser sidebar, including loopback: %s',
        (url) => {
            const result = clickLink(url);
            expect(result.event.defaultPrevented).toBe(true);
            expect(result.openUrlInSidebar).toHaveBeenCalledTimes(1);
            expect(result.openUrlInSidebar).toHaveBeenCalledWith(url);
        }
    );

    test.each(['javascript:void(0)', 'data:text/html,hello', 'file:///tmp/%ZZ', 'opendesk-app://other/'])(
        'cancels unsupported or malformed navigation: %s',
        (url) => {
            const result = clickLink(url);
            expect(result.event.defaultPrevented).toBe(true);
            expect(result.openFileInSidebar).not.toHaveBeenCalled();
            expect(result.openUrlInSidebar).not.toHaveBeenCalled();
        }
    );

    test('keeps in-page heading anchors working', () => {
        expect(clickLink('#section').event.defaultPrevented).toBe(false);
    });

    test('middle-click routes file links instead of creating a native popup', () => {
        const result = clickLink('file:///tmp/report.html', { type: 'auxclick', button: 1 });
        expect(result.event.defaultPrevented).toBe(true);
        expect(result.openFileInSidebar).toHaveBeenCalledTimes(1);
    });
});
