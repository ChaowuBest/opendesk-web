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
import {
    EditFileTool,
    SearchReplaceTool,
    GrepFilesTool,
    hasNestedUnboundedQuantifier
} from '../../../../main/applications/filemgr/tools.js';

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

// ========== Diff 卡片真实文件行号测试 ==========

/**
 * 从 diff 卡片 HTML 中提取每行的行号单元格：
 * 返回与 <tr> 顺序一致的数组，每项为 { type, nums }（nums 为 old/new 两个行号列中出现的数字）。
 */
function extractDiffRows(html: string): Array<{ type: string; nums: number[] }> {
    return html
        .split('<tr')
        .filter((row) => row.includes('diff-row-'))
        .map((row) => {
            const type = row.match(/diff-row-(add|del|ctx)/)?.[1] || '';
            const nums = Array.from(row.matchAll(/>(\d+)<\/td>/g)).map((m) => Number(m[1]));
            return { type, nums };
        });
}

test('diff渲染 - editFile 行号应为文件真实行号且 old/new 双列', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'real_line_test.txt');
        const lines: string[] = [];
        for (let i = 1; i <= 20; i++) {
            lines.push(`LINE_${String(i).padStart(2, '0')}`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new EditFileTool();
        const oldBlock = ['LINE_05', 'LINE_06', 'LINE_07'].join('\n');
        const newBlock = ['LINE_05X', 'LINE_06', 'LINE_07'].join('\n');

        // 执行替换时传入真实 ToolCall（与运行时一致：executor 与 renderToolCall 共享同一实例）
        const toolcall = makeToolCall('editFile', { filePath, oldString: oldBlock, newString: newBlock }, 'success');
        const result = await tool.executeCommand(
            { filePath, oldString: oldBlock, newString: newBlock },
            undefined,
            toolcall
        );
        assert.match(result, /成功替换/);

        // 执行器应记录起始行并在渲染时使用（冻结渲染把真实行号烙进 HTML）
        const html = await tool.renderToolCall(toolcall);
        assert.ok(html && html.length > 0);
        const rows = extractDiffRows(html!);

        // diff 形状：ctx(L05) del(L06行内容前先有 del L05? 依 jsdiff 顺序) —— 这里 oldBlock→newBlock
        // 实际为：del LINE_05 / add LINE_05X / ctx LINE_06 / ctx LINE_07
        // 期望行号（文件真实行号，old/new 双列）：
        assert.equal(rows[0].type, 'del');
        assert.deepEqual(rows[0].nums, [5], 'removed 行应只标 old 列且为第 5 行');
        assert.equal(rows[1].type, 'add');
        assert.deepEqual(rows[1].nums, [5], 'added 行应只标 new 列且为第 5 行');
        assert.equal(rows[2].type, 'ctx');
        assert.deepEqual(rows[2].nums, [6, 6], 'context 行 old/new 列都应为第 6 行');
        assert.equal(rows[3].type, 'ctx');
        assert.deepEqual(rows[3].nums, [7, 7], 'context 行 old/new 列都应为第 7 行');

        // 不应再出现从 1 开始的伪行号
        assert.doesNotMatch(html!, />1<\/td>/);
    } finally {
        cleanup(dir);
    }
});

test('diff渲染 - 未经过执行器的 toolcall 回退从 1 开始（历史任务回放）', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'fallback_line_test.txt');
        const lines: string[] = [];
        for (let i = 1; i <= 20; i++) {
            lines.push(`FBLINE_${String(i).padStart(2, '0')}`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new EditFileTool();
        const oldBlock = ['FBLINE_05'].join('\n');
        const newBlock = ['FBLINE_05X'].join('\n');

        // 旧任务回放：toolcall 上没有 diffStartLine
        const toolcall = makeToolCall(
            'editFile',
            { filePath, oldString: oldBlock, newString: newBlock },
            'success',
            '成功替换 1 处'
        );
        const html = await tool.renderToolCall(toolcall);
        assert.ok(html && html.length > 0);
        const rows = extractDiffRows(html!);
        assert.equal(rows[0].type, 'del');
        assert.deepEqual(rows[0].nums, [1], '回退时 removed 行 old 列从 1 开始');
        assert.equal(rows[1].type, 'add');
        assert.deepEqual(rows[1].nums, [1], '回退时 added 行 new 列从 1 开始');
    } finally {
        cleanup(dir);
    }
});

