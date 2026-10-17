import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

// 模型面板自适应宽度契约：
// - CSS 侧 #agent-input-model-panel 使用 width: max-content + max-width 上限，
//   模型名整体较短时菜单收窄，避免无意义的空白；
// - JS 侧 toggleModelPanel 必须在渲染后实测面板真实宽度传给 positionPanel，
//   若回退为硬编码数值，窗口边缘的防溢出修正会按错误宽度计算。
const css = readFileSync(new URL('../../../renderer/styles/context-menu.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../../renderer/components/agentinput.js', import.meta.url), 'utf8');

function extractRuleBlock(selector: string): string | null {
    const escaped = selector.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    return match ? match[1] : null;
}

function getDecl(block: string, prop: string): string | null {
    const match = block.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
    return match ? match[1].trim() : null;
}

function parsePx(value: string | null): number | null {
    if (!value) return null;
    const match = value.match(/(-?[\d.]+)px/);
    return match ? parseFloat(match[1]) : null;
}

describe('agent input model panel adaptive width', () => {
    test('模型面板使用 max-content 自适应宽度，上限保持 312px', () => {
        const block = extractRuleBlock('#agent-input-model-panel');
        expect(block).not.toBeNull();
        expect(getDecl(block!, 'width')).toBe('max-content');
        expect(parsePx(getDecl(block!, 'max-width'))).toBe(312);
    });

    test('toggleModelPanel 实测面板宽度传给 positionPanel，不得回退为硬编码宽度', () => {
        const start = js.indexOf('toggleModelPanel(forceClose');
        expect(start).toBeGreaterThan(-1);
        const end = js.indexOf('closeModelPanel(_force', start);
        expect(end).toBeGreaterThan(start);
        const block = js.slice(start, end);

        // offsetWidth 不受弹出动画 scale(0.97) 变换影响，是防溢出计算的正确宽度来源
        expect(block).toMatch(/positionPanel\(\s*btn,\s*panel,\s*panel\.offsetWidth/);
        expect(block).not.toMatch(/positionPanel\(\s*btn,\s*panel,\s*\d/);
    });
});
