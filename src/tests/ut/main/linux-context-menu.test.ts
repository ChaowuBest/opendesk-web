/**
 * Linux(X11) 无边框窗口 WM 系统菜单抑制：
 *
 * Chromium 未设置应用菜单时，右键非编辑区域默认走 _NET_WM_MENU 协议请求 WM
 * 弹系统窗口菜单（Cinnamon/Muffin 的最小化/移动/调整大小/关闭菜单）。该菜单
 * 弹于窗口左上角而非鼠标位置，弹出后 WM grab 输入导致菜单点不动、关不掉，
 * 期间标题栏按钮也失效。本模块在 context-menu 事件中 preventDefault 阻断该
 * 默认流程，验证点：
 * - 仅 Linux 生效；
 * - 非编辑区域 preventDefault，编辑区域放行（保留剪切/复制/粘贴菜单）。
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

type ContextMenuParams = { isEditable: boolean };
type ContextMenuHandler = (event: { preventDefault: () => void }, params: ContextMenuParams) => void;

function makeContents(): { handlers: Map<string, ContextMenuHandler>; on: jest.Mock } {
    const handlers = new Map<string, ContextMenuHandler>();
    const on = jest.fn((event: string, handler: ContextMenuHandler) => {
        handlers.set(event, handler);
        return undefined as unknown;
    });
    return { handlers, on };
}

const originalPlatform = process.platform;
function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('suppressWmSystemMenuOnLinux', () => {
    let mod: typeof import('../../../main/windows/linux-context-menu.js');

    beforeEach(async () => {
        jest.resetModules();
        setPlatform('linux');
        mod = await import('../../../main/windows/linux-context-menu.js');
    });

    afterEach(() => {
        setPlatform(originalPlatform);
    });

    it('Linux 下注册 context-menu 监听', () => {
        const contents = makeContents();
        mod.suppressWmSystemMenuOnLinux(contents as never);
        expect(contents.handlers.has('context-menu')).toBe(true);
    });

    it('非编辑区域右键 preventDefault（阻断 _NET_WM_MENU 系统菜单）', () => {
        const contents = makeContents();
        mod.suppressWmSystemMenuOnLinux(contents as never);
        const handler = contents.handlers.get('context-menu')!;
        const event = { preventDefault: jest.fn() };
        handler(event, { isEditable: false });
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('编辑区域右键放行，不 preventDefault（保留剪切/复制/粘贴菜单）', () => {
        const contents = makeContents();
        mod.suppressWmSystemMenuOnLinux(contents as never);
        const handler = contents.handlers.get('context-menu')!;
        const event = { preventDefault: jest.fn() };
        handler(event, { isEditable: true });
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('非 Linux 平台不注册任何监听', () => {
        setPlatform('win32');
        const contents = makeContents();
        mod.suppressWmSystemMenuOnLinux(contents as never);
        expect(contents.handlers.size).toBe(0);
        expect(contents.on).not.toHaveBeenCalled();
    });
});
