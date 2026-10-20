/**
 * 触摸屏长按 → 右键点击：主进程注入。
 *
 * 验证点：
 * - installTouchLongPress 对 dom-ready / did-frame-navigate 都挂注入（覆盖
 *   首次加载与 webview 内 iframe / 跨文档导航，脚本自身幂等）；
 * - 注入回调在无 mainFrame 的假 contents 下安全返回；
 * - 模块不含菜单/坐标/合成输入逻辑（右键菜单全部在渲染层脚本内自绘，
 *   真实右键与触摸长按统一走自绘菜单）。
 */

import { beforeEach, describe, expect, jest, test } from '@jest/globals';

describe('installTouchLongPress', () => {
    let mod: typeof import('../../../main/windows/touch-long-press.js');

    beforeEach(async () => {
        jest.resetModules();
        mod = await import('../../../main/windows/touch-long-press.js');
    });

    test('在 dom-ready 与 did-frame-navigate 上挂注入', () => {
        const handlers = new Map<string, () => void>();
        const contents = {
            on: (event: string, handler: () => void) => {
                handlers.set(event, handler);
            }
        };
        mod.installTouchLongPress(contents as never);
        expect(handlers.has('dom-ready')).toBe(true);
        expect(handlers.has('did-frame-navigate')).toBe(true);
        // 触发注入回调不应抛出（无 mainFrame 的假 contents 下安全返回）
        expect(() => handlers.get('dom-ready')!()).not.toThrow();
        expect(() => handlers.get('did-frame-navigate')!()).not.toThrow();
    });

    test('模块不含主进程菜单/合成输入/IPC 逻辑（菜单位置全在渲染层）', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync('src/main/windows/touch-long-press.ts', 'utf8');
        expect(source).not.toContain('Menu.popup');
        expect(source).not.toContain('buildFromTemplate');
        expect(source).not.toContain('sendInputEvent');
        expect(source).not.toContain('ipcMain');
    });

    test('main.ts 编辑区原生菜单已移除（右键与长按统一自绘菜单）', async () => {
        const { readFileSync } = await import('node:fs');
        const mainSource = readFileSync('src/main/main.ts', 'utf8');
        expect(mainSource).not.toContain("t('contextmenu.cut')");
        expect(mainSource).not.toContain("t('contextmenu.selectAll')");
        expect(mainSource).not.toContain('isRecentTouch');
    });
});
