import { describe, expect, jest, test } from '@jest/globals';
import type { WebContents } from 'electron';
import { installMainWindowNavigationGuard } from '../../../main/utils/main-window-navigation.js';

function setup(currentUrl = 'http://localhost:5173/') {
    const handlers = new Map<string, (event: any) => void>();
    let popup: (details: { url: string }) => { action: string };
    const openExternal = jest.fn();
    installMainWindowNavigationGuard(
        {
            on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
            getURL: () => currentUrl,
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

/** 构造只带 url/parent 的假框架链，用于表达「某个子框架位于谁的文档里」。 */
function frameOf(url: string, parent: unknown = null): any {
    return { url, parent };
}

describe('main window navigation boundary', () => {
    test.each(['http://localhost:5173/', 'file:///app/renderer/index.html'])(
        'allows the current application page to reload without opening a browser: %s',
        (url) => {
            const { handlers, openExternal } = setup(url);
            const event = { url, isMainFrame: true, preventDefault: jest.fn() };
            handlers.get('will-frame-navigate')!(event);
            handlers.get('will-navigate')!(event);
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(openExternal).not.toHaveBeenCalled();
        }
    );

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

    // 实测 Electron 39：正在导航的新建子框架 `frame.url` 还是空串（导航尚未提交），
    // 容器身份只能靠 parent 认出来；这里按真实载荷建模，避免测试比实现"宽松"
    test.each([
        ['srcdoc', 'https://httpbin.org/forms/post', frameOf('', frameOf('about:srcdoc', null))],
        ['data:', 'https://example.com/widget', frameOf('', frameOf('data:text/html,<div></div>', null))]
    ])('blocks an embedded %s container subframe without opening a browser', (_kind, url, frame) => {
        const { handlers, openExternal } = setup();
        // HTML 预览卡片用 srcdoc/data: iframe 承载任意 HTML，页面里再嵌 httpbin 这类第三方
        // 表单属于页面自身的嵌入内容：打开任务时不能拉起系统浏览器。
        const event = { url, isMainFrame: false, frame, preventDefault: jest.fn() };
        handlers.get('will-frame-navigate')!(event);
        // 远程内容不进主窗口的子框架（子框架会执行 preload）；实测放行时子框架会真的
        // 把外站文档加载进渲染进程，所以这里必须是"挡住"，而不是"只别弹浏览器"
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(openExternal).not.toHaveBeenCalled();
    });

    test('still routes an application frame submenu navigation to the system browser', () => {
        const { handlers, openExternal } = setup();
        // 应用框架自己的地址是 file://，点开的网页链接仍照旧转交系统浏览器
        const frame = frameOf('file:///app/renderer/application.html?applicationBundleName=filemgr', null);
        const event = { url: 'https://example.com/help', isMainFrame: false, frame, preventDefault: jest.fn() };
        handlers.get('will-frame-navigate')!(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(openExternal).toHaveBeenCalledWith('https://example.com/help');
    });

    test('does not open a browser when the navigating frame is already gone', () => {
        const { handlers, openExternal } = setup();
        const event = { url: 'https://example.com/', isMainFrame: false, frame: null, preventDefault: jest.fn() };
        handlers.get('will-frame-navigate')!(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(openExternal).not.toHaveBeenCalled();
    });

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
