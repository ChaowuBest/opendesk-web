import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractText, getPdfJsResourceDir } from '../../../../main/applications/filemgr/parser/extract.js';

const TURKISH_TEXT = 'Türkçe metin: ğĞ ıİ şŞ öÖ üÜ çÇ. İstanbul Prens Adalarında.';

/**
 * 依赖预定义 CMap 的语种样本。pdf.js 只在 /Encoding 指向预定义 CMap（而非
 * Identity-H 或内嵌 CMap）时才会去读 cmaps/ 目录下的 .bcmap；能覆盖到的语种
 * 即 pdf.js 内置的 CJK 家族（GB / CNS / JIS / KS）。
 */
const PREDEFINED_CMAP_CASES = [
    {
        label: '土耳其语',
        slug: 'turkish-predef-cmap',
        cmap: 'UniGB-UCS2-H',
        text: TURKISH_TEXT
    },
    {
        label: '简体中文',
        slug: 'zh-hans-predef-cmap',
        cmap: 'UniGB-UCS2-H',
        text: '简体中文测试：这是一段中文文本，用来验证提取。'
    },
    {
        label: '繁体中文',
        slug: 'zh-hant-predef-cmap',
        cmap: 'UniCNS-UCS2-H',
        text: '繁體中文測試：這是一段中文文本，用來驗證提取。'
    },
    {
        label: '日文',
        slug: 'ja-predef-cmap',
        cmap: 'UniJIS-UCS2-H',
        text: '日本語テスト：これは日本語のテキストです。'
    },
    {
        label: '韩文',
        slug: 'ko-predef-cmap',
        cmap: 'UniKS-UCS2-H',
        text: '한국어 테스트: 이것은 한국어 텍스트입니다.'
    }
];

interface PdfStreamObj {
    stream: Buffer;
    extra: string;
}

function utf16beCodes(text: string): number[] {
    const codes: number[] = [];
    for (const ch of text) codes.push(ch.codePointAt(0)!);
    return codes;
}

function hex4(value: number): string {
    return value.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * 按对象编号顺序写出一份最小 PDF（xref 表偏移手工计算，不带任何压缩流）。
 * @param objs 下标即对象编号；普通对象传字典字符串，流对象传 PdfStreamObj
 */
function buildPdf(objs: (string | PdfStreamObj | undefined)[]): Buffer {
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let pos = 0;
    chunks.push(Buffer.from('%PDF-1.7\n', 'latin1'));
    pos += 9;
    for (let i = 1; i < objs.length; i++) {
        const obj = objs[i];
        if (obj === undefined) continue;
        offsets[i] = pos;
        if (typeof obj === 'string') {
            const buf = Buffer.from(`${i} 0 obj\n${obj}\nendobj\n`, 'latin1');
            chunks.push(buf);
            pos += buf.length;
        } else {
            const head = Buffer.from(`${i} 0 obj\n<< ${obj.extra} >>\nstream\n`, 'latin1');
            const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
            chunks.push(head, obj.stream, tail);
            pos += head.length + obj.stream.length + tail.length;
        }
    }
    const xrefPos = pos;
    let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) {
        // 未分配的对象号写 free 条目，避免无效的 offset=0 in-use 条目让
        // pdf.js 走 xref 重建兜底，掩盖夹具本身的结构错误
        const entry =
            offsets[i] !== undefined ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
        xref += entry;
    }
    xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
}

/**
 * 构造一个最小化（不内嵌字体文件）的 Type0 字体 PDF。
 * CID 字体链路完整：charCode --(Encoding CMap)--> CID --(ToUnicode)--> Unicode。
 * 文本提取只依赖 Encoding CMap 与 ToUnicode 的加载，不需要字体字形数据。
 * @param text 页面文本内容
 * @param encodingVariant predefined: /Encoding 为预定义 CMap 名称（需要 pdf.js 从
 *   cmaps/ 目录加载 .bcmap，即用户反馈失效的场景）；embedded: /Encoding 为内嵌
 *   CMap 流（无需外部数据，作为对照）。
 * @param cmapName predefined 场景下使用的预定义 CMap 名称（不带斜杠）
 */
