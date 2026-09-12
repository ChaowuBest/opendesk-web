import { describe, expect, it } from '@jest/globals';
import fs from 'fs';

/**
 * 中间消息历史区域（#taskview-chat-history）的横向滚动条必须与纵向同粗：
 * ::-webkit-scrollbar 的 width 只约束纵向滚动条，横向粗细由 height 约束；
 * 只声明 width 会让横向滚动条回退到系统默认宽度（Windows 上明显更粗）。
 */

function readCss(relPath: string): string {
    return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

/** 提取指定选择器规则体内的 scrollbar 尺寸声明（width/height 各一个值）。 */
function extractScrollbarSizes(css: string, selector: string): { width?: string; height?: string } {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    const body = match![1];
    return {
        width: body.match(/(?:^|;)\s*width:\s*([0-9.]+px)/)?.[1],
        height: body.match(/(?:^|;)\s*height:\s*([0-9.]+px)/)?.[1]
    };
}

describe('消息历史区域滚动条粗细一致性', () => {
    const cases = [
        {
            file: '../../../renderer/styles/custom.css',
            selector: '#taskview-chat-history::-webkit-scrollbar'
        },
        {
            file: '../../../renderer/theme/theme-dark.css',
            selector: "html[data-theme='dark'] #taskview-chat-history::-webkit-scrollbar"
        }
    ];

    for (const { file, selector } of cases) {
        it(`${file} 中横向滚动条粗细必须与纵向一致`, () => {
            const sizes = extractScrollbarSizes(readCss(file), selector);
            expect(sizes.width).toBeDefined();
            expect(sizes.height).toBe(sizes.width);
        });
    }
});
