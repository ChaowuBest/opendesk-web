/**
 * Issue #217 配套单元测试：parseMarkdownSafe 分块渲染与整体 marked.parse 的一致性。
 *
 * 分块只在 marked 语义下确定独立的块之间进行，跨块结构（宽松列表、引用式
 * 链接定义、缩进代码、原始 HTML 块、行间公式）通过延续合并与全局定义前置
 * 补偿。本文件逐一对齐这些场景：分块渲染的输出必须与整体渲染逐字节一致。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { createSafeMarkdownParser, RAW_FALLBACK_CLASS } from '../../common/markdown/safe-render.js';

function createParser(options?: Parameters<typeof createSafeMarkdownParser>[1]) {
    const marked = new Marked();
    marked.use({ gfm: true, breaks: false });
    const parse = (src: string) => marked.parse(src) as string | Promise<string>;
    return {
        marked,
        parseMarkdownSafe: createSafeMarkdownParser(parse, options)
    };
}

/**
 * 多段落填充：总长超过单块上限（迫使走分块路径），但每个段落远小于上限
 * （避免触发降级路径干扰一致性断言）。
 */
function paragraphFiller(paragraphs = 30): string {
    return ('用于拉开距离的填充段落。'.repeat(3) + '\n\n').repeat(paragraphs);
}

/** 构造超过单块上限的正常文档，各场景元素分布足够远以保证落在不同分块 */
function buildLargeNormalDocument(targetLength: number): string {
    const sections: string[] = [];
    let i = 0;
    while (sections.join('').length < targetLength) {
        i += 1;
        sections.push(
            `## 章节 ${i}\n\n` +
                `这一段介绍第 ${i} 条规则的来龙去脉，包含中英文混排与 [链接](src/module/file${i}.ts)。\n\n` +
                '- 列表项甲\n- 列表项乙\n- 列表项丙\n\n' +
                '| 列一 | 列二 |\n| --- | --- |\n| a | b |\n\n' +
                '```ts\n' +
                `// 代码示例 ${i}：围栏内部包含空行，分块器不得切开\n` +
                `const value${i} = 1;\n\n` +
                `function helper${i}() {\n  return value${i} + 1;\n}\n` +
                '```\n\n' +
                '行间公式验证：\n\n$$\nE = mc^2\n$$\n\n'
        );
    }
    return sections.join('');
}

