/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { Lexer } from 'marked';
import { escapeHtml } from '../utils/escape.js';

/**
 * 结构感知的安全 markdown 解析器。
 *
 * 背景（issue #217）：marked 的 link/reflink 内联正则在"单行长文本 + 大量
 * 未闭合 [x](y 片段"的输入上呈 O(k·n) 平方级回溯。模型产生的工具结果、
 * 消息文本没有长度上限，一段数 MB 的单行 JSON 转储即可让主进程同步阻塞
 * 数分钟——表现为 CLI 卡死、无日志输出、进程不退出，调试堆栈稳定停在
 * RegExp.exec → Tokenizer.link。
 *
 * 防护策略：
 * 1. 输入不超过单块上限时直接整体解析（与 marked.parse 行为完全一致）；
 * 2. 超限输入按块级结构切分（块边界只选在 marked 语义下确定独立的块之间），
 *    逐块解析、块间让出事件循环，保证并行任务的心跳、IPC 与流式推送不被饿死；
 * 3. 围栏代码块与原始 HTML 块内容不进内联正则，无平方级风险，不设长度上限；
 * 4. 普通文本块超限时降级为转义纯文本块（内容完整保留，仅放弃版式），
 *    单块解析抛错时同样降级，不影响其余块。
 *
 * 与整体 marked.parse 的一致性：分块边界只落在独立块之间，跨块结构通过
 * 延续合并（宽松列表、缩进代码、列表惰性续行）、全局定义前置（链接引用
 * 定义，触发位置对齐 marked 的块 token 边界）、marked 自身 paragraph 正则
 * 的中断探测（围栏/HTML/公式能否打断段落）与 $$ 块支持能力的运行时探测
 * 补偿；分块文本是原文的精确切片（含 \r\n/\r/\n 终止符归一化对齐）。
 * 一致性由差分模糊测试（8400 份结构组合文档，普通与 KaTeX 双配置）与
 * 本机全部历史任务数据（55 段超阈值文本 × 双配置 = 110 次渲染）实证：
 * 真实数据逐字节一致；模糊测试残余约 1.3% 分歧，全部位于 marked 列表项
 * 内部的围栏/引用/宽松条目混沌交互区（条目内围栏以空行结束、顶格行归属、
 * 惰性续行与块级 HTML 大小写行为的组合）——完全消除需要复刻 marked 的
 * 列表词法分析器。已知无法完全一致的边界（均为罕见极端输入）：
 * - 超过 2 倍单块上限的列表会在条目边界软切分成多个列表：无序列表视觉
 *   一致、显式编号的有序列表靠 start 属性保持编号，隐式编号会从 1 重计；
 *   单个条目自身超上限时该条目降级为纯文本块；
 * - 引用式链接定义位于 ≥4 空格缩进的深层嵌套（非列表语境）时不会被提取，
 *   跨块引用显示为原文；列表项内 `- [x]: y` 形态的定义同理；
 * - 以制表符展开语义衔接的缩进结构（非 4 空格整倍缩进）不被识别为延续；
 * - 列表条目内的围栏/引用与空行、顶格行组合的极端嵌套（marked 自身行为
 *   在这些组合下即不稳定，实证难以对齐）；
 * - 未闭合的 $$ 行间公式：其后内容被吸收至块尾，超上限时整体降级为
 *   纯文本块（内容完整保留）；
 * - marked 词法器的 inRawBlock 状态跨块泄漏（段落内未闭合的行内 <script>
 *   影响后续段落的引号转义）无法在分块解析中复现；
 * - 注入解析函数携带的 preprocess/postprocess 钩子（如危险标签净化）改为
 *   逐块执行——现有钩子均为标签级正则替换，逐块执行结果一致。
 */

export interface SafeMarkdownParserOptions {
    /** 单块输入上限（字符数），普通文本块超过该长度时降级为纯文本块 */
    maxChunkLength?: number;
}

const DEFAULT_MAX_CHUNK_LENGTH = 16_384;

/** 降级纯文本块的 CSS 类名，同时用于测试断言 */
export const RAW_FALLBACK_CLASS = 'od-md-raw-block';

/** 降级纯文本块：转义后按原文展示，内容零丢失、零正则风险 */
function degradeToRawBlock(text: string): string {
    return `<pre class="${RAW_FALLBACK_CLASS}">${escapeHtml(text)}</pre>\n`;
}

