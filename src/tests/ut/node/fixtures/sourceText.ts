/**
 * node 测试里「按源码结构取一段代码」的公共工具。
 *
 * 结构类断言必须先拿到真实方法/函数体再执行或匹配，各测试文件不要各写一份花括号
 * 配对逻辑（口径一旦分叉，同一种写法会在不同测试里得到不同结果）。
 */

/**
 * 从 openBraceIndex 处的 `{` 开始做括号配对，跳过字符串、模板字符串与注释。
 * @param text 源码全文
 * @param openBraceIndex 起始 `{` 的下标（必须在 text 内）
 * @returns 含最外层花括号的片段
 */
export function sliceBalancedBlock(text: string, openBraceIndex: number): string {
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = openBraceIndex; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (lineComment) {
            if (ch === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (ch === '*' && next === '/') {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote) {
            if (ch === '\\') escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '/' && next === '/') {
            lineComment = true;
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            blockComment = true;
            i++;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            continue;
        }
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(openBraceIndex, i + 1);
        }
    }
    throw new Error('花括号不配对');
}

/**
 * 截取顶层函数声明 `function name(...) { ... }` 的完整源码。
 * @param source 源码全文
 * @param functionName 函数名（不含 `function` 关键字）
 */
export function extractFunction(source: string, functionName: string): string {
    const marker = `function ${functionName}(`;
    const start = source.indexOf(marker);
    if (start < 0) {
        throw new Error(`未找到函数 ${functionName}`);
    }
    const braceIndex = source.indexOf('{', start + marker.length - 1);
    return source.slice(start, braceIndex) + sliceBalancedBlock(source, braceIndex);
}

/**
 * 截取类方法 `name() { ... }` 的方法体（不含方法签名与最外层花括号）。
 * @param classBlock 类源码片段
 * @param methodName 方法名
 * @returns 方法体；方法不存在时返回 null
 */
export function tryExtractMethodBody(classBlock: string, methodName: string): string | null {
    const marker = `${methodName}() {`;
    const start = classBlock.indexOf(marker);
    if (start < 0) return null;
    const block = sliceBalancedBlock(classBlock, start + marker.length - 1);
    return block.slice(1, -1);
}

/**
 * 同 tryExtractMethodBody，但方法缺失时直接失败 —— 断言里引用的方法名写错时不该静默通过。
 */
export function extractMethodBody(classBlock: string, methodName: string): string {
    const body = tryExtractMethodBody(classBlock, methodName);
    if (body === null) {
        throw new Error(`未找到方法 ${methodName}`);
    }
    return body;
}

/**
 * 把源码里的 `class X extends HTMLElement { ... }` 全部拆出来。
 * @param source 源码全文
 * @returns 类名 → 类源码片段（含最外层花括号）
 */
export function extractClasses(source: string): Map<string, string> {
    const classes = new Map<string, string>();
    const pattern = /class\s+(\w+)\s+extends\s+HTMLElement\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        classes.set(match[1], sliceBalancedBlock(source, match.index + match[0].length - 1));
    }
    return classes;
}
