import fs from 'fs';
import os from 'os';
import path from 'path';
import iconv from 'iconv-lite';
import { decodeBuffer, detectEncoding } from '../../../main/applications/terminal/encoding';
import { ReadFileTool } from '../../../main/applications/filemgr/tools';

let tempRootDir: string | undefined;

function createTempDir(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-encoding-detect-'));
    return tempRootDir;
}

function cleanupTempDir(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

/**
 * 生成"头部纯 ASCII、中文只出现在尾部"的无 BOM UTF-8 文本 Buffer。
 * 真实源码文件（如 taskview.js：文件头是大量代码，中文注释散布在后面）就是这种形态，
 * chardet 只看头部 8KB 时样本全是 ASCII，会把它误判成 ISO-8859-1 等单字节编码。
 */
function buildAsciiHeadUtf8Buffer(totalBytes: number): Buffer {
    const filler = Buffer.from(
        Array.from({ length: 40 }, (_, i) => `    const value${i} = computeSomething(${i}); // padding line\n`).join(
            ''
        ),
        'utf8'
    );
    const chunks: Buffer[] = [];
    let written = 0;
    let insertedCjk = false;
    while (written < totalBytes) {
        chunks.push(filler);
        written += filler.length;
        // 头部 8KB 保持纯 ASCII，之后每个块插入一行中文注释（每个汉字 3 个 UTF-8 字节）
        if (written >= 8192) {
            chunks.push(Buffer.from(`    // 这里是一段中文注释 ${insertedCjk ? '重复' : ''}\n`, 'utf8'));
            insertedCjk = true;
            written += 39;
        }
    }
    return Buffer.concat(chunks);
}

describe('detectEncoding', () => {
    afterEach(() => {
        cleanupTempDir();
    });

    test('keeps BOM detection for UTF-8 / UTF-16 files', () => {
        expect(detectEncoding(Buffer.from('\ufeffhello', 'utf8'))).toEqual({ encoding: 'utf8', bomOffset: 3 });
        const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]);
        expect(detectEncoding(utf16le)).toEqual({ encoding: 'utf16le', bomOffset: 2 });
        // "hi" 的 UTF-16BE 字节 + BE BOM
        const utf16be = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
        expect(detectEncoding(utf16be)).toEqual({ encoding: 'utf16be', bomOffset: 2 });
    });

    test('prefers strict UTF-8 validation over chardet on ascii-head files with sparse CJK', () => {
        // 复现 readFile 中文乱码：头部 8KB 纯 ASCII 的无 BOM UTF-8 文件，
        // 修复前 chardet 对纯 ASCII 样本返回 ISO-8859-1（置信度最高），解码后中文全部变成乱码
        const buf = buildAsciiHeadUtf8Buffer(64 * 1024);
        const headHighBytes = [...buf.subarray(0, 8192)].filter((b) => b >= 0x80).length;
        expect(headHighBytes).toBe(0); // 确保样本确实命中"头部纯 ASCII"形态
        const result = detectEncoding(buf);
        expect(result.encoding).toBe('utf8');
        expect(result.bomOffset).toBe(0);
    });

    test('falls back to chardet for non-UTF-8 CJK encodings like GBK', () => {
        // 样本要足够长（chardet 统计检测在超短样本上不可靠），
        // 确保回退路径仍能把 GBK/GB18030 文本正确识别出来
        const gbkText = Array.from(
            { length: 30 },
            (_, i) => `你好，世界。这是用于编码检测测试的中文字符串，包含足够多的双字节序列。第${i}行。`
        ).join('\n');
        const gbkBytes = iconv.encode(gbkText, 'gbk');
        const result = detectEncoding(gbkBytes);
        expect(['GB18030', 'gb18030', 'gbk', 'gb2312']).toContain(result.encoding);
        const decoded = decodeBuffer(gbkBytes, result.encoding, result.bomOffset);
        expect(decoded).toContain('你好，世界');
    });

    test('detects GBK content hidden behind a pure-ASCII head when given the whole file', () => {
        // 头部 8KB 纯 ASCII、GBK 中文在后面：GBK 源码文件的常见形态
        //（生成代码/许可头在前，中文注释在后）。仅看头部会误判为 utf8。
        const gbkText = Array.from(
            { length: 40 },
            (_, i) => `// 这是GBK编码的中文注释，第${i}行，包含足够多的双字节汉字序列用来统计。`
        ).join('\n');
        const asciiHead = Buffer.alloc(8192, 0x41); // 8KB 纯 'A'
        const gbkTail = iconv.encode(gbkText, 'gbk');
        const mixed = Buffer.concat([asciiHead, gbkTail]);

        const result = detectEncoding(mixed);
        expect(['GB18030', 'gb18030', 'gbk', 'gb2312']).toContain(result.encoding);
        const decoded = decodeBuffer(mixed, result.encoding, result.bomOffset);
        expect(decoded).toContain('这是GBK编码的中文注释');
    });

    test('readFile recovers GBK text hidden behind a pure-ASCII head', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'gbk-source.js');
        const asciiHead = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i}; // padding line\n`).join('');
        const gbkBody = iconv.encode(
            Array.from({ length: 40 }, (_, i) => `// GBK中文注释第${i}行，包含足够多汉字序列用来统计检测。`).join('\n'),
            'gbk'
        );
        fs.writeFileSync(filePath, Buffer.concat([Buffer.from(asciiHead, 'utf8'), gbkBody]));

        const tool = new ReadFileTool();
        const result = JSON.parse(await tool.executeCommand({ file_path: filePath }, undefined));

        expect(result.type).toBe('text');
        expect(result.file.content).toContain('GBK中文注释第0行');
        expect(result.file.content).not.toContain('\ufffd');
    });

    test('readFile decodes ascii-head UTF-8 source files without mojibake', async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, 'source.js');
        const content = `${buildAsciiHeadUtf8Buffer(16 * 1024).toString('utf8')}\n// 状态行渲染：正在执行工具\nconsole.log('done');\n`;
        fs.writeFileSync(filePath, content, 'utf8');

        const tool = new ReadFileTool();
        const result = JSON.parse(await tool.executeCommand({ file_path: filePath }, undefined));

        expect(result.type).toBe('text');
        expect(result.file.content).toContain('// 状态行渲染：正在执行工具');
        expect(result.file.content).not.toContain('æ');
        expect(result.file.content).not.toContain('\ufffd');
    });
});