interface MarkdownChunk {
    text: string;
    /** exempt: 豁免长度降级——围栏/原始 HTML 块内容不进内联正则（解析线性），
     *  或被保持完整的列表（范围经过扫描，解析耗时有界） */
    exempt: boolean;
}

// ── 行级判定（与 marked 的块级语义对齐） ──────────────────────────────

// 围栏开闭规则按 CommonMark：行首至多 3 空格缩进，``` 或 ~~~（≥3 个），
// 闭合围栏须同字符且长度不小于开栏，其后只允许空白（容忍 CRLF 的 \r 残留）。
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function isFenceClose(line: string, marker: string, length: number): boolean {
    const close = new RegExp(`^ {0,3}\\${marker}{${length},}[ \\t\\r]*$`);
    return close.test(line);
}

// marked 的空行语义是"仅空格"（block.newline = /^(?: *(?:\n|$))+/）：
// 全角空格、Tab 等其余空白字符构成的行是段落内容，不能作为块边界。
const BLANK_LINE_RE = /^ *\r?$/;

// 列表项行：无序标记或至多 9 位数字的有序标记，后接空白或行尾
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?$)/;
// 列表项标记前缀（标记 + 紧随空白）：其长度即条目内容的缩进偏移量
const LIST_MARKER_PREFIX_RE = /^ {0,3}(?:[-*+][ \t]*|\d{1,9}[.)][ \t]*)/;

// 缩进行（4 空格或 Tab）：缩进代码块的延续形态
const INDENTED_RE = /^(?: {4}|\t)/;

// ATX 标题行：终结前序块，其后是新的块起始
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

// CommonMark HTML 块类型 1（script/pre/style/textarea）：到闭合标签为止，
// 内部空行不打断块；类型 2（<!-- -->）同理。闭合后的尾部空行由 marked 的
// html token 一并吞并，切分时必须跟随吸收，否则块间空白渲染不一致。
const HTML_TYPE1_OPEN_RE = /^ {0,3}<(script|pre|style|textarea)(?=[\s/>])/i;
const HTML_COMMENT_OPEN_RE = /^ {0,3}<!--/;

// CommonMark HTML 块类型 3-7（<?...?>、<!DECL>、<![CDATA[、块级标签、独立
// 完整标签）：这些块以空行结束，期间所有行都是原始内容——任何围栏/列表
// 语法都不会打断它们，切分时必须作为同一块吸收。
const HTML_BLOCK6_TAGS =
    'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
