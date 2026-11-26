import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import iconv from 'iconv-lite';
import { parseAndChunk } from '../../../../main/applications/filemgr/parser/index.js';

import { LLM } from '../../../../main/aikernel/llm.ts';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { chunkStructured } from '../../../../main/applications/filemgr/parser/chunk.js';
import {
    EXTRACT_TEXT_SUPPORTED_EXTENSIONS,
    extractText,
    isExtractTextSupported,
    RAW_TEXT_MAX_FILE_SIZE
} from '../../../../main/applications/filemgr/parser/extract.js';
import { setPlatform } from '../../../../platforms/base.js';
import { setRuntimeLocale } from '../../../../locale/index.js';

setRuntimeLocale('en-US');
setPlatform({
    getName: () => 'test',
    getEffectiveWorkspace: () => process.cwd(),
    initPlatformHarness: async () => {},
    fetch: (input, init) => fetch(input, init)
});

async function run(name, fn) {
    console.log(`  ${name}...`);
    await fn();
    console.log(`  ✅ ${name}`);
}

for (const encoding of ['utf8', 'utf16le', 'gbk'])
    await run(`plain text ${encoding} retains Chinese and ASCII through public parsing`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf1-parser-encoding-'));
        try {
            const text = 'ASCII header\n' + '中文编码检测，文件索引和工具提取应保留相同内容。'.repeat(20) + '\n末行';
            const file = path.join(dir, `${encoding}.txt`);
            fs.writeFileSync(file, iconv.encode(text, encoding, { addBOM: encoding === 'utf16le' }));
            assert.equal(await extractText(file), text);
            assert.equal((await parseAndChunk(file, { isChunk: false })).text, text);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

function writeOpenDocument(filePath, lines) {
    const zip = new AdmZip();
    const body = lines.map((line) => `<text:p>${line}</text:p>`).join('');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
    xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0">
    <office:body>${body}</office:body>
</office:document-content>`;
    zip.addFile('content.xml', Buffer.from(content, 'utf8'));
    zip.writeZip(filePath);
}

/**
 * 写入最小可解析 pptx：每张 slide 的文本由传入的 <a:t> 片段决定。
 * @param {string} filePath
 * @param {string[]} runs 每张 slide 的绘图文本 XML 片段
 */
function writePptx(filePath, runs) {
    const zip = new AdmZip();
    runs.forEach((runXml, index) => {
        const slide =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
            `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r>${runXml}</a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
        zip.addFile(`ppt/slides/slide${index + 1}.xml`, Buffer.from(slide, 'utf8'));
    });
    zip.writeZip(filePath);
}

/**
 * 写入最小 docx：word/document.xml 作为第一条 entry。
 * @param {string} filePath
 * @param {string} bodyText
 */
function writeDocx(filePath, bodyText) {
    const zip = new AdmZip();
    zip.addFile(
        'word/document.xml',
        Buffer.from(
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
                `<w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`,
            'utf8'
        )
    );
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>', 'utf8'));
    zip.writeZip(filePath);
}

/**
 * 破坏 zip 里指定 entry 的 deflate 数据，得到"结构完好、数据损坏"的文件。
 * 必须传入 officeparser 真正会读的 entry（docx 的 word/document.xml、odt/odp/ods 的 content.xml）：
 * 破坏它不会打开的 entry（如 docx 的 [Content_Types].xml）触发不了没有监听的 stream error，
 * 断言就失去了证伪能力。
 * @param {string} filePath
 * @param {string} entryName
 */
function corruptEntryData(filePath, entryName) {
    const buf = fs.readFileSync(filePath);
    // local header 在文件前部、中央目录在后部，indexOf 拿到的是 local header 的文件名位置
    const nameAt = buf.indexOf(Buffer.from(entryName, 'utf8'));
    assert.notEqual(nameAt, -1, `fixture 中找不到 entry ${entryName}`);
    assert.equal(buf.readUInt32LE(nameAt - 30), 0x04034b50, `entry ${entryName} 前不是 zip local header`);
    const dataStart = nameAt + buf.readUInt16LE(nameAt - 4) + buf.readUInt16LE(nameAt - 2);
    for (let i = dataStart; i < Math.min(dataStart + 24, buf.length); i++) buf[i] = 0xff;
    fs.writeFileSync(filePath, buf);
}

/**
 * 带超时地提取文本：解析卡死时让断言失败而不是拖住整个测试文件。
 * @param {string} filePath
 * @param {number} [timeoutMs]
 */
async function extractTextWithTimeout(filePath, timeoutMs = 15000) {
    let timer;
    try {
        const result = await Promise.race([
            extractText(filePath),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
            })
        ]);
        assert.notEqual(result, 'TIMEOUT', `解析 ${path.basename(filePath)} 超时（${timeoutMs}ms）`);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