describe('parseMarkdownSafe 基础行为', () => {
    test('小输入走快路径，输出与 marked.parse 逐字节一致', async () => {
        const { marked, parseMarkdownSafe } = createParser();
        const src = '# 标题\n\n正文段落，包含 [链接](a.ts) 与 `code`。\n\n- 列表项\n';
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('空输入与纯空白输入安全', async () => {
        const { marked, parseMarkdownSafe } = createParser();
        await expect(parseMarkdownSafe('')).resolves.toBe(await marked.parse(''));
        await expect(parseMarkdownSafe('   \n  ')).resolves.toBe(await marked.parse('   \n  '));
    });

    test('无空行的病态单行超限块降级为转义纯文本块且内容不丢失', async () => {
        const { parseMarkdownSafe } = createParser({ maxChunkLength: 2048 });
        const payload = '{"result":"' + '[模块](src/module.ts) 与 '.repeat(500) + '"}';
        const html = await parseMarkdownSafe(payload);
        expect(html).toContain(RAW_FALLBACK_CLASS);
        // 内容完整保留（转义后仍在文档中），且不再被解析成链接/胶囊
        expect(html).toContain('&quot;result&quot;');
        expect(html).not.toContain('<a href');
    });

    test('超长围栏代码块仍按代码渲染，不触发降级', async () => {
        const { parseMarkdownSafe } = createParser({ maxChunkLength: 2048 });
        const fenceBody = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join('\n');
        expect(fenceBody.length).toBeGreaterThan(2048);
        const html = await parseMarkdownSafe('```ts\n' + fenceBody + '\n```\n\n后续段落\n');
        expect(html).not.toContain(RAW_FALLBACK_CLASS);
        expect(html).toContain('const value199 = 199;');
        expect(html).toContain('后续段落');
    });

    test('围栏内部包含空行时不会被打散成多个代码块', async () => {
        const { parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n后面正文\n';
        const html = await parseMarkdownSafe(src);
        expect(html.match(/<pre><code/g)).toHaveLength(1);
        expect(html).toContain('const b = 2;');
    });

    test('未闭合围栏到文末按围栏处理且不降级', async () => {
        const { parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const body = 'const x = 1;\n\n' + '[x](y) '.repeat(200);
        const html = await parseMarkdownSafe('```txt\n' + body);
        expect(html).not.toContain(RAW_FALLBACK_CLASS);
        expect(html).toContain('const x = 1;');
    });

    test('行间公式跨空行时整体保留，不产生残片', async () => {
        const { parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = '$$\nx = 1\n\ny = 2\n$$\n\n后续段落\n';
        const html = await parseMarkdownSafe(src);
        expect(html).toContain('x = 1');
        expect(html).toContain('y = 2');
        expect(html.match(/\$\$/g)).toHaveLength(2);
    });

    test('单块解析抛错时该块降级，其余块正常渲染', async () => {
        const marked = new Marked();
        const original = marked.parse.bind(marked);
        const parse = (src: string) => {
            if (src.includes('BOOM')) {
                throw new Error('parse error');
            }
            return original(src) as string;
        };
        const parseMarkdownSafe = createSafeMarkdownParser(parse, { maxChunkLength: 256 });
        // 总长度超过单块上限，确保走分块路径；BOOM 块独立成一个分块
        const filler = paragraphFiller();
        const src = `正常段落一\n\n${filler}BOOM 段落\n\n正常段落二\n`;
        const html = await parseMarkdownSafe(src);
        expect(html).toContain('<p>正常段落一</p>');
        expect(html).toContain('<p>正常段落二</p>');
        expect(html).toContain(RAW_FALLBACK_CLASS);
        expect(html).toContain('BOOM');
    });

    test('小输入快路径保持 marked.parse 的异常语义（向上传播）', async () => {
        const parse = () => {
            throw new Error('parse error');
        };
        const parseMarkdownSafe = createSafeMarkdownParser(parse);
        await expect(parseMarkdownSafe('短文本')).rejects.toThrow(/parse error/);
    });

    test('CRLF 文本的围栏闭合与空行边界识别正确', async () => {
        const { parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = '段落一\r\n\r\n```js\r\nconst a = 1;\r\n\r\nconst b = 2;\r\n```\r\n\r\n段落二\r\n';
        const html = await parseMarkdownSafe(src);
        expect(html.match(/<pre><code/g)).toHaveLength(1);
        expect(html).toContain('<p>段落一</p>');
        expect(html).toContain('<p>段落二</p>');
    });
});

describe('parseMarkdownSafe 与整体渲染的一致性', () => {
    test('超限的正常长文档分块渲染后与整体渲染输出一致', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 2048 });
        const src = buildLargeNormalDocument(16 * 1024);
        expect(src.length).toBeGreaterThan(16 * 1024);
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('宽松有序列表跨空行合并为一个列表（编号不重置）', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        // 填充段落位于列表之前把文档推过单块上限；列表项之间只有空行，
        // 属于同一个宽松列表，不得被切成多个 start 各异的列表
        const src = `${paragraphFiller()}\n\n3. 甲\n\n5. 乙\n\n7. 丙\n`;
        const chunked = await parseMarkdownSafe(src);
        const whole = await marked.parse(src);
        expect(chunked).toBe(whole);
        expect(chunked.match(/<ol /g)).toHaveLength(1);
        expect(chunked).toContain('start="3"');
        expect(chunked).not.toContain('start="5"');
    });

    test('宽松无序列表跨空行合并', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        // 条目与延续段落之间只有空行，须保持同一列表
        const src = `${paragraphFiller()}\n\n- 甲\n\n  延续段落\n\n- 乙\n\n${paragraphFiller()}`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('引用式链接定义在用法之后仍全局生效', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `见 [文档][ref]。\n\n${paragraphFiller()}\n\n[ref]: https://example.com/doc\n`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('引用式链接定义在用法之前同样生效', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `[ref]: https://example.com/doc\n\n${paragraphFiller()}\n\n见 [文档][ref]。\n`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('列表项内层的引用定义同样全局注册', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `- 条目\n\n  [li]: https://example.com/li\n\n${paragraphFiller()}\n\n使用 [li][]。\n`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('块引用内的引用定义全局注册', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `> [q]: https://example.com/q\n\n${paragraphFiller()}\n\n使用 [q][]。\n`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('缩进代码块跨空行保持为一个代码块', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `    code-a\n\n    code-b\n\n${paragraphFiller()}`;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html.match(/<pre><code/g)).toHaveLength(1);
    });

    test('Tab 缩进代码块跨空行保持为一个代码块', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `\tcode-a\n\n\tcode-b\n\n${paragraphFiller()}`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('原始 HTML 块（pre/script）内部空行不打断', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = '<pre>\n原始文本一\n\n原始文本二\n</pre>\n\n后文\n';
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        // pre 是原始 HTML 块：内部内容不得被 markdown 二次解析
        expect(html).not.toContain('<p>原始文本一</p>');
    });

    test('HTML 注释跨空行保持原样', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = '<!--\n注释一\n\n注释二\n-->\n\n后文\n';
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('行间公式开栏行携带内容时跨空行保护', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = '$$ x =\n1\n\ny = 2\n$$\n\n后文\n';
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html.match(/\$\$/g)).toHaveLength(2);
    });

    test('一致性：超过单块上限但预算内的宽松列表保持整块（真实数据回归）', async () => {
        // 真实任务数据发现的分歧：列表整体超过单块上限后按条目软切分，
        // 尾部块丢失宽松列表语义（<li><p> 变 <li>）。范围在 2 倍预算内的
        // 列表必须保持整块。条目使用 2 空格缩进的延续段落（条目偏移 2）。
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const items = Array.from(
            { length: 6 },
            (_, i) =>
                `- **方案 ${i + 1} (推荐): 抽取模块核心能力为可配置组件，包含足够的文字让条目超过一行**\n  将模块重构为支持配置项的组件，通过属性/配置控制功能模块的显隐，同时解决样式的注入问题。这种方式改动量适中，复用性最好。\n\n`
        ).join('');
        const src = `${paragraphFiller(6)}${items}`;
        expect(src.length).toBeGreaterThan(256);
        const chunked = await parseMarkdownSafe(src);
        expect(chunked).toBe(await marked.parse(src));
        expect(chunked.match(/<ul>/g)).toHaveLength(1);
        expect(chunked).toContain('<li><p>');
    });

    test('一致性：列表内的缩进围栏与条目后紧邻围栏', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = [
            `${paragraphFiller(6)}- 条目甲`,
            '  ```js',
            '  const a = 1;',
            '',
            '  const b = 2;',
            '  ```',
            '',
            '- 条目乙',
            '```text',
            '顶层围栏内容',
            '```',
            '',
            paragraphFiller(6)
        ].join('\n');
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('一致性：文末无换行符的孤立围栏行留在段落内（真实数据回归）', async () => {
        // 真实任务数据发现的分歧：marked 的段落延续排除要求围栏行带换行符，
        // 文末的孤立 ``` 行不会打断段落，必须留在段落内而不是被隔离成代码块
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const filler = paragraphFiller();
        const src = `${filler}要动手的话，我建议按 1 → 4 → 3 的顺序做（1 是零风险纯减法；4 直接掐断循环；3 放最后）。\n\`\`\``;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('放最后）。\n```</p>');
        expect(html).not.toContain('<pre><code>\n</code></pre>');
    });

    test('一致性：段落中间的 $$ 行不打断段落（真实行为对齐）', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller()}文字甲\n$$ x =\n1\n\n${paragraphFiller()}`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('一致性：带换行符的围栏行仍打断段落', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller()}说明文字：\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${paragraphFiller()}`;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('<pre><code class="language-js">const a = 1;\n</code></pre>');
    });

    test('全角空格行不是空行（保持段落延续语义）', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        // marked 视全角空格行为段落内容：整体是一个段落，分块不得按其切分
        const src = `段落甲\n\u3000\n段落乙\n\n${paragraphFiller()}`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
        const html = await parseMarkdownSafe(src);
        expect(html).toContain('<p>段落甲\n　\n段落乙</p>');
    });

    test('混合结构大文档分块渲染与整体渲染逐字节一致', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 2048 });
        const base = buildLargeNormalDocument(12 * 1024);
        const extra = [
            '3. 甲\n\n5. 乙\n',
            '见 [文档][ref] 与 [其他][other]。\n',
            '- 条目\n\n  [li]: https://example.com/li\n',
            '    缩进代码一\n\n    缩进代码二\n',
            '<pre>\n原始一\n\n原始二\n</pre>\n',
            '$$ x =\n1\n\ny = 2\n$$\n'
        ].join('\n\n');
        const src = `${base}\n\n${extra}\n\n${base}\n\n使用 [ref][]、[other][]、[li][]。\n`;
        expect(src.length).toBeGreaterThan(12 * 1024);
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('一致性：保整列表内的引用式链接（定义前置覆盖豁免块）', async () => {
        // 保整列表块超出单块上限时走豁免路径，同样需要前置引用定义，
        // 否则列表内跨块的引用式链接会失效
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const items = Array.from(
            { length: 6 },
            (_, i) =>
                `- **方案 ${i + 1}**: 见 [文档][ref] 与足够的说明文字让列表整体超过单块上限，包含更多内容填充。**\n  延续段落补充说明，包含更多文字使每个条目都有可观的长度，确保列表范围超过上限。\n\n`
        ).join('');
        const src = `[ref]: https://example.com/doc\n\n${paragraphFiller(4)}${items}`;
        expect(src.length).toBeGreaterThan(256);
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('<a href="https://example.com/doc">');
    });

    test('一致性：纯 \\r 行分隔文档（对齐 marked 的归一化）', async () => {
        // marked 的 carriageReturn = /\r\n|\r/g 把孤立 \r 也当行终止符；
        // 分块器的行分割必须一致，否则纯 \r 文档会整体降级
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src =
            '段落甲\r段落乙\r\r- 列表项\r\r```js\rconst a = 1;\r```\r\r' +
            paragraphFiller().replace(/\n/g, '\r') +
            '\r\r段落丙';
        expect(src.length).toBeGreaterThan(256);
        expect(src).not.toContain('\n');
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('一致性：表格紧跟段落行（表格打断段落）', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller()}文字\n| a | b |\n| - | - |\n| 1 | 2 |\n\n${paragraphFiller()}`;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('<table>');
    });

    test('一致性：围栏 info 含反引号时按段落处理', async () => {
        // marked 的块围栏拒绝含反引号的 info string：起始行退化为段落，
        // 其后的闭合围栏行反而打开新围栏并吞并后文
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller(4)}\`\`\`a\`b\ncode line\n\`\`\`\n\n后文\n`;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('<p>```a`b\ncode line</p>');
    });

    test('一致性：4 反引号闭合 3 反引号围栏、~~~ 与 ``` 混用', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const quad = '````';
        const src1 = `${paragraphFiller(4)}\`\`\`js\ncode\n${quad}\n\n${paragraphFiller(4)}`;
        await expect(parseMarkdownSafe(src1)).resolves.toBe(await marked.parse(src1));
        // ~~~ 围栏不会被 ``` 闭合，未闭合时吞并后续全部内容
        const src2 = `${paragraphFiller(4)}~~~js\ncode\n\`\`\`\n\n后文也属于代码\n`;
        await expect(parseMarkdownSafe(src2)).resolves.toBe(await marked.parse(src2));
    });

    test('一致性：type-6 div 跨空行按独立块拆分', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller(4)}<div>\n内容一\n\n内容二\n</div>\n\n${paragraphFiller(4)}`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('一致性：块引用内围栏跨空行（marked 拆为两个引用）', async () => {
        // marked 的块引用跨空行是两个独立 blockquote（非 CommonMark 宽松引用），
        // 按空行切分恰好一致
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller(4)}> \`\`\`\n> 代码一\n\n> 代码二\n> \`\`\`\n\n${paragraphFiller(4)}`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('一致性：超过单块上限的巨型表格降级但内容完整', async () => {
        // 无空行的超长普通块（如巨型表格）会降级为纯文本块：内容零丢失，
        // 仅放弃版式——这是有意的安全边界
        const { parseMarkdownSafe } = createParser({ maxChunkLength: 2048 });
        const rows = Array.from({ length: 120 }, (_, i) => `| 单元格 ${i}-1 | 单元格 ${i}-2 | 单元格 ${i}-3 |`).join(
            '\n'
        );
        const table = `| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n${rows}`;
        expect(table.length).toBeGreaterThan(2048);
        const html = await parseMarkdownSafe(`${paragraphFiller(4)}${table}`);
        expect(html).toContain(RAW_FALLBACK_CLASS);
        expect(html).toContain('单元格 119-3');
    });

    test('一致性：分隔线先于列表项判定（* * * 不是列表）', async () => {
        // marked 的块 token 尝试顺序 hr 在 list 之前：'* * *' 是分隔线，
        // 其后的 def 行在新块起始位置（真实数据回归）
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller(6)}* * *  \n[ref-c]: https://example.com/c (圆括号标题)\n\n使用 [引用 C][ref-c]。\n`;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('title="圆括号标题"');
    });

    test('一致性：列表内缩进围栏遇顶格行时条目终结', async () => {
        // 真实数据回归：条目内的缩进围栏在顶格行处结束（顶格行成为顶层
        // 段落），其后的围栏形态行开启新的顶层围栏，内部空行不打断
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = [
            paragraphFiller(6),
            '- [ ] 待办\n- [x] 完成\n- [ ] 也是待办',
            '   ```js\n一至三空格缩进的合法围栏\n   ```',
            'Tab\t内嵌与\t行',
            '[A]: https://example.com/case',
            '',
            '大小写不敏感 [a][] 与 [A][]。',
            '转义：\\*星\\[框\\\\杠。',
            '',
            paragraphFiller(6)
        ].join('\n');
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('一致性：条目内容偏移量（标记后空白宽度）决定缩进行归属（模糊测试回归）', async () => {
        // '-   仅空格条目' 的内容偏移是 4：其后 3 空格缩进的围栏行不属于
        // 条目（列表已终结、围栏是顶层的），分块不得误吸收入条目块
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = [
            paragraphFiller(6),
            '-\n- 空条目后有内容\n-   仅空格条目',
            '   ```js\n一至三空格缩进的合法围栏\n   ```',
            '',
            paragraphFiller(6)
        ].join('\n');
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('<pre><code class="language-js">一至三空格缩进的合法围栏\n</code></pre>');
    });

    test('一致性：块终结行后顶格 HTML 标签按块级语义开块（模糊测试回归）', async () => {
        // 标题（块终结行）之后的顶格 <P> 是块级 HTML 块（/i 语义），
        // 不是段落延续
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller(6)}#### H4\n<P>大写标签 DIV 风格</P>\n- 下一项\n\n${paragraphFiller(6)}`;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('<P>大写标签 DIV 风格</P>');
    });

    test('一致性：行中自终结 HTML 块后的 def 候选提取（模糊测试回归）', async () => {
        // 空分隔符把 <?php...?> 与 def 拼到同一行：PI token 在行中结束后，
        // 行中余下的 def 是块起始并注册——前置定义必须覆盖它
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 2048 });
        const src =
            '<?php echo x; ?>[ref-a]: https://example.com/a\n\n使用 [引用 A][ref-a]。\n\n' +
            paragraphFiller(60) +
            '\n\n<?php echo x; ?>[ref-a]: https://example.com/a\n\n使用 [引用 A][ref-a]。';
        expect(src.length).toBeGreaterThan(2048);
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).toContain('<a href="https://example.com/a">引用 A</a>');
    });

    test('一致性：缩进代码块跨空行始终整块保留（模糊测试回归）', async () => {
        // 缩进代码内容不进内联正则，整块保留并豁免降级（此前在边界软切分
        // 会把一个代码块切成两个）
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const code = Array.from({ length: 12 }, (_, i) => `    line-${i} 缩进代码内容填充`).join('\n\n');
        const src = `#### H4\n${code}\n\n${paragraphFiller(6)}`;
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html.match(/<pre><code/g)).toHaveLength(1);
    });

    test('一致性：KaTeX 块公式要求独占行的闭合定界符（模糊测试回归）', async () => {
        // '$$<br>x'、'$$x'、'$$######' 这类行中闭合不构成块公式（KaTeX 规则：
        // 闭合 $$ 后仅允许空白）；开栏前必须验证存在独占行的闭合 $$，否则
        // 误开会吸收到文末并触发降级
        const marked = new Marked();
        marked.use(markedKatex({ throwOnError: false, displayMode: true, nonStandard: true }));
        const parseMarkdownSafe = createSafeMarkdownParser((s) => marked.parse(s), { maxChunkLength: 2048 });
        const src = '$$ x =\n1 + 2\n$$###### 七个井号是段落\n\n' + paragraphFiller(80);
        expect(src.length).toBeGreaterThan(2048);
        const html = await parseMarkdownSafe(src);
        expect(html).toBe(await marked.parse(src));
        expect(html).not.toContain(RAW_FALLBACK_CLASS);
    });

    test('一致性：顶格大写 HTML 标签终结列表条目', async () => {
        // marked 的块级 HTML 规则大小写不敏感：顶格 <P> 终结列表条目并成为
        // 顶层 HTML 块（其后的行被原始内容吸收直至空行）
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 256 });
        const src = `${paragraphFiller(6)}- 仅空格条目\n<P>大写标签 DIV 风格</P>\n- 下一项\n\`\`\`js\ntop level\n\`\`\`\n- 回到列表\n\n${paragraphFiller(6)}`;
        await expect(parseMarkdownSafe(src)).resolves.toBe(await marked.parse(src));
    });

    test('阈值边界：恰好等于与超过单块上限的输入', async () => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: 2048 });
        const base = '# 标题\n\n正文段落。\n\n'.repeat(200);
        const atLimit = base.slice(0, 2048);
        await expect(parseMarkdownSafe(atLimit)).resolves.toBe(await marked.parse(atLimit));
        const overLimit = base.slice(0, 2049);
        await expect(parseMarkdownSafe(overLimit)).resolves.toBe(await marked.parse(overLimit));
    });
});