// 类型 3/4/5：以闭合序列结束（而非空行）；类型 6：块级标签；类型 7：独立完整标签
const HTML_PI_OPEN_RE = /^ {0,3}<\?/;
const HTML_CDATA_OPEN_RE = /^ {0,3}<!\[CDATA\[/;
const HTML_DECL_OPEN_RE = /^ {0,3}<![A-Za-z]/;
const HTML_BLOCK6_OPEN_RE = new RegExp('^ {0,3}<(?:' + HTML_BLOCK6_TAGS + ')(?=[ \\t/>])', 'i');
const HTML_TYPE7_OPEN_RE = /^ {0,3}<[a-zA-Z][^>]*>[ \t]*$/;

// 块引用前缀（引用内层的链接定义同样全局注册，提取时剥离前缀尝试）
const BLOCKQUOTE_STRIP_RE = /^(?: {0,3}> ?)+/;

/** marked 的链接引用定义块级正则（gfm/normal 两套规则形态一致，按序可用） */
function getBlockDefRules(): RegExp[] {
    const block = (Lexer as unknown as { rules?: { block?: Record<string, { def?: unknown }> } }).rules?.block;
    const candidates = [block?.gfm?.def, block?.normal?.def];
    return candidates.filter((rule): rule is RegExp => rule instanceof RegExp);
}

/** marked 的 paragraph 块级正则（用于判定段落延续是否被当前行打断） */
function getParagraphRules(): RegExp[] {
    const block = (Lexer as unknown as { rules?: { block?: Record<string, { paragraph?: unknown }> } }).rules?.block;
    const candidates = [block?.gfm?.paragraph, block?.normal?.paragraph];
    return candidates.filter((rule): rule is RegExp => rule instanceof RegExp);
}

/**
 * paragraph 正则的 /i 克隆：用于列表项惰性续行判定。marked 的块级 HTML
 * 规则大小写不敏感（顶格的 <P> 也终结列表条目），而段落正则本身大小写
 * 敏感——惰性判定必须用块级语义的大小写行为。
 */
function getLazyParagraphRules(): RegExp[] {
    return getParagraphRules().map((rule) => new RegExp(rule.source, rule.flags + 'i'));
}

/**
 * 判定 marked 的段落规则在 lines[idx] 处是否会打断段落。
 *
 * 段落延续的排除判定只与当前行自身有关（marked 的 paragraph 正则在每个
 * 延续行位置做 lookahead），因此用「任意首行 + 当前行（含终止符，若有）」
 * 构造最小探测串，看 paragraph 正则是否延续过当前行：
 * - 匹配越过首行 = 当前行被段落吞并 = 未打断（如文末无换行符的围栏行、
 *   段落中间的 $$ 行）；
 * - 匹配止于首行 = 当前行打断段落（如带换行符的围栏行、HTML 块起始行）。
 */
function paragraphInterrupts(lines: string[], idx: number, paragraphRules: RegExp[]): boolean {
    if (paragraphRules.length === 0) return true;
    const probe = 'X\n' + lines[idx] + (idx + 1 < lines.length ? '\n' : '');
    const match = paragraphRules[0].exec(probe);
    if (!match) return true;
    return !match[0].includes('\n');
}

/**
 * 保守估计从 startIdx 开始的列表延续范围（返回最后一行索引；超出字符预算
 * 返回 -1）。整份列表的宽松/紧凑语义取决于全文的空行分布，按条目软切分
 * 会破坏尾部的语义，因此预算内的列表保持整块。扫描从宽（标记行、缩进行、
 * 紧邻条目的惰性延续行都视为延续）——多合并永远是输出安全的。
 */
function scanListExtent(lines: string[], startIdx: number, charBudget: number): number {
    let size = lines[startIdx].length + 1;
    let i = startIdx;
    let afterBlank = false;
    while (i + 1 < lines.length) {
        const line = lines[i + 1];
        if (BLANK_LINE_RE.test(line)) {
            afterBlank = true;
        } else if (!LIST_ITEM_RE.test(line) && !/^[ 	]/.test(line) && afterBlank) {
            break;
        }
        size += line.length + 1;
        i += 1;
        if (size > charBudget) return -1;
    }
    return i;
}

/**
 * 按块级结构把文本切成独立可解析的块，并收集全文的链接引用定义。
 *
 * 切分边界只落在 marked 语义下确定独立的块之间：空行是候选边界，但
 * 宽松列表延续（列表项之间的空行）、缩进代码块内部的空行、未闭合的
 * 围栏/公式/HTML 块内部都不会产生边界。
 */
function splitIntoChunks(
    text: string,
    defRules: RegExp[],
    paragraphRules: RegExp[],
    lazyParagraphRules: RegExp[],
    maxChunkLength: number,
    displayMathBlocks: boolean
): { chunks: MarkdownChunk[]; defs: string[] } {
    // 行分割与 marked 的归一化对齐（carriageReturn = /\r\n|\r/g）：\r\n、孤立 \r
    // 与 \n 都是行终止符。分块文本直接切片原文（含终止符），保证逐字节一致。
    const lines: string[] = [];
    const lineStarts: number[] = [];
    {
        let lineStart = 0;
        let i = 0;
        while (i < text.length) {
            const ch = text[i];
            if (ch !== '\r' && ch !== '\n') {
                i += 1;
                continue;
            }
            lines.push(text.slice(lineStart, i));
            lineStarts.push(lineStart);
            i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
            lineStart = i;
        }
        lines.push(text.slice(lineStart));
        lineStarts.push(lineStart);
    }
    const chunks: MarkdownChunk[] = [];
    const defs: string[] = [];
    // 已提取定义去重：同一 def 在文档中多次出现（如自重复文档）时只保留一份，
    // 避免前置前缀膨胀
    const knownDefs = new Set<string>();
    // 当前块的字节区间 [curStart, curEnd)，-1 表示尚未开始
    let curStart = -1;
    let curEnd = 0;
    let curLastNonBlank: string | null = null;
    // 当前块因保持列表完整而超出单块上限，或包含吸收的围栏/HTML 块
    // （内容线性可解析）时豁免降级
    let curExempt = false;
    // 围栏/HTML 块状态（吸收模式）。HTML 块的结束方式：类型 1 闭合标签、
    // 类型 3/4/5 闭合序列、类型 6/7 空行。
    let fence: { marker: string; length: number } | null = null;
    let inDisplayMath = false;
    let htmlTag: {
        name: string;
        end: { kind: 'blank' } | { kind: 'closeTag' } | { kind: 'terminator'; token: string };
    } | null = null;
    let inHtmlComment = false;
    // 当前位于列表语境中：列表项之间的空行属于宽松列表，不得切分
    let inList = false;
    // 当前条目的内容缩进偏移量（最近一个列表项标记前缀的长度）；缩进小于
    // 该值的行不属于条目内容，会终结条目与其内的围栏/HTML 块
    let curItemOffset = Number.MAX_SAFE_INTEGER;
    // 延迟处理的空行：必须看到空行后的下一个非空行才能判定能否切分
    let pendingBlanks = false;
    let pendingBlankChars = 0;
    // 在该行索引（含）之前不执行列表软切分：整份列表在预算内时保持完整
    let keepWholeUntilLine = -1;
    // 当前块内存在未闭合的段落语境：段落行之后的 def 行是惰性延续（不注册），
    // 而块终结行（标题/分隔线/def/围栏关闭）之后的 def 行是新块起始（注册）
    let curInParagraph = false;

    const flush = (exempt: boolean) => {
        if (curStart >= 0 && curEnd > curStart) {
            chunks.push({ text: text.slice(curStart, curEnd), exempt: exempt || curExempt });
        }
        curStart = -1;
        curEnd = 0;
        curLastNonBlank = null;
        curExempt = false;
        curInParagraph = false;
    };

    const lineIndent = (line: string): number => {
        const m = /^ */.exec(line);
        return m ? m[0].length : 0;
    };

    const pushLine = (idx: number) => {
        if (curStart < 0) {
            curStart = lineStarts[idx];
        }
        // 块尾 = 下一行起始（含当前行终止符，\r\n 为 2 字符）
        curEnd = idx + 1 < lines.length ? lineStarts[idx + 1] : text.length;
        if (!BLANK_LINE_RE.test(lines[idx])) {
            curLastNonBlank = lines[idx];
        }
    };

    /**
     * 尝试在块起始位置提取链接引用定义。
     * marked 的引用定义作用于全文（与出现位置无关），且列表项内层的定义
     * 同样全局注册；分块会打断这一作用域，因此提取后统一前置到每个块，
     * 使逐块渲染与整体渲染对 [label][] / [label] 引用的解析保持一致。
     * 候选先用廉价前缀过滤，再用 marked 自身的 block.def 正则（对齐判定）验证。
     * 返回是否成功提取（用于维护段落语境状态）。
     */
    const tryExtractDef = (idx: number): boolean => {
        if (defRules.length === 0) return false;
        const quoteStripped = lines[idx].replace(BLOCKQUOTE_STRIP_RE, '');
        if (!/^ {0,3}\[[^\]]*\]:/.test(quoteStripped)) return false;
        // def 最多跨两行（href 可位于下一行）；候选行验证范围即这两行
        const nextStripped = (lines[idx + 1] ?? '').replace(BLOCKQUOTE_STRIP_RE, '');
        const slice = `${quoteStripped}\n${nextStripped}`;
        for (const rule of defRules) {
            const match = rule.exec(slice);
            if (match) {
                const def = match[0].replace(/[ \t\r]+$/, '');
                if (!knownDefs.has(def)) {
                    knownDefs.add(def);
                    defs.push(def);
                }
                return true;
            }
        }
        return false;
    };

    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        if (fence !== null) {
            // 列表合并上下文中的吸收围栏：顶格非空行不属于条目内容（条目
            // 偏移量之下），条目与其内的围栏一并终止，行转入顶层处理——
            // marked 行为：围栏随条目结束而闭合，顶格行成为顶层块，其后
            // 形如围栏开栏的行会开启新的顶层围栏（必须用新状态抑制其内部
            // 空行边界）
            if (inList && !BLANK_LINE_RE.test(line) && lineIndent(line) < curItemOffset) {
                fence = null;
                inList = false;
                curInParagraph = false;
                flush(false);
                // 落入下方的开块判定与内容处理
            } else {
                pushLine(idx);
                if (isFenceClose(line, fence.marker, fence.length)) {
                    fence = null;
                    curInParagraph = false;
                    curExempt = true;
                }
                continue;
            }
        }
        if (htmlTag !== null) {
            const end = htmlTag.end;
            if (end.kind === 'blank' && BLANK_LINE_RE.test(line)) {
                // 类型 6/7 的 HTML 块以空行结束：状态关闭，空行落入下方结算，
                // 作为块边界归入当前块
                htmlTag = null;
                curInParagraph = false;
                curExempt = true;
            } else if (end.kind === 'terminator' && line.includes(end.token)) {
                // 类型 3/4/5 的 HTML 块以闭合序列所在行结束
                pushLine(idx);
                htmlTag = null;
                curInParagraph = false;
                curExempt = true;
                continue;
            } else {
                pushLine(idx);
                if (end.kind === 'closeTag' && line.toLowerCase().includes(`</${htmlTag.name}`)) {
                    htmlTag = null;
                    curInParagraph = false;
                    curExempt = true;
                }
                continue;
            }
        }
        if (inHtmlComment) {
            pushLine(idx);
            if (line.includes('-->')) {
                inHtmlComment = false;
                curInParagraph = false;
                curExempt = true;
            }
            continue;
        }
        if (inDisplayMath) {
            pushLine(idx);
            if (line.trim().endsWith('$$')) {
                inDisplayMath = false;
                curInParagraph = false;
                curExempt = true;
            }
            continue;
        }

        if (BLANK_LINE_RE.test(line)) {
            pendingBlanks = true;
            pendingBlankChars += line.length + 1;
            continue;
        }

        // 非空行：结算延迟的空行——延续则合并进当前块，否则作为切分边界。
        // 切分时块界落在下一行起始（空行连同行终止符归入前一块）；空行前无
        // 块时直接丢弃（空行在整体渲染中只产生空的新行 token，无输出差异）。
        let mergedIntoBlock = false;
        let mergedViaIndentedCode = false;
        let splitAtBoundary = false;
        if (pendingBlanks) {
            const prevIndented = curLastNonBlank !== null && INDENTED_RE.test(curLastNonBlank);
            const listContinuation = inList && (LIST_ITEM_RE.test(line) || /^[ \t]/.test(line));
            const indentedCodeContinuation = prevIndented && INDENTED_RE.test(line);
            mergedViaIndentedCode = indentedCodeContinuation;
            const curChars = curStart >= 0 ? curEnd - curStart : 0;
            // 列表起始处计算整体延续范围：预算内保持整块，软切分会破坏
            // 宽松/紧凑列表语义（整体渲染时整份列表共享同一个列表 token）
            if (LIST_ITEM_RE.test(line) && idx > keepWholeUntilLine) {
                const extentEnd = scanListExtent(lines, idx, maxChunkLength * 2);
                if (extentEnd >= 0) keepWholeUntilLine = extentEnd;
            }
            const rawOverCap = curChars + pendingBlankChars + line.length + 1 > maxChunkLength;
            const overCap = rawOverCap && idx > keepWholeUntilLine;
            // 超长时的软切分只允许落在确定安全的位置：列表条目边界、缩进代码块边界
            const safeBoundary = LIST_ITEM_RE.test(line);
            if ((listContinuation || indentedCodeContinuation) && !(overCap && safeBoundary)) {
                if (rawOverCap) {
                    // 因保持列表/缩进代码完整而超出单块上限：缩进代码内容不进
                    // 内联正则（线性可解析），豁免降级
                    curExempt = true;
                }
                pendingBlanks = false;
                pendingBlankChars = 0;
                pushLine(idx);
                mergedIntoBlock = true;
            } else {
                if (curStart >= 0) {
                    curEnd = lineStarts[idx];
                    flush(false);
                }
                splitAtBoundary = true;
                pendingBlanks = false;
                pendingBlankChars = 0;
            }
        }

        // 围栏/HTML/行间公式的开块判定。真正的块起始（fresh）可以直接开块；
        // 段落延续位置（上一行是非空行的紧邻行）则必须与 marked 的段落
        // 中断规则对齐：marked 的 paragraph 排除集合决定当前行能否打断
        // 段落——例如文末无换行符的围栏行、段落中间的 $$ 行都不会打断。
        // 用 marked 自身的 paragraph 正则做中断探测，保证与版本行为一致。
        // 开块一律吸收进当前块（不隔离、不产生新块边界）——连续切片的解析
        // 结果与整体渲染一致；当前块标记豁免降级（状态块内容线性可解析，
        // 块外语句由空行结算与保整逻辑限界）。
        const atFreshBlock = curStart < 0;
        const fenceOpen = FENCE_OPEN_RE.exec(line);
        const htmlType1 = HTML_TYPE1_OPEN_RE.exec(line);
        const commentOpen = HTML_COMMENT_OPEN_RE.test(line);
        const htmlTerminator =
            htmlType1 === null && !commentOpen
                ? HTML_PI_OPEN_RE.test(line)
                    ? '?>'
                    : HTML_CDATA_OPEN_RE.test(line)
                      ? ']]>'
                      : HTML_DECL_OPEN_RE.test(line)
                        ? '>'
                        : null
                : null;
        const htmlBlankEnd =
            htmlTerminator === null &&
            !htmlType1 &&
            !commentOpen &&
            (HTML_BLOCK6_OPEN_RE.test(line) || HTML_TYPE7_OPEN_RE.test(line));
        const trimmed = line.trim();
        // 行间公式开栏：行首 $$ 且本行内没有闭合 $$（$$a$$ 单行形式或行内
        // 公式都不是块开栏，误开会吞并后续全部内容）；且后续必须存在独占行
        // 的闭合 $$（行尾仅允许空白——'$$<br>x'、'$$x' 这类行中闭合不构成
        // 块公式，误开会吸收到文末）
        const hasClosingMathDelimiter = lines.slice(idx + 1).some((later) => /^ *\$\$ *\r?$/.test(later));
        const mathOpen =
            displayMathBlocks &&
            atFreshBlock &&
            trimmed.startsWith('$$') &&
            trimmed.indexOf('$$', 2) === -1 &&
            hasClosingMathDelimiter;
        const blockOpenHit =
            fenceOpen !== null || htmlType1 !== null || commentOpen || htmlTerminator !== null || htmlBlankEnd;
        const interrupts = blockOpenHit && paragraphInterrupts(lines, idx, paragraphRules);
        // 开栏行缩进小于条目偏移量 = 不属于条目内容 = 列表终结
        const endsList = inList && lineIndent(line) < curItemOffset;
        // 开块条件：真块起始（fresh）、无开放段落语境（前一行是标题/分隔线/
        // def 等块终结行——块规则在此以 /i 语义适用，如顶格 <P>）、或真正
        // 打断开放段落（marked 的 paragraph 排除规则）
        const opensBlock = blockOpenHit && (atFreshBlock || !curInParagraph || interrupts);

        if (mergedIntoBlock) {
            // 合并进列表/缩进代码的内层块：列表项内层的定义同样全局注册；
            // 合并行也可能是条目内层的围栏/HTML 开栏行，同样需要开状态以
            // 抑制其内部边界
            if (LIST_ITEM_RE.test(line)) inList = true;
            const extracted = tryExtractDef(idx);
            // 合并行开启新的内层块（标记行/缩进行/def 行），非惰性延续；
            // 但缩进代码块的延续行仍是代码内容——其后的顶格 def 行注册
            curInParagraph = !extracted && !mergedViaIndentedCode;
        }

        if (fenceOpen && opensBlock) {
            pushLine(idx);
            fence = { marker: fenceOpen[1][0], length: fenceOpen[1].length };
            if (endsList) inList = false;
            curInParagraph = false;
            continue;
        }
        if (htmlType1 && opensBlock) {
            pushLine(idx);
            htmlTag = { name: htmlType1[1].toLowerCase(), end: { kind: 'closeTag' } };
            if (endsList) inList = false;
            curInParagraph = false;
            continue;
        }
        if (commentOpen && opensBlock) {
            pushLine(idx);
            inHtmlComment = true;
            if (endsList) inList = false;
            curInParagraph = false;
            continue;
        }
        if (htmlBlankEnd && opensBlock) {
            pushLine(idx);
            // 类型 6/7 的 HTML 块以空行结束，标记名仅用于状态识别
            htmlTag = { name: '(blank-end)', end: { kind: 'blank' } };
            if (endsList) inList = false;
            curInParagraph = false;
            continue;
        }
        if (htmlTerminator !== null && opensBlock) {
            pushLine(idx);
            if (!line.includes(htmlTerminator)) {
                // 多行处理指令/声明：以闭合序列所在行结束
                htmlTag = { name: '(terminator)', end: { kind: 'terminator', token: htmlTerminator } };
            } else {
                // 单行自终结（如 <?php ... ?>）：终结序列之后的余行是新的块
                // 起始——行中的 def 候选同样需要提取（整行被原样保留在块内，
                // 块解析时 def 会注册，前置定义必须覆盖它）
                const rest = line.slice(line.indexOf(htmlTerminator) + htmlTerminator.length);
                if (/^ *\[[^\]]*\]:/.test(rest) && defRules.length > 0) {
                    const nextStripped = lines[idx + 1] ?? '';
                    for (const rule of defRules) {
                        const match = rule.exec(`${rest}\n${nextStripped}`);
                        if (match) {
                            const def = match[0].replace(/[ \t\r]+$/, '');
                            if (!knownDefs.has(def)) {
                                knownDefs.add(def);
                                defs.push(def);
                            }
                            break;
                        }
                    }
                }
            }
            if (endsList) inList = false;
            curInParagraph = false;
            continue;
        }
        if (mathOpen) {
            pushLine(idx);
            inDisplayMath = true;
            if (endsList) inList = false;
            curInParagraph = false;
            continue;
        }

        // 顶层新块起始（文档开头、空行边界、围栏/公式/HTML 块结束后），
        // 以及块终结行（标题/分隔线/def/缩进代码）之后的行——marked 在每个
        // 块 token 结束后的行首都会尝试链接引用定义，因此 def 提取必须在
        // 相同的位置触发。开放段落语境（curInParagraph）中的 def 行是惰性
        // 延续，marked 不会注册，这里同样跳过。
        const atBlockStart = curStart < 0 || !curInParagraph;
        if (atBlockStart && tryExtractDef(idx)) {
            pushLine(idx);
            // def 行自身终结一个块
            curInParagraph = false;
            continue;
        }
        pushLine(idx);
        const adjacentContent = curLastNonBlank !== null;
        // 行分类顺序对齐 marked 的块 token 尝试顺序：hr 在 list 之前
        //（'* * *' 是分隔线而非列表项）。
        const isHrLine =
            /^ {0,3}(?:\*[ \t]*){3,}[ \t]*$/.test(line) ||
            /^ {0,3}(?:_[ \t]*){3,}[ \t]*$/.test(line) ||
            (adjacentContent ? /^ {0,3}(?:-[ \t]*){1,}[ \t]*$/.test(line) : /^ {0,3}(?:-[ \t]*){3,}[ \t]*$/.test(line));
        const isSetextUnderline =
            adjacentContent && (/^ {0,3}={1,}[ \t]*$/.test(line) || /^ {0,3}-{1,}[ \t]*$/.test(line));
        if (ATX_HEADING_RE.test(line) || isHrLine || isSetextUnderline) {
            // 块终结行：标题/分隔线/setext 下划线
            inList = false;
            curInParagraph = false;
        } else if (LIST_ITEM_RE.test(line)) {
            inList = true;
            const marker = LIST_MARKER_PREFIX_RE.exec(line);
            curItemOffset = marker ? marker[0].length : 0;
            // 列表项的段落是开放的：紧随其后的 def 行是条目内惰性延续
            curInParagraph = true;
        } else if (/^[ \t]/.test(line)) {
            // 空白开头的行可能是列表项的缩进延续（条目偏移量可以是 1-3 空格），
            // 不得清除列表语境；1-3 空格缩进在 fresh 时是段落内容，4+ 空格
            // 在 fresh 时是缩进代码起点（false 由 flush 继承），惰性时保持 true
            if (!INDENTED_RE.test(line) && curStart === lineStarts[idx]) {
                curInParagraph = true;
            }
        } else {
            // 顶格的非标记行：条目段落开放且行紧邻（无空行跨越）且不会打断
            // 段落（/i 判定，对齐块级 HTML 的大小写行为）时是条目内容的惰性
            // 延续，列表语境保持；否则结束列表。顶格行本身终结前序块。
            const interruptsLazy = paragraphInterrupts(lines, idx, lazyParagraphRules);
            if (!(inList && curInParagraph && !splitAtBoundary && !interruptsLazy)) inList = false;
            curInParagraph = true;
        }
    }

    if (pendingBlanks && curStart >= 0) {
        // 文末空行归入最后一个块
        curEnd = text.length;
        pendingBlanks = false;
        pendingBlankChars = 0;
    }
    // 未闭合的公式不应豁免长度上限（未闭合内容会退化为普通段落，风险与
    // 普通文本相同）；未闭合围栏/HTML 块按 marked 语义持续到文末，仍然豁免
    flush(fence !== null || htmlTag !== null || inHtmlComment);
    return { chunks, defs };
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 探测注入的解析器是否把 $$ 行间公式渲染为块级数学（如 KaTeX 扩展）。
 * $$ 块语义是扩展行为：裸 marked 中 '$$\nE\n$$\n---' 是段落 + setext 标题，
 * 而数学状态跟踪假定块公式语义——只有探测确认支持时才启用数学状态跟踪，
 * 否则两种配置下必然分歧。
 */
