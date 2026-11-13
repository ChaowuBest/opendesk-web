import { jest } from '@jest/globals';
import { loadWebviewUrlQuietly } from '../../../renderer/webviewScripts.js';

/**
 * 回归测试（用户后台日志发现）：
 *
 *   Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL':
 *   Error: ERR_FAILED (-2) loading 'http://…/download-file'
 *
 * `<webview>.loadURL()` 返回 Promise，点击页面上的下载链接时（nav 拦截信令 →
 * 宿主 loadURL）它会以 ERR_FAILED(-2) 拒绝。调用点此前只有同步 try/catch，
 * 于是拒绝变成未处理 rejection 被 Electron 的 guest view manager 记为错误。
 * loadWebviewUrlQuietly 负责收口：-2/-3 视为正常（下载/中断），其余 warn。
 */

function makeWebview(impl: (url: string) => any) {
    return { loadURL: jest.fn(impl) };
}

describe('loadWebviewUrlQuietly', () => {
    test('ERR_FAILED(-2)（下载资源）静默，不产生 console 噪音', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const webview = makeWebview(async () =>
            Promise.reject(Object.assign(new Error("ERR_FAILED (-2) loading 'http://x/download-file'"), { errno: -2 }))
        );

        const started = loadWebviewUrlQuietly(webview, 'http://x/download-file');
        await new Promise((r) => setTimeout(r, 0));

        expect(started).toBe(true);
        expect(webview.loadURL).toHaveBeenCalledWith('http://x/download-file');
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('ERR_ABORTED(-3)（主动中断）同样静默', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const webview = makeWebview(async () => Promise.reject({ errno: -3 }));

        loadWebviewUrlQuietly(webview, 'http://x/a');
        await new Promise((r) => setTimeout(r, 0));

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('其他加载错误保留 warn，便于排查真实故障', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const webview = makeWebview(async () => Promise.reject({ errno: -105, message: 'ERR_NAME_NOT_RESOLVED' }));

        loadWebviewUrlQuietly(webview, 'http://nope/');
        await new Promise((r) => setTimeout(r, 0));

        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('loadURL 同步抛异常时返回 false（调用方回退到 webview.src）', () => {
        const webview = makeWebview(() => {
            throw new Error('not attached');
        });

        expect(loadWebviewUrlQuietly(webview, 'http://x/')).toBe(false);
    });

    test('webview 不可用（尚未 ready）时返回 false', () => {
        expect(loadWebviewUrlQuietly(null, 'http://x/')).toBe(false);
        expect(loadWebviewUrlQuietly({}, 'http://x/')).toBe(false);
    });

    test('成功导航返回 true', async () => {
        const webview = makeWebview(async () => undefined);
        expect(loadWebviewUrlQuietly(webview, 'http://x/ok')).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
    });
});

describe('loadWebviewUrlQuietly 的拒绝回调（tab.url 回滚用）', () => {
    test('拒绝时把错误码交给调用方', async () => {
        const onRejected = jest.fn();
        const webview = makeWebview(async () => Promise.reject({ errno: -2 }));

        loadWebviewUrlQuietly(webview, 'http://x/file.zip', onRejected);
        await new Promise((r) => setTimeout(r, 0));

        expect(onRejected).toHaveBeenCalledWith(-2);
    });

    test('成功导航不触发回调', async () => {
        const onRejected = jest.fn();
        const webview = makeWebview(async () => undefined);

        loadWebviewUrlQuietly(webview, 'http://x/ok', onRejected);
        await new Promise((r) => setTimeout(r, 0));

        expect(onRejected).not.toHaveBeenCalled();
    });

    test('回调自身抛错不影响错误处理与警告', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const webview = makeWebview(async () => Promise.reject({ errno: -105 }));

        expect(() =>
            loadWebviewUrlQuietly(webview, 'http://x/', () => {
                throw new Error('boom');
            })
        ).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));

        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
