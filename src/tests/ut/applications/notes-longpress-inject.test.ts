/**
 * 代码块右键菜单相关：TinyMCE iframe 的长按脚本注入需禁用脚本自带编辑菜单。
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '../../../..');
const entrySrc = readFileSync(join(srcRoot, 'src/main/applications/notes/renderer/entry.js'), 'utf8');

describe('notes 编辑 iframe 的触摸长按脚本注入', () => {
    test('注入内容先移除编辑菜单宿主标记（脚本编辑菜单在 iframe 内禁用）', () => {
        // 注入的 <script> 内容 = 移除标记语句 + 脚本本体；
        // 若不移除，脚本 onDocumentContextMenu 会对 contenteditable 的
        // TinyMCE body 弹自带编辑菜单（od-edit-menu），与自定义右键菜单叠加
        expect(entrySrc).toContain("removeAttribute('data-od-lp-edit-menu')");
        expect(entrySrc).toContain('TOUCH_LONG_PRESS_SCRIPT');
        // 移除语句必须出现在脚本注入点之前（拼接顺序）
        const removeIdx = entrySrc.indexOf("removeAttribute('data-od-lp-edit-menu')");
        const injectIdx = entrySrc.indexOf('scriptEl.textContent +=');
        expect(removeIdx).toBeGreaterThan(0);
        expect(injectIdx).toBeGreaterThan(removeIdx);
    });

    test('脚本编辑菜单的唯一出口受 editMenuEnabled（宿主标记）控制', () => {
        const lp = readFileSync(join(srcRoot, 'src/renderer/touchLongPressScript.ts'), 'utf8');
        // showEditMenu 的守卫只有一处调用：onDocumentContextMenu 的 editMenuEnabled()
        // （另一处是函数定义本身）
        const calls = [...lp.matchAll(/(?<!function )editMenuEnabled\(\)/g)].length;
        expect(calls).toBe(1);
        // 进度环/手势状态机不受标记影响（长按动效保留）
        expect(lp).toContain('function showIndicator');
        expect(lp).toContain('function onProgressDone');
    });

    test('TinyMCE 初始化禁用内置右键菜单与链接快捷工具条', () => {
        expect(entrySrc).toContain('contextmenu: false');
        expect(entrySrc).toContain('link_context_toolbar: false');
    });
});