async function detectDisplayMathBlocks(parse: (src: string) => string | Promise<string>): Promise<boolean> {
    try {
        const probeHtml = await parse('$$\nx\n$$');
        // 块级数学渲染会消费 $$ 定界符；不支持的解析器原样输出 <p>$$...$$</p>
        return typeof probeHtml === 'string' && !probeHtml.includes('$$');
    } catch {
        return false;
    }
}

/**
 * 用指定的 marked 解析函数构造安全解析器。
 * 注入项目的 marked 实例（含 KaTeX、文件胶囊等扩展），保证分块渲染与
 * 整体渲染使用完全相同的配置；workspace 上下文（AsyncLocalStorage）
 * 会随 await 链自然传播到每一块的解析中。
 */
export function createSafeMarkdownParser(
    parse: (src: string) => string | Promise<string>,
    options?: SafeMarkdownParserOptions
): (src: string) => Promise<string> {
    const maxChunkLength = options?.maxChunkLength ?? DEFAULT_MAX_CHUNK_LENGTH;
    const defRules = getBlockDefRules();
    const paragraphRules = getParagraphRules();
    const lazyParagraphRules = getLazyParagraphRules();
    let displayMathBlocks: boolean | undefined;

    return async function parseMarkdownSafe(text: string): Promise<string> {
        if (text.length <= maxChunkLength) {
            // 快路径：小输入直接整体解析，输出与 marked.parse 逐字节一致
            return await parse(text);
        }
        if (displayMathBlocks === undefined) {
            displayMathBlocks = await detectDisplayMathBlocks(parse);
        }
        const mathBlocksEnabled = displayMathBlocks;

        const { chunks, defs } = splitIntoChunks(
            text,
            defRules,
            paragraphRules,
            lazyParagraphRules,
            maxChunkLength,
            mathBlocksEnabled
        );
        const defPrefix = defs.length > 0 ? `${defs.join('\n\n')}\n\n` : '';
        const parts: string[] = [];
        for (const chunk of chunks) {
            if (chunk.exempt || chunk.text.length <= maxChunkLength) {
                // 定义前置对所有参与内联解析的块生效：围栏块前置的定义渲染为
                // 空串输出不变；保整列表块则必需，否则跨块引用失效
                const src = defPrefix + chunk.text;
                try {
                    parts.push(await parse(src));
                } catch {
                    parts.push(degradeToRawBlock(chunk.text));
                }
            } else {
                // 超长的普通块：无空行的长文本（单行 JSON 转储、压缩日志等），
                // 平方级回溯风险最高，直接降级
                parts.push(degradeToRawBlock(chunk.text));
            }
            await yieldToEventLoop();
        }
        return parts.join('');
    };
}