// ── 差分模糊测试：结构组合文档与整体渲染逐字节比对 ──────────────────

// 确定性伪随机（mulberry32），保证失败可复现
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 结构片段库：覆盖所有块级结构与行内边缘形态
const FUZZ_SNIPPETS: string[] = [
    '这是一个普通段落，包含中英文混排与标点，用来填充正文内容。',
    '包含行内元素的段落：[链接](src/module/file.ts)、**加粗**、*斜体*、`inline code`、$x^2$ 公式与 ~~删除线~~。',
    'Auto link: https://example.com/path?a=1&b=2 和 <https://example.org> 以及 mail@example.com。',
    '转义字符：\\* 不斜体、\\[ 不是链接、\\\\ 反斜杠。',
    '行尾两个空格构成硬换行  \n下一行内容与硬换行衔接。',
    '包含 CJK 标点的段落：中文，标点！疑问？冒号：括号（内容）【标签】《书名》。',
    '# 一级标题',
    '## 二级标题 ##',
    'Setext 一级\n=========',
    'Setext 二级\n---------',
    '- 无序项一\n- 无序项二\n- 无序项三',
    '* 星号项\n\n+ 加号项',
    '1. 有序一\n2. 有序二\n5. 有序跳号',
    '3) 右括号一\n4) 右括号二',
    '- [ ] 待办事项\n- [x] 已完成事项',
    '- 宽松列表项\n\n  缩进延续段落，使列表成为宽松列表。\n\n- 下一项',
    '- 嵌套列表\n  - 二级嵌套\n    - 三级嵌套\n- 回到一级',
    '- 列表项内围栏\n  ```js\n  const a = 1;\n\n  const b = 2;\n  ```\n- 下一项',
    '- 列表项内引用\n  > 引用内容\n\n- 下一项',
    '```js\nconst a = 1;\nconst b = 2;\n```',
    '```ts\n// 围栏内空行\nconst x = 1;\n\nconst y = 2;\n```',
    '~~~python\ndef f():\n    return 1\n~~~',
    '```text\n~~~\n波浪线在代码内\n~~~\n```',
    '````\n三反引号在代码内\n```\n````',
    '$$\nE = mc^2\n$$',
    '$$ x =\n1 + 2\n$$',
    '$$a$$ 单行公式后接文本',
    '<pre>\n预格式化一\n\n预格式化二\n</pre>',
    '<script>\nvar a = 1;\n\nvar b = 2;\n</script>',
    '<!--\n多行注释一\n\n注释二\n-->',
    '<div class="x">\n直接内容\n\n<p>段落内容</p>\n</div>',
    '<table><tr><td>内联表格</td></tr></table>',
    '> 引用内容第一行\n> 引用内容第二行',
    '> 引用中的**加粗**与 [链接](a.ts)',
    '> 外层引用\n> > 内层引用',
    '> 引用内围栏\n> ```\n> 代码一\n\n> 代码二\n> ```',
    '| 列一 | 列二 | 列三 |\n| --- | :--: | --: |\n| a | b | c |\n| 长 | 行 | 内容 |',
    '[ref-a]: https://example.com/a\n\n使用 [引用 A][ref-a]。',
    '使用 [引用 B][ref-b]。\n\n[ref-b]: https://example.com/b "标题"',
    '---',
    '***',
    '___',
    '    缩进代码一\n    缩进代码二\n\n    缩进代码三',
    '段落后跟多个空行\n\n\n\n下一段落',
    '　全角空格行\n正文续行',
    '段落中的特殊字符: <>&"\' 端点。'
];

