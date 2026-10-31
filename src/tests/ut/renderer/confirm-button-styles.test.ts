import { CONFIRM_BUTTON_CSS } from '../../../common/confirm-button-styles.js';

/**
 * 确认按钮样式的回归护栏。
 *
 * 背景：弹窗会被注入到宿主应用自己的 Shadow DOM（插件中心等），宿主的通用
 * `button:hover { background: #f4f5f7 }`（优先级 0,1,1）会压过单个类的
 * `.od-confirm-btn-danger`（0,1,0），导致危险按钮 hover 时变成"白字浅底"。
 * 因此所有规则统一带 `button` 前缀，优先级均不低于 `button:hover`，且 hover 态
 * 显式声明背景。
 */

interface CssRule {
    selector: string;
    body: string;
}

function parseRules(css: string): CssRule[] {
    const rules: CssRule[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
        rules.push({ selector: match[1].trim(), body: match[2] });
    }
    return rules;
}

/** 简化版优先级统计：仅统计类/属性/伪类（b）与元素/伪元素（c），id 计为 a */
function specificity(selector: string): [number, number, number] {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []).filter(
        (token) => !token.startsWith('::')
    ).length;
    const elements = (selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
    return [ids, classes, elements];
}

function findRule(rules: CssRule[], selector: string): CssRule {
    const rule = rules.find((candidate) => candidate.selector === selector);
    if (!rule) throw new Error(`missing rule: ${selector}`);
    return rule;
}

function beats(selector: string, target: [number, number, number]): boolean {
    const [a, b, c] = specificity(selector);
    if (a !== target[0]) return a > target[0];
    if (b !== target[1]) return b > target[1];
    return c >= target[2];
}

describe('CONFIRM_BUTTON_CSS', () => {
    const rules = parseRules(CONFIRM_BUTTON_CSS);

    test('所有规则都带 button 前缀，且优先级不低于宿主通用 button:hover', () => {
        const hostHover: [number, number, number] = [0, 1, 1];
        const selectors = rules.flatMap((rule) => rule.selector.split(',').map((value) => value.trim()));
        expect(selectors.length).toBeGreaterThan(0);
        for (const selector of selectors) {
            expect(selector.startsWith('button.od-confirm-btn')).toBe(true);
            expect(beats(selector, hostHover)).toBe(true);
        }
    });

    test('危险按钮 hover 显式声明背景与文字颜色，避免被宿主 hover 背景覆盖', () => {
        const rule = findRule(rules, 'button.od-confirm-btn.od-confirm-btn-danger:hover');

        expect(rule.body).toMatch(/background:\s*var\(--mc-red\)/);
        expect(rule.body).toMatch(/color:\s*#fff/);
        expect(rule.body).toMatch(/filter:\s*brightness\(0\.9\)/);
    });

    test('主要按钮 hover 保留主题色系的背景', () => {
        const rule = findRule(rules, 'button.od-confirm-btn.od-confirm-btn-primary:hover');

        expect(rule.body).toMatch(/background:\s*var\(--mc-accent-hover\)/);
        expect(rule.body).toMatch(/color:\s*#fff/);
    });

    test('取消按钮 hover 使用主题 hover 底色，保留暗色下的反馈', () => {
        const rule = findRule(rules, 'button.od-confirm-btn.od-confirm-btn-cancel:hover');

        expect(rule.body).toMatch(/background:\s*var\(--mc-hover\)/);
        expect(rule.body).toMatch(/border-color:\s*var\(--mc-accent\)/);
    });
});