await run('line-list txt is split before embedding-sized chunks', async () => {
    const text = Array.from({ length: 12811 }, (_, i) => `n04235860_${i}.JPEG`).join('\n');
    const result = chunkStructured(text, '/tmp/1percent.txt', { chunkSize: 1000 });
    const chunks = result.chunks ?? [];

    assert.equal(result.chunk_type, 'chunk');
    assert.ok(chunks.length > 1, 'line-list should not become one huge chunk');
    assert.ok(
        chunks.every((chunk) => chunk.text.length <= 1200),
        'chunks should stay close to the target size'
    );
    assert.ok(
        chunks.every((chunk) => chunk.text.includes('.JPEG')),
        'chunks should preserve line-list records'
    );
});

await run('oversized raw text file returns null for filename-only embedding fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-raw-limit-'));
    try {
        const filePath = path.join(dir, 'huge.js');
        fs.closeSync(fs.openSync(filePath, 'w'));
        fs.truncateSync(filePath, RAW_TEXT_MAX_FILE_SIZE + 1);

        const text = await extractText(filePath);

        assert.equal(text, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('opendocument files supported by officeparser are extracted and chunked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-opendocument-'));
    try {
        for (const ext of ['odt', 'odp', 'ods']) {
            const filePath = path.join(dir, `sample.${ext}`);
            writeOpenDocument(filePath, [`OpenDesk ${ext} heading`, `OpenDesk ${ext} body`]);

            assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes(ext), `.${ext} should be advertised`);
            assert.equal(isExtractTextSupported(filePath), true);

            const text = await extractText(filePath);
            assert.match(text, new RegExp(`OpenDesk ${ext} body`));

            const result = chunkStructured(text, filePath);
            assert.equal(result.chunk_type, 'chunk');
            assert.ok(result.chunks.length > 0);
            assert.match(result.chunks[0].text, new RegExp(`OpenDesk ${ext}`));
        }

        for (const ext of ['ppt']) {
            assert.equal(isExtractTextSupported(path.join(dir, `legacy.${ext}`)), false);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('pptx slide text is extracted and malformed slide xml does not leak unhandled rejection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-pptx-'));
    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
        const goodPath = path.join(dir, 'good.pptx');
        writePptx(goodPath, ['<a:t>first slide</a:t>', '<a:t>second slide</a:t>']);
        assert.equal(await extractText(goodPath), 'first slide\n\n===\n\nsecond slide');

        // 畸形 slide（重复属性）会让 xmldom 抛 ParseError；多页保证解析失败发生在 zip 'end' 之前
        const badPath = path.join(dir, 'bad.pptx');
        writePptx(badPath, [
            '<a:t>first slide</a:t>',
            '<a:t type="a" type="b">broken</a:t>',
            '<a:t>third slide</a:t>',
            '<a:t>fourth slide</a:t>'
        ]);
        assert.equal(await extractText(badPath), null);

        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(
            unhandled.map((reason) => String(reason)),
            [],
            'pptx 解析失败不应冒泡成进程级 unhandledRejection'
        );
    } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('damaged office archive entries are rejected without crashing the process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-office-damaged-'));
    try {
        const intactDocx = path.join(dir, 'sample.docx');
        writeDocx(intactDocx, 'OpenDesk docx body');
        assert.match(await extractText(intactDocx), /OpenDesk docx body/);

        // 结构完好但 officeparser 会读的 entry 数据损坏：它内部没有 stream error 监听，
        // 若不预校验会升级成进程级 uncaughtException（OpenDesk 会直接退出，测试进程同样会挂掉）
        for (const ext of ['docx', 'odt', 'odp', 'ods']) {
            const filePath = path.join(dir, `damaged.${ext}`);
            let targetEntry;
            if (ext === 'docx') {
                writeDocx(filePath, 'OpenDesk docx body');
                targetEntry = 'word/document.xml';
            } else {
                writeOpenDocument(filePath, ['OpenDesk open document body']);
                targetEntry = 'content.xml';
            }
            corruptEntryData(filePath, targetEntry);

            const result = await extractTextWithTimeout(filePath);
            assert.equal(result, null, `.${ext}: 数据损坏应返回 null`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('damaged xml entry that officeparser never reads does not block extraction', async () => {
    // 预校验范围必须与 officeparser 实际读取的 entry 对齐：破坏 [Content_Types].xml 这类
    // 它不会打开的 entry 时，正文仍然可以提取出来，不能整体退化成 null。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-office-irrelevant-damage-'));
    try {
        const filePath = path.join(dir, 'irrelevant-damage.docx');
        writeDocx(filePath, 'OpenDesk docx body');
        corruptEntryData(filePath, '[Content_Types].xml');

        const result = await extractTextWithTimeout(filePath);
        assert.equal(typeof result, 'string', '无关 entry 损坏不应让整份文档退化成 null');
        assert.match(result, /OpenDesk docx body/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('rtf files and rtf content with a doc extension are extracted as plain text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-rtf-'));
    try {
        const rtf = String.raw`{\rtf1\ansi OpenDesk\par RTF body}`;
        for (const ext of ['rtf', 'doc']) {
            const filePath = path.join(dir, `sample.${ext}`);
            fs.writeFileSync(filePath, rtf);

            assert.equal(isExtractTextSupported(filePath), true);
            assert.equal(await extractText(filePath), 'OpenDesk\nRTF body');
        }
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('rtf'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('legacy and modern excel files extract to tab-separated text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-excel-'));
    try {
        for (const ext of ['xls', 'xlsx']) {
            const filePath = path.join(dir, `sheet.${ext}`);
            const workbook = XLSX.utils.book_new();
            const sheet = XLSX.utils.aoa_to_sheet([
                ['name', 'status'],
                ['OpenDesk', ext]
            ]);
            XLSX.utils.book_append_sheet(workbook, sheet, 'Data');
            const metaSheet = XLSX.utils.aoa_to_sheet([
                ['owner', 'enabled'],
                ['OpenDesk', 'yes']
            ]);
            XLSX.utils.book_append_sheet(workbook, metaSheet, 'Meta');
            XLSX.writeFile(workbook, filePath, { bookType: ext });

            const text = await extractText(filePath);
            assert.equal(
                text,
                `[Data]\n1\tname\tstatus\n2\tOpenDesk\t${ext}\n\n[Meta]\n1\towner\tenabled\n2\tOpenDesk\tyes`
            );

            const result = chunkStructured(text, filePath);
            assert.equal(result.chunk_type, 'abstract');
            assert.match(result.chunks[0].text, /工作表: Data/);
            assert.match(result.chunks[0].text, /列名: \[行号, name, status\]/);
            assert.match(result.chunks[0].text, new RegExp(`2 \\| OpenDesk \\| ${ext}`));
            assert.match(result.chunks[0].text, /工作表: Meta/);
            assert.match(result.chunks[0].text, /列名: \[行号, owner, enabled\]/);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('wide table abstracts are capped before embedding', async () => {
    for (const { ext, separator } of [
        { ext: 'csv', separator: ',' },
        { ext: 'xlsx', separator: '\t' }
    ]) {
        const headers = Array.from({ length: 120 }, (_, i) => `column_${i}_${'h'.repeat(40)}`);
        const row = Array.from({ length: 120 }, (_, i) => `cell_${i}_${'v'.repeat(120)}`);
        const text = [headers.join(separator), ...Array.from({ length: 12 }, () => row.join(separator))].join('\n');
        const result = chunkStructured(text, `/tmp/wide.${ext}`);
        const chunks = result.chunks ?? [];

        assert.equal(result.chunk_type, 'abstract');
        assert.equal(chunks.length, 1);
        assert.ok(chunks[0].text.length <= 2000, `${ext} abstract too long: ${chunks[0].text.length}`);
        assert.match(chunks[0].text, /已截断/);
    }
});

await run('batchEmbed reports invalid embedding response shape', async () => {
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/embeddings') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'input too long' } }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    assert.ok(port, 'test server should bind a port');

    const settingDir = path.join(os.tmpdir(), `filemgr-parser-setting-${Date.now()}`);
    fs.mkdirSync(settingDir, { recursive: true });

    try {
        setCustomOpendeskDirectory(settingDir);
        Setting.clearCache();
        Setting.updateInstanceData({
            default_embedding_model: 'test-embed',
            default_reranker_model: '',
            default_model: '',
            default_intent_parsing_model: '',
            default_vision_model: '',
            providers: [
                {
                    name: 'local',
                    base_url: `http://127.0.0.1:${port}/v1`,
                    api_key: 'test',
                    no_proxy: true
                }
            ],
            models: [
                {
                    alias: 'test-embed',
                    provider_name: 'local',
                    model_name: 'test-embedding-model',
                    model_type: 'embedding'
                }
            ],
            applications: {}
        });

        await assert.rejects(
            () => LLM.batchEmbed(['oversized input'], 1),
            (err) => {
                assert.match(err.message, /invalid embedding response/i);
                assert.equal(err.status, 502);
                return true;
            }
        );
    } finally {
        Setting.clearCache();
        fs.rmSync(settingDir, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});
