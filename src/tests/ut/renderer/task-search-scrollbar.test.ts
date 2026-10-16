import { describe, expect, it } from '@jest/globals';
import fs from 'fs';

/**
 * 搜索浮层结果列表（.od-task-search-scroll）滚动条必须自定义：
 * 未定义 ::-webkit-scrollbar 时回退系统原生样式，深色模式下出现
 * 带箭头的粗白滚动条，与 TaskView 聊天历史的一级滚动条规格不一致
 * （6px、透明轨道、浅色半透明黑 thumb / 深色半透明白 thumb）。
 * 颜色走 .od-task-search 的局部变量，深色由 html[data-theme='dark'] 覆盖。
 */

const source = fs.readFileSync(new URL('../../../renderer/components/taskSearchDialog.css', import.meta.url), 'utf8');

function ruleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    return match![1];
}

describe('搜索浮层结果列表滚动条样式', () => {
    it('滚动容器必须自定义 webkit 滚动条且横向与纵向同粗', () => {
        const body = ruleBody(source, '.od-task-search-scroll::-webkit-scrollbar');
        expect(body).toMatch(/width:\s*6px/);
        expect(body).toMatch(/height:\s*6px/);
    });

    it('轨道必须透明，不允许出现白色/深色实底轨道', () => {
        const body = ruleBody(source, '.od-task-search-scroll::-webkit-scrollbar-track');
        expect(body).toMatch(/background:\s*transparent/);
    });

    it('thumb 使用局部变量且圆角对齐 TaskView 规格', () => {
        const body = ruleBody(source, '.od-task-search-scroll::-webkit-scrollbar-thumb');
        expect(body).toMatch(/background:\s*var\(--search-scrollbar\)/);
        expect(body).toMatch(/border-radius:\s*3px/);
        const hover = ruleBody(source, '.od-task-search-scroll::-webkit-scrollbar-thumb:hover');
        expect(hover).toMatch(/background:\s*var\(--search-scrollbar-hover\)/);
    });

    it('浅色变量为半透明黑（对齐 TaskView 规格）', () => {
        const body = ruleBody(source, '.od-task-search');
        expect(body).toMatch(/--search-scrollbar:\s*rgba\(0,\s*0,\s*0,\s*0\.14\)/);
        expect(body).toMatch(/--search-scrollbar-hover:\s*rgba\(0,\s*0,\s*0,\s*0\.24\)/);
    });

    it('深色变量必须覆盖为半透明白', () => {
        const body = ruleBody(source, "html[data-theme='dark'] .od-task-search");
        expect(body).toMatch(/--search-scrollbar:\s*rgba\(255,\s*255,\s*255,\s*0\.18\)/);
        expect(body).toMatch(/--search-scrollbar-hover:\s*rgba\(255,\s*255,\s*255,\s*0\.28\)/);
    });
});
