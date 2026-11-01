import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { guiShortcutManager } from '../../../renderer/components/shortcutManager.ts';
import { registerDisplayZoomShortcuts } from '../../../renderer/scripts/display-zoom-shortcuts.ts';

const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const applicationWindowHtml = readFileSync(
    new URL('../../../renderer/application_window.html', import.meta.url),
    'utf8'
);

type ZoomEvent = { key: string; ctrlKey: boolean; metaKey: boolean };

const keyEvent = (key: string, modifiers: Partial<ZoomEvent> = {}): KeyboardEvent =>
    ({ key, ctrlKey: true, metaKey: false, ...modifiers }) as KeyboardEvent;

function findShortcut(id: string) {
    return guiShortcutManager.getAll().find((entry) => entry.id === id);
}

describe('GUI 缩放快捷键', () => {
    const adjustScaleFactor = jest.fn(async (_delta: number) => 1);
    const setScaleFactor = jest.fn(async (_factor: number) => 1);

    afterEach(() => {
        adjustScaleFactor.mockClear();
        setScaleFactor.mockClear();
        delete (globalThis as { window?: unknown }).window;
    });

    test('主窗口与独立应用窗口共用同一份快捷键定义', () => {
        for (const html of [rendererHtml, applicationWindowHtml]) {
            expect(html).toContain('registerDisplayZoomShortcuts');
            expect(html).toContain('./scripts/display-zoom-shortcuts.ts');
            // 注册后必须 attach，否则快捷键不会响应
            expect(html).toContain('guiShortcutManager.attach()');
            // 不允许退回内联定义：两处各写一份就会出现快捷键漂移
            expect(html).not.toContain("id: 'display:zoom-in'");
        }
    });

    test('注册放大/缩小/重置三条快捷键并驱动全局缩放偏好', () => {
        (globalThis as { window?: unknown }).window = {
            displayAPI: { adjustScaleFactor, setScaleFactor }
        };
        registerDisplayZoomShortcuts();

        const zoomIn = findShortcut('display:zoom-in');
        const zoomOut = findShortcut('display:zoom-out');
        const reset = findShortcut('display:zoom-reset');
        expect(zoomIn && zoomOut && reset).toBeTruthy();

        // Ctrl+= 与 Ctrl++ 都放大（等号键在多数键盘上需要 Shift）
        expect(zoomIn!.match(keyEvent('='))).toBe(true);
        expect(zoomIn!.match(keyEvent('+'))).toBe(true);
        expect(zoomIn!.match(keyEvent('=', { ctrlKey: false }))).toBe(false);
        zoomIn!.handler(keyEvent('='));
        expect(adjustScaleFactor).toHaveBeenLastCalledWith(0.1);

        expect(zoomOut!.match(keyEvent('-'))).toBe(true);
        expect(zoomOut!.match(keyEvent('-', { ctrlKey: false }))).toBe(false);
        zoomOut!.handler(keyEvent('-'));
        expect(adjustScaleFactor).toHaveBeenLastCalledWith(-0.1);

        expect(reset!.match(keyEvent('0'))).toBe(true);
        expect(reset!.match(keyEvent('0', { ctrlKey: false }))).toBe(false);
        reset!.handler(keyEvent('0'));
        expect(setScaleFactor).toHaveBeenLastCalledWith(1);
    });

    test('macOS 的 Command 键与 Ctrl 等效', () => {
        (globalThis as { window?: unknown }).window = {
            displayAPI: { adjustScaleFactor, setScaleFactor }
        };
        registerDisplayZoomShortcuts();

        expect(findShortcut('display:zoom-in')!.match(keyEvent('=', { ctrlKey: false, metaKey: true }))).toBe(true);
        expect(findShortcut('display:zoom-out')!.match(keyEvent('-', { ctrlKey: false, metaKey: true }))).toBe(true);
        expect(findShortcut('display:zoom-reset')!.match(keyEvent('0', { ctrlKey: false, metaKey: true }))).toBe(true);
    });

    test('主进程缩放调用失败不产生未处理的拒绝', async () => {
        const failing = jest.fn(async () => {
            throw new Error('setting write failed');
        });
        (globalThis as { window?: unknown }).window = {
            displayAPI: { adjustScaleFactor: failing, setScaleFactor: failing }
        };
        registerDisplayZoomShortcuts();

        expect(() => findShortcut('display:zoom-in')!.handler(keyEvent('='))).not.toThrow();
        // 让被吞掉的拒绝在微任务里落地：没有 catch 的话这里会冒成未处理拒绝
        await Promise.resolve();
        expect(failing).toHaveBeenCalledWith(0.1);
    });
});