function buildCmapFontPdf(text: string, encodingVariant: 'predefined' | 'embedded', cmapName = 'UniGB-UCS2-H'): Buffer {
    const uniqueChars = [...new Set(text)];
    const cidOf = new Map(uniqueChars.map((ch, index) => [ch, index + 1]));
    const codeOf = (ch: string) => ch.codePointAt(0)!;

    const contentCodes = utf16beCodes(text)
        .map((code) => hex4(code))
        .join('');
    const content = `BT /F1 12 Tf 40 120 Td <${contentCodes}> Tj ET`;

    // ToUnicode：bfchar 逐条映射；predefined 场景下 pdf.js 按原始 charCode 查询，
    // embedded 场景下按 CID 查询（查不到时回退 charCode，链路两条都必须自洽）
    const tounicodePairs =
        encodingVariant === 'predefined'
            ? uniqueChars.map((ch) => [codeOf(ch), codeOf(ch)])
            : uniqueChars.map((ch) => [cidOf.get(ch)!, codeOf(ch)]);
    const bfcharEntries = tounicodePairs.map(([src, dst]) => `<${hex4(src)}> <${hex4(dst)}>`).join('\n');
    const tounicode =
        '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
        '/CMapName /ToUni def\n/CMapType 2 def\n' +
        '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
        `beginbfchar\n${bfcharEntries}\nendbfchar\n` +
        'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';

    let encodingValue: string;
    const objs: (string | PdfStreamObj | undefined)[] = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] =
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 200] ' +
        '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';

    if (encodingVariant === 'predefined') {
        encodingValue = `/${cmapName}`;
    } else {
        // 内嵌 CMap 流：显式 cidchar 把每个 charCode 映射到独立 CID
        const cmapBody =
            '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n' +
            '/CMapName /Custom-H def\n/CMapType 2 def\n/WMode 0 def\n' +
            '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
            `${uniqueChars.length} begincidchar\n` +
            uniqueChars.map((ch) => `<${hex4(codeOf(ch))}> ${cidOf.get(ch)!}`).join('\n') +
            '\nendcidchar\n' +
            'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
        objs[10] = {
            stream: Buffer.from(cmapBody, 'latin1'),
            extra: `/Length ${Buffer.byteLength(cmapBody, 'latin1')}`
        };
        encodingValue = '10 0 R';
    }

    objs[4] =
        `<< /Type /Font /Subtype /Type0 /BaseFont /ArialUni /Encoding ${encodingValue} ` +
        '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>';
    objs[6] =
        '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ArialUni ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> ' +
        '/FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>';
    objs[8] =
        '<< /Type /FontDescriptor /FontName /ArialUni /Flags 32 ' +
        '/FontBBox [-568 -307 2000 1027] /ItalicAngle 0 /Ascent 905 /Descent -212 ' +
        '/CapHeight 716 /StemV 80 >>';
    objs[5] = { stream: Buffer.from(content, 'latin1'), extra: `/Length ${Buffer.byteLength(content, 'latin1')}` };
    objs[7] = {
        stream: Buffer.from(tounicode, 'latin1'),
        extra: `/Length ${Buffer.byteLength(tounicode, 'latin1')}`
    };
    return buildPdf(objs);
}

function writeFixture(dir: string, name: string, data: Buffer): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, data);
    return filePath;
}

test('pdfjs-dist CMap/标准字体资源目录可解析且为 pdf.js 接受的正斜杠路径', () => {
    const cmapsDir = getPdfJsResourceDir('cmaps');
    const fontsDir = getPdfJsResourceDir('standard_fonts');
    assert.ok(cmapsDir, 'pdfjs-dist/cmaps 应随依赖存在（CMap 加载依赖它）');
    assert.ok(fontsDir, 'pdfjs-dist/standard_fonts 应随依赖存在');
    // pdf.js 的 getFactoryUrlProp 要求资源 url 以 "/" 结尾
    assert.ok(cmapsDir.endsWith('/'), `cMapUrl 必须以 / 结尾，实际: ${cmapsDir}`);
    assert.ok(fontsDir.endsWith('/'), `standardFontDataUrl 必须以 / 结尾，实际: ${fontsDir}`);
    assert.ok(fs.existsSync(path.join(cmapsDir, 'UniGB-UCS2-H.bcmap')), 'UniGB-UCS2-H.bcmap 应存在');
});

for (const { label, slug, cmap, text } of PREDEFINED_CMAP_CASES) {
    test(`依赖预定义 CMap（${cmap}）的${label} PDF 提取出完整文本`, async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-pdf-cmap-'));
        try {
            const filePath = writeFixture(tempDir, `${slug}.pdf`, buildCmapFontPdf(text, 'predefined', cmap));
            assert.equal(await extractText(filePath), text);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
}

test('Encoding 为内嵌 CMap 流的土耳其语 PDF 提取出完整文本', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-pdf-cmap-'));
    try {
        const filePath = writeFixture(
            tempDir,
            'turkish-embedded-cmap-stream.pdf',
            buildCmapFontPdf(TURKISH_TEXT, 'embedded')
        );
        assert.equal(await extractText(filePath), TURKISH_TEXT);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('普通简单字体 PDF 在新的 getDocumentProxy 配置下不受影响', async () => {
    const objs: (string | PdfStreamObj)[] = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] =
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 200] ' +
        '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    const content = 'BT /F1 12 Tf 40 120 Td (plain ascii pdf text) Tj ET';
    objs[5] = { stream: Buffer.from(content, 'latin1'), extra: `/Length ${Buffer.byteLength(content, 'latin1')}` };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-pdf-cmap-'));
    try {
        const filePath = writeFixture(tempDir, 'plain.pdf', buildPdf(objs));
        assert.equal(await extractText(filePath), 'plain ascii pdf text');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
