import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

// 侧边栏 main-sidebar .sb-full-wrapper 曾硬编码了一组系统字体栈（含 Microsoft YaHei），
// 与 taskview 的 .markdown-body（使用 var(--font-sans)，即 HarmonyOS Sans）不一致，
// 导致默认字体下左侧侧边栏与右侧任务区字体不同；霞鹜文楷模式下因强制覆盖所有元素才看不出差异。
const source = readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '');

describe('renderer default font consistency', () => {
    test(':root 定义 --font-sans，taskview 的 .markdown-body 引用它', () => {
        expect(source).toContain(':root{--font-sans:');
        expect(source).toContain('.markdown-body{font-family:var(--font-sans);');
    });

    test('main-sidebar .sb-full-wrapper（侧边栏）使用与 taskview 相同的 --font-sans', () => {
        expect(source).toMatch(/main-sidebar\.sb-full-wrapper\{[^}]*font-family:var\(--font-sans\);/);
    });

    test('侧边栏不再硬编码 Microsoft YaHei 字体栈', () => {
        expect(source).not.toContain('MicrosoftYaHei');
    });
});