test('diff渲染 - searchReplace 行号应为文件真实行号', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'sr_real_line.txt');
        const lines: string[] = [];
        for (let i = 1; i <= 30; i++) {
            lines.push(`SRLINE_${String(i).padStart(2, '0')}`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new SearchReplaceTool();
        const oldString = 'SRLINE_10';
        const newString = 'SRLINE_10X';

        const toolcall = makeToolCall('searchReplace', { filePath, oldString, newString }, 'success');
        const result = await tool.executeCommand({ filePath, oldString, newString }, undefined, toolcall);
        assert.match(result, /成功替换/);

        const html = await tool.renderToolCall(toolcall);
        assert.ok(html && html.length > 0);
        const rows = extractDiffRows(html!);
        assert.equal(rows[0].type, 'del');
        assert.deepEqual(rows[0].nums, [10], 'searchReplace 的 removed 行应锚定到文件第 10 行');
        assert.equal(rows[1].type, 'add');
        assert.deepEqual(rows[1].nums, [10], 'searchReplace 的 added 行应锚定到文件第 10 行');
    } finally {
        cleanup(dir);
    }
});

test('diff渲染 - CLI diff 输出 @@ 头使用文件真实行号', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'cli_real_line.txt');
        const lines: string[] = [];
        for (let i = 1; i <= 20; i++) {
            lines.push(`CLILINE_${String(i).padStart(2, '0')}`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new EditFileTool();
        const oldBlock = ['CLILINE_10', 'CLILINE_11', 'CLILINE_12'].join('\n');
        const newBlock = ['CLI_X_10', 'CLI_X_11', 'CLI_X_12'].join('\n');

        const toolcall = makeToolCall('editFile', { filePath, oldString: oldBlock, newString: newBlock }, 'success');
        await tool.executeCommand({ filePath, oldString: oldBlock, newString: newBlock }, undefined, toolcall);

        const output = tool.renderToolCallCli(toolcall, 100);
        assert.ok(output && output.length > 0);
        const joined = stripAnsi(output!.join('\n'));
        assert.match(joined, /@@ -10,/, 'CLI diff hunk 头应使用真实起始行号 10');
        assert.doesNotMatch(joined, /@@ -1,/, '不应再出现从 1 开始的伪行号');
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
        assert.match(result, />  +3 \| +MARKER_FOUND 小文件/);
        assert.match(result, />  +8 \| +MARKER_FOUND 小文件/);

        // 匹配行带 > 标记，上下文行不带（格式语义：> 用于区分匹配与上下文）
        assert.match(result, /^ +4 \| 小文件普通行 4$/m);
        assert.match(result, /^ +6 \| 大文件普通行 6: 填充内容使文件变长$/m);
        assert.doesNotMatch(result, /^> +4 \| 小文件普通行 4/m);
        assert.doesNotMatch(result, /^> +6 \| 大文件普通行 6/m);
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

test('grepFiles - 上下文重叠时行号不回退不重复', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'overlap_ctx.txt');
        // 20 行文件，第 5 行和第 7 行匹配，间距 2 <= contextLines 3，
        // 两个匹配的上下文区间重叠，输出不得出现行号回退或行重复
        const lines: string[] = [];
        for (let i = 1; i <= 20; i++) {
            lines.push(i === 5 || i === 7 ? `OVERLAP_MARKER 第${i}行匹配` : `普通第${i}行内容`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'OVERLAP_MARKER',
            path: dir,
            contextLines: 3,
            maxResults: 20
        });

        console.log('\n=== GrepFiles 重叠上下文测试 ===');
        console.log(result);
        console.log('=== 结束 ===\n');

        // 两个匹配行都应保留
        assert.match(result, /> +5 \| OVERLAP_MARKER/);
        assert.match(result, /> +7 \| OVERLAP_MARKER/);

        // 上下文覆盖 2..10 行
        for (let i = 2; i <= 10; i++) {
            assert.ok(result.includes(`第${i}行`), `缺少第 ${i} 行内容`);
        }

        // 提取所有输出行的行号，必须严格递增（不得出现行号回退）
        const bodyLines = result.split('\n').filter((l) => /^[> ]\s*\d+ \| /.test(l));
        assert.ok(bodyLines.length > 0, '应输出匹配行与上下文行');
        const lineNums = bodyLines.map((l) => Number(l.match(/^[> ]\s*(\d+) \| /)![1]));
        for (let i = 1; i < lineNums.length; i++) {
            assert.ok(
                lineNums[i] > lineNums[i - 1],
                `行号必须严格递增，但在索引 ${i} 处出现回退: ${lineNums[i - 1]} -> ${lineNums[i]}`
            );
        }

        // 重叠区间的行内容只应输出一次
        for (const n of [4, 6, 8]) {
            const count = (result.match(new RegExp(`普通第${n}行内容`, 'g')) || []).length;
            assert.equal(count, 1, `第 ${n} 行的内容只应输出一次，实际输出 ${count} 次`);
        }
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

test('grepFiles - 不默认忽略 out 目录', async () => {
    const dir = makeTempDir();
    try {
        fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'out', 'bundle.txt'), 'BUILD_OUTPUT_MARKER\n', 'utf8');

        const result = await new GrepFilesTool().executeCommand({
            pattern: 'BUILD_OUTPUT_MARKER',
            path: dir,
            maxResults: 20,
            contextLines: 0
        });

        assert.match(result, /out[\\/]bundle\.txt/);
        assert.match(result, /在 1 个文件中找到 1 处匹配/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 遵守根 .gitignore 跳过构建产物目录', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'out/\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'out', 'opendesk-win32-x64'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'visible.txt'), 'BUILD_OUTPUT_MARKER\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'out', 'opendesk-win32-x64', 'bundle.txt'), 'BUILD_OUTPUT_MARKER\n', 'utf8');

        const result = await new GrepFilesTool().executeCommand({
            pattern: 'BUILD_OUTPUT_MARKER',
            path: dir,
            maxResults: 20,
            contextLines: 0
        });

        assert.match(result, /visible\.txt/);
        assert.doesNotMatch(result, /opendesk-win32-x64/);
        assert.match(result, /在 1 个文件中找到 1 处匹配/);
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

test('grepFiles - 超长行按 maxColumns 截断（匹配行取窗口，上下文行截头）', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'long_line.txt');
        // 第 1 行：长上下文行（415 字符），第 2 行：超长匹配行（1499 字符，匹配点在第 1000 列）
        const ctxLine = 'CTXSTART' + 'c'.repeat(400) + 'CTXEND';
        const matchLineText = 'a'.repeat(999) + 'NEEDLE' + 'a'.repeat(494);
        fs.writeFileSync(filePath, `${ctxLine}\n${matchLineText}\n`, 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'NEEDLE',
            path: dir,
            contextLines: 1,
            maxColumns: 300,
            maxResults: 20
        });

        // 匹配行：按匹配位置取 300 字符窗口（前留 40 字符），两端加省略号
        const matchLine = result.split('\n').find((l) => l.includes('NEEDLE'));
        assert.ok(matchLine, '应输出匹配行');
        const matchContent = matchLine.slice(matchLine.indexOf(' | ') + 3);
        assert.ok(matchContent.startsWith('...') && matchContent.endsWith('...'), '匹配行窗口两端应有省略号');
        assert.ok(
            matchContent.length >= 300 && matchContent.length <= 320,
            `匹配行窗口长度异常: ${matchContent.length}`
        );

        // 上下文行：截头保留前 300 字符，尾部加省略号
        const ctxOutLine = result.split('\n').find((l) => l.includes('CTXSTART'));
        assert.ok(ctxOutLine, '应输出上下文行');
        const ctxContent = ctxOutLine.slice(ctxOutLine.indexOf(' | ') + 3);
        assert.ok(ctxContent.startsWith('CTXSTART'), '上下文行应保留头部');
        assert.ok(ctxContent.endsWith('...'), '截断的上下文行应带省略号');
        assert.ok(!ctxContent.includes('CTXEND'), '上下文行尾部应被截断');
        assert.ok(ctxContent.length <= 303, `上下文行截断长度异常: ${ctxContent.length}`);

        // maxColumns: 0 关闭截断，整行原样输出
        const full = await new GrepFilesTool().executeCommand({
            pattern: 'NEEDLE',
            path: dir,
            contextLines: 0,
            maxColumns: 0,
            maxResults: 20
        });
        const fullLine = full.split('\n').find((l) => l.includes('NEEDLE'))!;
        const fullContent = fullLine.slice(fullLine.indexOf(' | ') + 3);
        assert.equal(fullContent, matchLineText, 'maxColumns=0 时应输出完整行');
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 同一长行多个匹配时按首个匹配截断且不虚报匹配数', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'multi_match_long_line.txt');
        // 600 字符单行，两个 NEEDLE 分别在列 50 和列 400
        const longLine = 'x'.repeat(49) + 'NEEDLE' + 'x'.repeat(344) + 'NEEDLE' + 'x'.repeat(195);
        assert.equal(longLine.length, 600);
        fs.writeFileSync(filePath, longLine + '\n', 'utf8');

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: 'NEEDLE',
            path: dir,
            contextLines: 0,
            maxColumns: 300,
            maxResults: 20
        });

        // 窗口以首个匹配为锚：第一个 NEEDLE 可见
        assert.match(result, /NEEDLE/);
        // 摘要计数按 2 处匹配计算
        assert.match(result, /找到 2 处匹配/);
        // 窗口外不可见的匹配必须有省略号提示，且输出体量有界
        assert.match(result, /\.\.\./);
        const needleCount = (result.match(/NEEDLE/g) || []).length;
        assert.ok(needleCount <= 2, `窗口内不应展示超出 maxColumns 的内容，NEEDLE 出现 ${needleCount} 次`);
        // 行被截断且行内多匹配时，必须显式注记窗口外可能有未展示的匹配
        assert.match(result, /本行共 2 处匹配/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 合法量词模式不被 ReDoS 静态检测误伤', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'quant.txt');
        fs.writeFileSync(filePath, '版本号 v1.2.13 在这里\n带连字符的词 foo-bar-baz\n', 'utf8');

        const tool = new GrepFilesTool();

        // 这些常见模式都是安全的，静态检测不得拒绝
        const legalPatterns = [
            '(\\d+\\.)*\\d+', // 版本号：分组内以字面量结尾
            '(?:\\w+-)*\\w+', // 连字符词
            '[a-z]+(\\.[a-z]+)*', // 域名
            'a{2,3}', // 有界量词
            '(foo|bar)+baz', // 分组以字面量结尾
            'a+?b', // 惰性量词本身不构成嵌套
            '(?:https?://)?[\\w.-]+(?:/\\w*)*' // URL 类常见模式
        ];
        for (const p of legalPatterns) {
            const r = await tool.executeCommand({ pattern: p, path: dir, maxResults: 10 });
            assert.doesNotMatch(r, /拒绝执行/, `模式 ${p} 不应被静态检测拒绝`);
        }

        // 这些才是真正要拦的：分组内以无限量词结尾 + 分组整体再被无限量词修饰
        const dangerous: Array<[string, RegExp]> = [
            ['(a+)+$', /拒绝执行/],
            ['(.*)*', /拒绝执行/],
            ['(\\d+)*X', /拒绝执行/],
            ['((a+)+)b', /拒绝执行/],
            ['(a+){2,}$', /拒绝执行/],
            // 空匹配歧义类：尾 token 可匹配空/字符类重叠，迭代边界可移动
            ['(?:\\w+\\s*)*END', /拒绝执行/],
            ['(a?)+b', /拒绝执行/],
            ['((a+))+b', /拒绝执行/],
            ['(?:\\s*\\w+)+END', /拒绝执行/],
            ['(a*?)+b', /拒绝执行/]
        ];
        for (const [p, expect] of dangerous) {
            const r = await tool.executeCommand({ pattern: p, path: dir, maxResults: 10 });
            assert.match(r, expect, `模式 ${p} 应被静态检测拒绝`);
        }
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 跳过行中含 NUL 字节的二进制文件', async () => {
    const dir = makeTempDir();
    try {
        // 文件头 512 字节是干净的，NUL 字节出现在 1KB 处：头部检测会漏放行，
        // 流式 NUL 检测必须拦下
        const filePath = path.join(dir, 'mid_binary.txt');
        const content = Buffer.concat([
            Buffer.from('clean header line\n'.repeat(60), 'utf8'),
            Buffer.from([0x00, 0x01, 0x02]),
            Buffer.from('\nMATCH_BINARY_MARKER here\nmore text\n', 'utf8')
        ]);
        fs.writeFileSync(filePath, content);

        const result = await new GrepFilesTool().executeCommand({
            pattern: 'MATCH_BINARY_MARKER',
            path: dir,
            maxResults: 20
        });

        assert.match(result, /未找到匹配/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 识别 UTF-16LE BOM 文件', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'utf16le.txt');
        const content = Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from('UTF16LE_MARKER 前文\nUTF16LE_MARKER 后文\n', 'utf16le')
        ]);
        fs.writeFileSync(filePath, content);

        const result = await new GrepFilesTool().executeCommand({
            pattern: 'UTF16LE_MARKER',
            path: dir,
            maxResults: 20
        });

        assert.match(result, /在 1 个文件中找到 2 处匹配/);
        assert.match(result, /UTF16LE_MARKER 前文/);
        assert.match(result, /UTF16LE_MARKER 后文/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 无 BOM 时非 UTF-8 文件回退 gb18030 解码', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'gbk.txt');
        // Node Buffer 不支持 gbk/gb18030 编码名，用 iconv 手工构造 GBK 字节：
        // "中文注释 GBK_MARKER 苹果\n" 的 GBK 编码字节序列
        const gbkBytes = [
            0xd6,
            0xd0,
            0xce,
            0xc4, // 中文
            0xd7,
            0xa2,
            0xca,
            0xcd, // 注释
            0x20,
            0x47,
            0x42,
            0x4b,
            0x5f,
            0x4d,
            0x41,
            0x52,
            0x4b,
            0x45,
            0x52,
            0x20, // GBK_MARKER
            0xc6,
            0xbb,
            0xb9,
            0xfb, // 苹果
            0x0a
        ];
        fs.writeFileSync(filePath, Buffer.from(gbkBytes));

        const result = await new GrepFilesTool().executeCommand({
            pattern: 'GBK_MARKER',
            path: dir,
            maxResults: 20
        });

        assert.match(result, /GBK_MARKER/);
        assert.match(result, /中文注释/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 静态拒绝嵌套无限量词的 ReDoS 模式', async () => {
    const tool = new GrepFilesTool();
    const result = await tool.executeCommand({
        pattern: '(a+)+$',
        path: '.',
        maxResults: 5
    });
    assert.match(result, /拒绝执行/);
    assert.match(result, /嵌套量词/);
});

test('grepFiles - 超时中断搜索并返回部分结果', async () => {
    const dir = makeTempDir();
    try {
        const originalEnv = process.env['OPENDESK_GREP_TIME_BUDGET_MS'];
        process.env['OPENDESK_GREP_TIME_BUDGET_MS'] = '50';
        try {
            // 用大量中小文件拖慢扫描触发时间预算（慢正则会被静态检测拦截，不能用它）
            const padding = 'x'.repeat(300);
            for (let i = 0; i < 600; i++) {
                fs.writeFileSync(path.join(dir, `bulk-${i}.txt`), `file ${i} padding ${padding}\n`, 'utf8');
            }
            const tool = new GrepFilesTool();
            const result = await tool.executeCommand({
                pattern: 'TARGET_MARKER_THAT_DOES_NOT_EXIST',
                path: dir,
                maxResults: 500
            });

            // 应以超时说明结束，而不是继续扫完所有文件
            assert.match(result, /超时/);
            assert.ok(result.length > 0);
        } finally {
            if (originalEnv === undefined) {
                delete process.env['OPENDESK_GREP_TIME_BUDGET_MS'];
            } else {
                process.env['OPENDESK_GREP_TIME_BUDGET_MS'] = originalEnv;
            }
        }
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - ReDoS 静态检测判定矩阵', async () => {
    // 直接对检测器函数做判定矩阵测试（24 个样例：12 危险 + 12 合法）
    const dangerous = [
        '(a+)+',
        '(.*)*',
        '(\\d+)*X',
        '(a+){2,}$',
        '(?:\\w+\\s*)*END',
        '(\\w+\\s*)*END',
        '(a?)+b',
        '((a+))+b',
        '(a*?)+b',
        '(?:\\s*\\w+)+END',
        '(a+|b)+',
        '(\\w|)+x'
    ];
    const legal = [
        '(\\d+\\.)*\\d+',
        '(?:\\w+-)*\\w+',
        '[a-z]+(\\.[a-z]+)*',
        '(?:https?://)?[\\w.-]+(?:/\\w*)*',
        'a{2,3}',
        '(foo|bar)+baz',
        'a+?b',
        '(aa)+b',
        '(ab?)+c',
        'x(?:\\d{4}-\\d{2}-\\d{2})+y',
        '(\\s?a)+b',
        '(a\\s?)+b'
    ];
    for (const p of dangerous) {
        assert.equal(hasNestedUnboundedQuantifier(p), true, `${p} 应判定为危险`);
    }
    for (const p of legal) {
        assert.equal(hasNestedUnboundedQuantifier(p), false, `${p} 应判定为安全`);
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

test('grepFiles - UTF-8 头部探测边界截断多字节字符时不误判为 gb18030', async () => {
    const dir = makeTempDir();
    try {
        // detectFileEncoding 读 64KB 头部做 UTF-8 校验。
        // 让 64KB 边界恰好切在多字节字符中间，且前面紧邻其他多字节字符，
        // 使"去掉尾部 3 字节重试"后残留的仍是不完整序列——此时必须仍判为 UTF-8，
        // 否则整个文件按 gb18030 解码，中文注释全部变成乱码且无法匹配中文 pattern
        const pad = Buffer.alloc(64 * 1024 - 4, 0x61); // 'a' * 65532

        // 尾部 = CC 80 E6 95：3 字节 '数' 截断在前 2 字节，去掉 3 字节后残留 'a'*65532 + CC 仍不完整
        const cjkFile = path.join(dir, 'truncated_cjk.txt');
        fs.writeFileSync(
            cjkFile,
            Buffer.concat([
                pad,
                Buffer.from([0xcc, 0x80]),
                Buffer.from([0xe6, 0x95, 0xb0]),
                Buffer.from('\n边界标记行\n', 'utf8')
            ])
        );

        // 尾部 = F0 9F 98：4 字节 emoji 截断在前 3 字节，去掉 3 字节后残留 'a'*65532 + F0 仍不完整
        const emojiFile = path.join(dir, 'truncated_emoji.txt');
        fs.writeFileSync(
            emojiFile,
            Buffer.concat([pad, Buffer.from([0xf0, 0x9f, 0x98, 0x80]), Buffer.from('\n表情边界标记行\n', 'utf8')])
        );

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: '边界标记',
            path: dir,
            ignoreCase: false,
            contextLines: 0,
            maxResults: 20
        });

        assert.match(result, /在 2 个文件中找到 2 处匹配/);
        assert.match(result, /边界标记行/);
        assert.match(result, /表情边界标记行/);
        // 不应出现 UTF-8 字节被按 GBK 解读的乱码特征字
        assert.doesNotMatch(result, /[鏁鍦鍙涓嬫枃]/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 非法 UTF-8 的 GBK 文件仍回退 gb18030 解码', async () => {
    const dir = makeTempDir();
    try {
        // '汉' 的 GBK 编码为 BA BA（continuation 字节开头，非法 UTF-8），应回退 gb18030 正确解码
        const gbkFile = path.join(dir, 'gbk_cjk.txt');
        fs.writeFileSync(
            gbkFile,
            Buffer.concat([Buffer.from('GBK_MARKER\n'), Buffer.from([0xba, 0xba]), Buffer.from('\n')])
        );

        const tool = new GrepFilesTool();
        const result = await tool.executeCommand({
            pattern: '汉',
            path: dir,
            ignoreCase: false,
            contextLines: 0,
            maxResults: 20
        });

        assert.match(result, /在 1 个文件中找到 1 处匹配/);
        // 匹配行内容应是 gb18030 解码后的'汉'，而非 U+FFFD 替换符
        assert.match(result, /汉/);
    } finally {
        cleanup(dir);
    }
});

// ========== sanitizePath 改名遗漏回归测试 ==========
// getDeclaredPermissions 与 executeCommand 曾引用已删除的 sanitizePath，
// 导致 AI 调用 grepFiles 时抛 ReferenceError 使整个任务 turn 中断

test('grepFiles - getDeclaredPermissions 不带 path 时返回 workspace 权限且不抛错', () => {
    const dir = makeTempDir();
    try {
        const tool = new GrepFilesTool();
        const mockTaskState = { getWorkspace: () => dir } as any;

        // 不带 path：此前在此处抛 ReferenceError: sanitizePath is not defined
        const perms = tool.getDeclaredPermissions({ pattern: 'X' } as any, mockTaskState);
        assert.equal(perms.length, 1);
        assert.equal(perms[0].resourceType, 'file');
        assert.equal(perms[0].action, 'read');
        assert.equal(perms[0].resourcePath, dir.replace(/\\/g, '/') + '/');

        // 带 path：相对路径应基于 workspace 解析
        const subDir = path.join(dir, 'sub');
        fs.mkdirSync(subDir, { recursive: true });
        const permsWithSub = tool.getDeclaredPermissions({ pattern: 'X', path: 'sub' } as any, mockTaskState);
        assert.equal(permsWithSub.length, 1);
        assert.equal(permsWithSub[0].resourcePath, subDir.replace(/\\/g, '/') + '/');
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 不带 path 时基于 workspace 搜索且不返回搜索失败', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'ws_marker.txt'), 'WORKSPACE_MARKER hit\n', 'utf8');

        const tool = new GrepFilesTool();
        const mockTaskState = { getWorkspace: () => dir } as any;

        const result = await tool.executeCommand(
            { pattern: 'WORKSPACE_MARKER', contextLines: 0, maxResults: 20 } as any,
            mockTaskState
        );

        assert.match(result, /在 1 个文件中找到 1 处匹配/);
        assert.match(result, /ws_marker\.txt/);
        assert.doesNotMatch(result, /搜索失败/);
    } finally {
        cleanup(dir);
    }
});
