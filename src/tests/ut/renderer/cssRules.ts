/**
 * 样式断言测试的 CSS 规则提取工具（唯一入口，不要在测试里再复制一份）。
 *
 * 适用场景：需要断言某个选择器的声明值（滚动条粗细、折行规则等），
 * 但又不想额外引入 CSS 解析依赖。支持的写法范围刻意做窄：
 * - "选择器组 { 声明 }" 结构，选择器组可用逗号分隔并跨行；
 * - 顶层规则，以及 @media / @container / @supports 里的一层规则（会递归进去）；
 * - 注释先剥离，避免注释文本干扰声明解析；
 * - 选择器比较前把连续空白归一化，因此跨行书写的选择器组也能匹配。
 *
 * 不适用：需要层叠/优先级计算、@layer、嵌套 CSS（& 语法）等场景。
 */

interface CssRule {
    selectors: string[];
    body: string;
}

function normalizeSelector(selector: string): string {
    return selector.replace(/\s+/g, ' ').trim();
}

/** 按书写顺序遍历所有扁平规则（含一层 at-rule 内部规则）。 */
function* iterateRules(css: string): Generator<CssRule, void, void> {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let index = 0;
    while (index < text.length) {
        const open = text.indexOf('{', index);
        if (open === -1) return;
        const prelude = text.slice(index, open).trim();
        let depth = 1;
        let cursor = open + 1;
        while (cursor < text.length && depth > 0) {
            if (text[cursor] === '{') depth++;
            else if (text[cursor] === '}') depth--;
            cursor++;
        }
        const body = text.slice(open + 1, cursor - 1);
        if (prelude.startsWith('@')) {
            yield* iterateRules(body);
        } else {
            yield { selectors: prelude.split(',').map(normalizeSelector), body };
        }
        index = cursor;
    }
}

/**
 * 提取指定选择器的声明体。selector 可命中选择器组里的任意成员。
 * 未找到时直接抛错：让断言失败在"规则不存在"上，而不是在空文本上恒真。
 */
export function ruleBody(css: string, selector: string): string {
    const target = normalizeSelector(selector);
    for (const rule of iterateRules(css)) {
        if (rule.selectors.includes(target)) return rule.body;
    }
    throw new Error(`未在 CSS 中找到规则: ${selector}`);
}

/**
 * 提取声明值（去掉 !important 与首尾空白）。
 * 注意：同一属性若在规则内出现多次，只返回第一处。
 */
export function declaration(body: string, property: string): string | undefined {
    const value = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`))?.[1];
    return value?.replace(/\s*!important\s*$/, '').trim();
}
