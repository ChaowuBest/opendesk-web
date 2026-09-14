import { describe, expect, jest, test } from '@jest/globals';
import type { WebContents } from 'electron';
import { installMainWindowNavigationGuard } from '../../../main/utils/main-window-navigation.js';

function setup() {
    const handlers = new Map<string, (event: any) => void>();
    let popup: (details: { url: string }) => { action: string };
    const openExternal = jest.fn();
    installMainWindowNavigationGuard(
        {
            on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
            setWindowOpenHandler: (handler: typeof popup) => {
                popup = handler;
            }
        } as unknown as WebContents,
        {
            openExternal,
            isInternalUrl: (url) => url.startsWith('file://') || url.startsWith('opendesk-app://')
        }
    );
    return { handlers, openExternal, popup: (url: string) => popup({ url }) };
}

describe('main window navigation boundary', () => {
    test.each([
        'file:///tmp/report.html',
        'http://localhost:5173/other.html',
        'http://127.0.0.1:9000/',
        'opendesk-app://filemgr/index.html',
        'javascript:void(0)',
        'data:text/html,hello'
    ])('never replaces the main application with %s', (url) => {
        const { handlers } = setup();
        const event = { url, preventDefault: jest.fn() };
        handlers.get('will-navigate')!(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    test('routes web links externally once, while keeping the main page', () => {
        const { handlers, openExternal } = setup();
        const event = { url: 'https://example.com/', isMainFrame: true, preventDefault: jest.fn() };
        handlers.get('will-frame-navigate')!(event);
        handlers.get('will-navigate')!(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(openExternal).toHaveBeenCalledTimes(1);
        expect(openExternal).toHaveBeenCalledWith(event.url);
    });

    test.each(['file:///tmp/app.html', 'opendesk-app://filemgr/index.html'])(
        'preserves embedded application frame navigation to %s',
        (url) => {
            const { handlers, openExternal } = setup();
            const event = { url, isMainFrame: false, preventDefault: jest.fn() };
            handlers.get('will-frame-navigate')!(event);
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(openExternal).not.toHaveBeenCalled();
        }
    );

    test.each(['file:///tmp/other.html', 'javascript:void(0)', 'data:text/html,hello', 'opendesk-app://filemgr/'])(
        'does not open application popups or dispatch unsafe schemes: %s',
        (url) => {
            const { popup, openExternal } = setup();
            expect(popup(url)).toEqual({ action: 'deny' });
            expect(openExternal).not.toHaveBeenCalled();
        }
    );

    test.each(['https://example.com/', 'mailto:hello@example.com'])(
        'opens supported external popup links through the platform: %s',
        (url) => {
            const { popup, openExternal } = setup();
            expect(popup(url)).toEqual({ action: 'deny' });
            expect(openExternal).toHaveBeenCalledTimes(1);
            expect(openExternal).toHaveBeenCalledWith(url);
        }
    );
});
