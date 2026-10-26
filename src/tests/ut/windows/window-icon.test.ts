import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

// Linux 桌面（Cinnamon / GNOME 等）按 WM_CLASS 把同一应用的所有窗口聚合成一个任务栏
// 条目，条目图标取自窗口的 _NET_WM_ICON。任务状态浮窗（胶囊/卡片）曾漏传 icon 选项，
// 于是整个 OpenDesk 条目退化成系统的 application-x-executable 占位图标（只开主窗口时
// 正常，一旦浮窗被创建就变齿轮），而调试实例通常只开主窗口所以看起来「图标正常」。
// 回归：任一 BrowserWindow 漏传 icon、或有人重新在主进程里各写一份图标计算，
// 都会让问题复现。

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (relativePath: string): string => readFileSync(path.join(projectRoot, relativePath), 'utf8');

/** 取出源码中每个 `new BrowserWindow({...})` 的选项块（括号平衡截断）。 */
const extractBrowserWindowOptions = (source: string): string[] => {
    const blocks: string[] = [];
    const marker = 'new BrowserWindow(';
    let from = 0;
    for (;;) {
        const start = source.indexOf(marker, from);
        if (start === -1) {
            return blocks;
        }
        let index = start + marker.length;
        let depth = 1;
        while (index < source.length && depth > 0) {
            const char = source[index];
            if (char === '(') depth += 1;
            else if (char === ')') depth -= 1;
            index += 1;
        }
        blocks.push(source.slice(start, index));
        from = index;
    }
};

const listTypeScriptFiles = (relativeDir: string): string[] => {
    const absoluteDir = path.join(projectRoot, relativeDir);
    const result: string[] = [];
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        const child = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) {
            result.push(...listTypeScriptFiles(child));
        } else if (entry.name.endsWith('.ts')) {
            result.push(child);
        }
    }
    return result;
};

describe('窗口图标契约', () => {
    test('任务状态浮窗的 BrowserWindow 必须带上应用图标', () => {
        const source = read('src/main/windows/task-status-widget-window.ts');
        const blocks = extractBrowserWindowOptions(source);
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
            expect(block).toContain('icon: getWindowIcon()');
        }
        expect(source).toContain("from '../utils/app-icon.js'");
    });

    test('所有 BrowserWindow 创建点都设置 icon', () => {
        const missing: string[] = [];
        for (const file of listTypeScriptFiles('src/main')) {
            const content = read(file);
            extractBrowserWindowOptions(content).forEach((block, index) => {
                if (!/\bicon\s*:/.test(block)) {
                    missing.push(`${file}#${index}`);
                }
            });
        }
        expect(missing).toEqual([]);
    });

    test('窗口图标只有一份实现，main.ts 不再各自复制', () => {
        const mainSource = read('src/main/main.ts');
        expect(mainSource).toContain("from './utils/app-icon.js'");
        expect(mainSource).not.toMatch(/const\s+getWindowIcon\s*=/);
        expect(mainSource).not.toContain('icon_round_blue.png?asset');
    });
});
