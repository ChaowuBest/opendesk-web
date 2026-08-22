import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { enUs } from '../../../locale/en-us.js';
import { zhCn } from '../../../locale/zh-cn.js';
import type { FSEntry } from '../../../renderer/components/fileSelector.js';

// 锁定 en-US locale，使测试不依赖运行环境的 navigator.language
jest.unstable_mockModule('../../../renderer/locale.js', () => {
    const translate = (key: string, params?: Record<string, string | number>): string => {
        let text: string = enUs[key] ?? key;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
            }
        }
        return text;
    };
    return {
        createRendererTranslator: () => translate,
        resolveRendererLocale: () => 'en-US'
    };
});

type FileSelectorModule = typeof import('../../../renderer/components/fileSelector.js');

// 模拟目录树：键为目录路径，值为其下的子目录名
const TREE: Record<string, string[]> = {
    '/a': ['b', 'e'],
    '/a/b': ['c', 'd', 'empty'],
    '/a/e': ['f'],
    '/a/b/c': ['x'],
    '/a/b/d': ['y'],
    '/a/b/empty': [],
    '/a/b/c/x': ['deep'],
    '/a/b/c/x/deep': []
};

function listDirectory(dirPath: string): Promise<FSEntry[]> {
    const names = TREE[dirPath] ?? [];
    return Promise.resolve(
        names.map((name) => ({
            name,
            path: `${dirPath}/${name}`,
            isDirectory: true
        }))
    );
}

// 不依赖具体语言：noSubdir 文案在 en / zh 两种语言下都应命中
const NO_SUBDIR_TEXTS = [enUs['renderer.fileSelector.noSubdir'], zhCn['renderer.fileSelector.noSubdir']];

describe('FileSelector column animation', () => {
    let FileSelector: FileSelectorModule['FileSelector'];

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
        // linkedom 不实现这些 API，FileSelector 的渲染/滚动逻辑依赖它们
        (window.HTMLElement.prototype as any).getBoundingClientRect = () => ({
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            width: 0,
            height: 0
        });
        (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
        (globalThis as any).cancelAnimationFrame = (id: unknown) => clearTimeout(id as any);
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements
        });

        ({ FileSelector } = await import('../../../renderer/components/fileSelector.js'));
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function createSelector(): FileSelectorModule['FileSelector'] {
        return new FileSelector({
            listDirectory: (dirPath) => listDirectory(dirPath),
            directoryOnly: true
        });
    }

    test('/a/b/c 切到同层 /a/b/d 时深度不变，不播放列动画（无抖动）', async () => {
        const selector = createSelector();
        document.body.appendChild(selector.element);
        await selector.navigateToPath('/a/b/c', '/a');

        // 点击同级目录 /a/b/d（位于第 1 列的条目）
        await (selector as any)._onItemClick(1, '/a/b/d');

        const cols = selector.element.querySelectorAll('.od-fscol');
        // 深度未变：列数仍为 3
        expect(cols.length).toBe(3);

        // 第 1 列当前选中项应为 /a/b/d
        const col1Selected = cols[1].querySelector('.od-fsitem.selected') as HTMLElement;
        expect(col1Selected?.dataset.path).toBe('/a/b/d');

        // 最后一列应为 /a/b/d 的子项，而非 /a/b/c 的
        const lastCol = cols[cols.length - 1];
        expect(lastCol.querySelector('.od-fsitem[data-path="/a/b/d/y"]')).not.toBeNull();
        expect(lastCol.querySelector('.od-fsitem[data-path="/a/b/c/x"]')).toBeNull();

        // 关键回归点：深度未变时不得播放入场动画，避免“收起再展开”的抖动
        expect(lastCol.classList.contains('od-fscol-enter')).toBe(false);
        // 同样不应残留退场动画类
        expect(selector.element.querySelector('.od-fscol-exit')).toBeNull();
    });

    test('真实深度增加（drill-down）时仍播放入场动画', async () => {
        const selector = createSelector();
        document.body.appendChild(selector.element);
        await selector.navigateToPath('/a/b', '/a');

        // 从 /a/b 进入 /a/b/c：列数 2 -> 3，应播放入场动画
        await (selector as any)._onItemClick(1, '/a/b/c');

        const cols = selector.element.querySelectorAll('.od-fscol');
        expect(cols.length).toBe(3);
        // 新增的最后一列应带有入场动画类
        expect(cols[cols.length - 1].classList.contains('od-fscol-enter')).toBe(true);
    });

    test('选中无子目录的同级目录时仍展示右侧列并显示“(无子目录)”', async () => {
        const selector = createSelector();
        document.body.appendChild(selector.element);
        await selector.navigateToPath('/a/b/c', '/a');

        // 点击同级空目录 /a/b/empty（位于第 1 列）
        await (selector as any)._onItemClick(1, '/a/b/empty');

        const cols = selector.element.querySelectorAll('.od-fscol');
        // 深度未变：列数仍为 3，右侧列必须存在
        expect(cols.length).toBe(3);

        const lastCol = cols[cols.length - 1];
        const emptyEl = lastCol.querySelector('.od-fscol-empty') as HTMLElement;
        expect(emptyEl).not.toBeNull();
        expect(NO_SUBDIR_TEXTS).toContain(emptyEl.textContent);

        // 无子目录列不得播放入场动画（深度未变，避免抖动）
        expect(lastCol.classList.contains('od-fscol-enter')).toBe(false);
    });

    test('drill-down 进入无子目录的目录时，新列展示“(无子目录)”', async () => {
        const selector = createSelector();
        document.body.appendChild(selector.element);
        await selector.navigateToPath('/a/b/c/x', '/a');

        // 进入 /a/b/c/x/deep（第 3 列），其下无任何子目录
        await (selector as any)._onItemClick(3, '/a/b/c/x/deep');

        const cols = selector.element.querySelectorAll('.od-fscol');
        expect(cols.length).toBe(5);
        const lastCol = cols[cols.length - 1];
        const emptyEl = lastCol.querySelector('.od-fscol-empty') as HTMLElement;
        expect(emptyEl).not.toBeNull();
        expect(NO_SUBDIR_TEXTS).toContain(emptyEl.textContent);
        // 真实深度增加：新列带入场动画
        expect(lastCol.classList.contains('od-fscol-enter')).toBe(true);
    });

    test('navigateToPath 导航到无子目录的目录时，末尾展示“(无子目录)”列', async () => {
        const selector = createSelector();
        document.body.appendChild(selector.element);
        await selector.navigateToPath('/a/b/empty', '/a');

        const cols = selector.element.querySelectorAll('.od-fscol');
        expect(cols.length).toBe(3);
        const lastCol = cols[cols.length - 1];
        const emptyEl = lastCol.querySelector('.od-fscol-empty') as HTMLElement;
        expect(emptyEl).not.toBeNull();
        expect(NO_SUBDIR_TEXTS).toContain(emptyEl.textContent);
    });
});
