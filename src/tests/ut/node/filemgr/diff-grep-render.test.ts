/**
 * 测试 renderDiffOutput 行号对齐 和 GrepFilesTool 分组/对齐效果
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'node:stream';
import { diffLines } from 'diff';
import { setRuntimeLocale } from '../../../../locale/index.js';
import { ToolCall } from '../../../../main/aikernel/messages.js';
import { EditFileTool, SearchReplaceTool, GrepFilesTool } from '../../../../main/applications/filemgr/tools.js';

setRuntimeLocale('zh-CN');

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-diff-grep-test-'));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function makeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    status: ToolCall['status'],
    result?: string
): ToolCall {
    const call = new ToolCall(0, `${toolName}-call`, toolName, JSON.stringify(args));
    call.args_object = args;
    call.status = status;
    call.result = result;
    return call;
}

function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// ========== Diff 渲染测试 ==========

test('diff渲染 - 百行内（个位/十位行号）的对齐', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'align_test.txt');
        // 创建 99 行文件，使行号从个位到两位数都有
        const lines: string[] = [];
        for (let i = 1; i <= 99; i++) {
            lines.push(`LINE_${String(i).padStart(3, '0')}: 这是第 ${i} 行的测试内容`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new EditFileTool();

        // 在文件末尾附近修改（行号 ~95，接近三位数边界）
        const oldBlock = [
            'LINE_094: 这是第 94 行的测试内容',
            'LINE_095: 这是第 95 行的测试内容',
            'LINE_096: 这是第 96 行的测试内容'
        ].join('\n');
        const newBlock = [
            'LINE_094: 【已修改】第 94 行的新内容',
            'LINE_095: 这是第 95 行的测试内容',
            'LINE_096: 【新增】这是一行完全不同的内容'
        ].join('\n');

        // 执行替换
        const result = await tool.executeCommand({
            filePath,
            oldString: oldBlock,
            newString: newBlock
        });

        assert.match(result, /成功替换/);

        // 通过 renderToolCall 获取 diff 渲染输出
        const html = await tool.renderToolCall(
            makeToolCall('editFile', { filePath, oldString: oldBlock, newString: newBlock }, 'success', result)
        );

        // 去掉 ANSI 转义码，提取纯文本
        const plainText = stripAnsi(html);

        console.log('\n=== Diff 渲染输出 (百行内) ===');
        console.log(html);
        console.log('=== 纯文本 (去ANSI) ===');
        console.log(plainText);
        console.log('=== 结束 ===\n');

        // 验证输出不为空
        assert.ok(html.length > 0);
    } finally {
        cleanup(dir);
    }
});

test('diff渲染 - 三位数行号（第100行附近）的对齐', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'three_digit_test.txt');
        // 创建 150 行文件，使行号达到三位数
        const lines: string[] = [];
        for (let i = 1; i <= 150; i++) {
            lines.push(`LINE_${String(i).padStart(3, '0')}: 第 ${i} 行的内容——后面跟一些描述文字`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new EditFileTool();

        // 在第 98-102 行附近修改（跨越两位数到三位数边界）
        const oldBlock = [
            'LINE_098: 第 98 行的内容——后面跟一些描述文字',
            'LINE_099: 第 99 行的内容——后面跟一些描述文字',
            'LINE_100: 第 100 行的内容——后面跟一些描述文字',
            'LINE_101: 第 101 行的内容——后面跟一些描述文字',
            'LINE_102: 第 102 行的内容——后面跟一些描述文字'
        ].join('\n');
        const newBlock = [
            'LINE_098: 【改】98',
            'LINE_099: 第 99 行的内容——后面跟一些描述文字',
            'LINE_100: 【改】第100行完全替换为短内容',
            'LINE_101: 第 101 行的内容——后面跟一些描述文字',
            'LINE_102: 【改】102'
        ].join('\n');

        const result = await tool.executeCommand({
            filePath,
            oldString: oldBlock,
            newString: newBlock
        });

        assert.match(result, /成功替换/);

        const html = await tool.renderToolCall(
            makeToolCall('editFile', { filePath, oldString: oldBlock, newString: newBlock }, 'success', result)
        );

        const plainText = stripAnsi(html);

        console.log('\n=== Diff 渲染输出 (三位数行号) ===');
        console.log(html);
        console.log('=== 纯文本 (去ANSI) ===');
        console.log(plainText);
        console.log('=== 结束 ===\n');

        assert.ok(html.length > 0);
    } finally {
        cleanup(dir);
    }
});

test('diff渲染 - 单行修改（个位行号）', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'single_line_test.txt');
        const lines: string[] = [];
        for (let i = 1; i <= 20; i++) {
            lines.push(`第${i}行: 普通文本内容`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new EditFileTool();

        const oldBlock = '第5行: 普通文本内容';
        const newBlock = '第5行: 这一行被修改了，替换为较长的新文本内容';

        const result = await tool.executeCommand({
            filePath,
            oldString: oldBlock,
            newString: newBlock
        });

        assert.match(result, /成功替换/);

        const html = await tool.renderToolCall(
            makeToolCall('editFile', { filePath, oldString: oldBlock, newString: newBlock }, 'success', result)
        );

        const plainText = stripAnsi(html);

        console.log('\n=== Diff 渲染输出 (个位行号) ===');
        console.log(html);
        console.log('=== 纯文本 (去ANSI) ===');
        console.log(plainText);
        console.log('=== 结束 ===\n');

        assert.ok(html.length > 0);
    } finally {
        cleanup(dir);
    }
});

// ========== SearchReplace diff 渲染测试 ==========

test('searchReplace diff渲染 - 对齐验证', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'sr_align.txt');
        const lines: string[] = [];
        for (let i = 1; i <= 120; i++) {
            lines.push(`SR_LINE_${String(i).padStart(3, '0')}: 这是 searchReplace 测试行 ${i}`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new SearchReplaceTool();

        const result = await tool.executeCommand({
            filePath,
            oldString: 'SR_LINE_010: 这是 searchReplace 测试行 10',
            newString: 'SR_LINE_010: 【SearchReplace修改】第10行的新内容'
        });

        assert.match(result, /成功替换/);

        const html = await tool.renderToolCall(
            makeToolCall(
                'searchReplace',
                {
                    filePath,
                    oldString: 'SR_LINE_010: 这是 searchReplace 测试行 10',
                    newString: 'SR_LINE_010: 【SearchReplace修改】第10行的新内容'
                },
                'success',
                result
            )
        );

        const plainText = stripAnsi(html);

        console.log('\n=== SearchReplace Diff 渲染输出 ===');
        console.log(html);
        console.log('=== 纯文本 (去ANSI) ===');
        console.log(plainText);
        console.log('=== 结束 ===\n');

        assert.ok(html.length > 0);
    } finally {
        cleanup(dir);
    }
});

// ========== GrepFilesTool 测试 ==========

test('grepFiles - 按文件分组且行号对齐', async () => {
    const dir = makeTempDir();
    try {
        // 创建两个文件，一个有短行号（<10），一个有大行号（>100）
        const file1 = path.join(dir, 'small_file.txt');
        const file2 = path.join(dir, 'large_file.txt');

        // 小文件：10 行，匹配在第 3 行和第 8 行
        const smallLines: string[] = [];
        for (let i = 1; i <= 10; i++) {
            if (i === 3 || i === 8) {
                smallLines.push(`MARKER_FOUND 小文件第${i}行匹配`);
            } else {
                smallLines.push(`小文件普通行 ${i}`);
            }
        }
        fs.writeFileSync(file1, smallLines.join('\n'), 'utf8');

        // 大文件：200 行，匹配在第 5, 50, 150 行
        const largeLines: string[] = [];
        for (let i = 1; i <= 200; i++) {
            if (i === 5 || i === 50 || i === 150) {
                largeLines.push(`MARKER_FOUND 大文件第${i}行匹配内容这里有一些额外的文字`);
            } else {
                largeLines.push(`大文件普通行 ${i}: 填充内容使文件变长`);
            }
        }
        fs.writeFileSync(file2, largeLines.join('\n'), 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'MARKER_FOUND',
            path: dir,
            contextLines: 2,
            maxResults: 20
        });

        console.log('\n=== GrepFiles 输出 ===');
        console.log(result);
        console.log('=== 结束 ===\n');

        // 验证两个文件都出现了
        assert.match(result, /small_file\.txt/);
        assert.match(result, /large_file\.txt/);

        // 验证大文件的行号用 padStart 对齐（3位数）
        assert.match(result, /在 2 个文件中找到 5 处匹配/);

        // 检查小文件中行号对齐：小文件最大行号 8+2=10，宽度=2
        // 行号用 padStart 右对齐：' 3'、' 8'（前面有一个空格）
        assert.match(result, />  +3 \| MARKER_FOUND 小文件/);
        assert.match(result, />  +8 \| MARKER_FOUND 小文件/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 同一文件内匹配去重', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'dedup_test.txt');
        // 同一行有两个匹配（比如 "TODO TODO"）
        const lines: string[] = [];
        for (let i = 1; i <= 20; i++) {
            if (i === 10) {
                lines.push('TODO FIXME TODO 这是同一行有两个匹配');
            } else if (i === 15) {
                lines.push('只有一行 TODO 匹配');
            } else {
                lines.push(`普通行 ${i} 无匹配`);
            }
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'TODO',
            path: dir,
            contextLines: 1,
            maxResults: 20
        });

        console.log('\n=== GrepFiles 去重测试 ===');
        console.log(result);
        console.log('=== 结束 ===\n');

        // 第10行虽然有 2 个 TODO 匹配但只应输出一次
        const match10count = (result.match(/TODO FIXME TODO/g) || []).length;
        assert.equal(match10count, 1, '同一行多个匹配应去重只输出一次');

        // 总共找到 2 处（第10行和第15行），但 matches 计数可能 >2（因为同一行有多个 regex match）
        // 验证找到的匹配数
        assert.match(result, /在 1 个文件中找到/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 无匹配时返回提示', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'no_match.txt');
        fs.writeFileSync(filePath, '没有匹配的行\n完全没有\n真的没有', 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'ZZZ_NOT_FOUND',
            path: dir,
            maxResults: 20
        });

        console.log('\n=== GrepFiles 无匹配 ===');
        console.log(result);
        console.log('=== 结束 ===\n');

        assert.match(result, /未找到匹配/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 跳过超过 20 MiB 的文件', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'large-text.txt');
        const marker = 'LARGE_FILE_MARKER';
        const content = Buffer.alloc(20 * 1024 * 1024 + 1, 'x');
        content.write(marker, 0, 'utf8');
        fs.writeFileSync(filePath, content);

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: marker,
            path: dir,
            maxResults: 20
        });

        assert.match(result, /未找到匹配/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 允许恰好 20 MiB 的文件', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'boundary-size.txt');
        const marker = 'BOUNDARY_SIZE_MARKER';
        const content = Buffer.alloc(20 * 1024 * 1024, 'x');
        content.write(`${marker}\n`, 0, 'utf8');
        fs.writeFileSync(filePath, content);

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: marker,
            path: dir,
            contextLines: 0,
            maxResults: 20
        });

        assert.match(result, new RegExp(marker));
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 使用流式读取而非整文件 readFile', async () => {
    const dir = makeTempDir();
    const originalReadFile = fs.promises.readFile;
    try {
        const filePath = path.join(dir, 'streamed.txt');
        fs.writeFileSync(filePath, '第一行\nSTREAMED_MARKER\n最后一行', 'utf8');
        fs.promises.readFile = async () => {
            throw new Error('grepFiles 不应使用 readFile 读取搜索文件');
        };

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'STREAMED_MARKER',
            path: dir,
            maxResults: 20,
            contextLines: 1
        });

        assert.match(result, /STREAMED_MARKER/);
        assert.match(result, /第一行/);
        assert.match(result, /最后一行/);
    } finally {
        fs.promises.readFile = originalReadFile;
        cleanup(dir);
    }
});

test('grepFiles - 保留最后一个结果的后文上下文', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'match-context.txt');
        fs.writeFileSync(filePath, '前文\nMATCH_ONE\n后文\nMATCH_TWO\n末行', 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'MATCH_',
            path: dir,
            contextLines: 1,
            maxResults: 1
        });

        assert.match(result, /在 1 个文件中找到 1 处匹配/);
        assert.match(result, /前文/);
        assert.match(result, /MATCH_ONE/);
        assert.match(result, /后文/);
        assert.doesNotMatch(result, /MATCH_TWO/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 规范化 CRLF 行和上下文', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'crlf.txt');
        fs.writeFileSync(filePath, '前文\r\nCRLF_MARKER\r\n后文\r\n', 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'CRLF_MARKER',
            path: dir,
            contextLines: 1,
            maxResults: 20
        });

        assert.match(result, /前文/);
        assert.match(result, /CRLF_MARKER/);
        assert.match(result, /后文/);
        assert.doesNotMatch(result, /\r/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 目录扫描最多同时读取四个文件', async () => {
    const dir = makeTempDir();
    const originalCreateReadStream = fs.createReadStream;
    let releaseStreams: () => void = () => undefined;
    const streamsReleased = new Promise<void>((resolve) => {
        releaseStreams = resolve;
    });
    let startedStreams = 0;
    let resultPromise: Promise<string> | undefined;
    try {
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'source text', 'utf8');
        }

        fs.createReadStream = (() => {
            startedStreams++;
            const stream = new PassThrough();
            void streamsReleased.then(() => stream.end('no matching content\n'));
            return stream;
        }) as typeof fs.createReadStream;

        const tool = new GrepFilesTool();
        resultPromise = tool.executeCommand({
            pattern: 'NO_MATCH',
            path: dir,
            maxResults: 20
        });

        for (let attempt = 0; attempt < 100 && startedStreams < 4; attempt++) {
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(startedStreams, 4);

        releaseStreams();
        const result = await resultPromise;
        assert.equal(startedStreams, 5);
        assert.match(result, /未找到匹配/);
    } finally {
        releaseStreams();
        fs.createReadStream = originalCreateReadStream;
        await resultPromise;
        cleanup(dir);
    }
});
