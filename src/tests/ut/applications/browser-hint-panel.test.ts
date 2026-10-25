/**
 * 地址栏「页面提示」面板样式：sticky 标题栏必须压在滚动条目之上，且卡片背景不透明。
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '../../../..');
const panelSrc = readFileSync(join(srcRoot, 'src/renderer/components/browserHintPanel.ts'), 'utf8');

/** 取出某个选择器的样式块内容 */
function ruleBlock(selector: string): string {
    const start = panelSrc.indexOf(selector + ' {');
    expect(start).toBeGreaterThan(-1);
    const bodyStart = panelSrc.indexOf('{', start);
    const bodyEnd = panelSrc.indexOf('}', bodyStart);
    return panelSrc.slice(bodyStart + 1, bodyEnd);
}

describe('页面提示面板标题栏层叠', () => {
    test('sticky 标题栏显式提升 z-index，滚动条目不会叠印在标题上', () => {
        const header = ruleBlock('.bhp-header');
        expect(header).toContain('position: sticky');
        // 条目 .bhp-item 是 position: relative 且 DOM 顺序在 header 之后，
        // 两者 z-index 都是 auto 时按 DOM 顺序绘制，条目会盖住标题栏
        expect(header).toMatch(/z-index:\s*[1-9]/);
    });

    test('卡片与标题栏背景为不透明纯色，浅色深色主题都不透出页面内容', () => {
        expect(ruleBlock('.bhp-header')).toContain('background: var(--bhp-card-bg)');
        expect(ruleBlock('.bhp-menu')).toContain('background: var(--bhp-card-bg)');
        const cardBg = [...panelSrc.matchAll(/--bhp-card-bg:\s*([^;]+);/g)].map((m) => m[1].trim());
        expect(cardBg.length).toBeGreaterThanOrEqual(2);
        for (const value of cardBg) {
            expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });
});