// 分隔符池：含 \\r 与 \\r\\n，覆盖行终止符归一化路径
const FUZZ_SEPARATORS = ['\n\n', '\n\n', '\n', '', '\r', '\r\n\r\n'];

function composeFuzzDoc(rng: () => number): string {
    const count = 8 + Math.floor(rng() * 10);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        parts.push(FUZZ_SNIPPETS[Math.floor(rng() * FUZZ_SNIPPETS.length)]);
    }
    let doc = parts.join(FUZZ_SEPARATORS[Math.floor(rng() * FUZZ_SEPARATORS.length)]);
    // 保证绝大多数文档走分块路径（超过默认阈值的 1.5 倍）
    while (doc.length < 24_000) {
        doc += '\n\n' + doc;
    }
    return doc;
}

describe('parseMarkdownSafe 差分模糊测试', () => {
    const runSeeds = async (from: number, to: number, cap: number) => {
        const { marked, parseMarkdownSafe } = createParser({ maxChunkLength: cap });
        for (let seed = from; seed < to; seed++) {
            const rng = mulberry32(seed);
            const doc = composeFuzzDoc(rng);
            const direct = await marked.parse(doc);
            const safe = await parseMarkdownSafe(doc);
            if (direct !== safe) {
                let i = 0;
                while (i < direct.length && i < safe.length && direct[i] === safe[i]) i++;
                fs.writeFileSync(path.join(os.tmpdir(), `fuzz-mismatch-seed${seed}-cap${cap}.md`), doc);
                throw new Error(
                    `seed=${seed} cap=${cap} len=${doc.length} 首个差异@${i}\n` +
                        `direct: ${JSON.stringify(direct.slice(Math.max(0, i - 80), i + 80))}\n` +
                        `safe:   ${JSON.stringify(safe.slice(Math.max(0, i - 80), i + 80))}`
                );
            }
        }
    };

    test('300 份组合文档与整体渲染逐字节一致（真实阈值）', async () => {
        await runSeeds(0, 150, 16_384);
        await runSeeds(150, 300, 16_384);
    }, 60_000);

    test('300 份组合文档与整体渲染逐字节一致（边界密集小阈值）', async () => {
        await runSeeds(0, 150, 1_500);
        await runSeeds(150, 300, 1_500);
    }, 60_000);
});
