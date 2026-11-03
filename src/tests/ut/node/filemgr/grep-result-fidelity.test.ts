/**
 * grepFiles 结果可信度回归：搜索不能"静默"给出不完整或错误的结论。
 *
 * 覆盖三类历史缺陷：
 * 1. pattern 预处理把 `\uXXXX` 提前求值成字符，导致搜索源码里的 `\uXXXX` 字面量永远为空；
 * 2. 结果被 maxResults / 二进制文件截断时没有任何提示，调用方会把部分结果当成全量结论；
 * 3. Windows 风格的 filePattern（src\*.ts）被 picomatch 当成转义序列，静默匹配不到文件。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GlobFilesTool, GrepFilesTool } from '../../../../main/applications/filemgr/tools.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-grep-fidelity-'));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

async function grep(dir: string, pattern: string, extra: Record<string, unknown> = {}): Promise<string> {
    return String(
        await new GrepFilesTool().executeCommand(
            { pattern, path: dir, ignoreCase: true, maxResults: 20, contextLines: 0, ...extra } as never,
            { getWorkspace: () => dir } as never
        )
    );
}

test('grepFiles - 能搜索源码中的 \\uXXXX 字面量', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'escape.ts'), 'const s = "\\u4e2d";\n', 'utf8');

        const result = await grep(dir, '\\\\u4e2d');

        assert.match(result, /escape\.ts/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - Unicode 范围模式仍按正则语义生效', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'cn.txt'), '中文字符\n', 'utf8');

        const result = await grep(dir, '[\\u4e00-\\u9fa5]');

        assert.match(result, /cn\.txt/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 结果达到 maxResults 时明确标注为部分结果', async () => {
    const dir = makeTempDir();
    try {
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(path.join(dir, `m${i}.txt`), 'TRUNC_MARK\n', 'utf8');
        }

        const result = await grep(dir, 'TRUNC_MARK', { maxResults: 2 });

        assert.match(result, /结果已达到上限 2 处/);
    } finally {
        cleanup(dir);
    }
});

/** 已有匹配时不再叠加"跳过文件"提示：含图片/二进制产物的仓库里那是每次搜索都出现的噪声 */
test('grepFiles - 有匹配时不叠加跳过文件提示', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'text.txt'), 'BIN_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));

        const result = await grep(dir, 'BIN_MARK');

        assert.match(result, /text\.txt/);
        assert.doesNotMatch(result, /未参与搜索/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 只命中二进制内容时不会给出"确定无匹配"的结论', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0x00]), Buffer.from('ONLY_BIN\n')]));

        const result = await grep(dir, 'ONLY_BIN');

        assert.match(result, /未找到匹配的内容/);
        assert.match(result, /1 个文件未参与搜索/);
    } finally {
        cleanup(dir);
    }
});

/** NUL 落在末行（文件末尾没有换行）时，同样必须判定为二进制 */
test('grepFiles - 末行含 NUL 的文件按二进制处理', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'tail.bin'), Buffer.concat([Buffer.from('TAIL_BIN'), Buffer.from([0x00])]));

        const result = await grep(dir, 'TAIL_BIN');

        assert.doesNotMatch(result, /tail\.bin\n/);
        assert.match(result, /1 个文件未参与搜索/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - Windows 风格的 filePattern 也能命中', async () => {
    const dir = makeTempDir();
    try {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'WINFILTER\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'WINFILTER\n', 'utf8');

        const result = await grep(dir, 'WINFILTER', { filePattern: 'src\\*.ts' });

        assert.match(result, /a\.ts/);
        assert.doesNotMatch(result, /a\.js/);
    } finally {
        cleanup(dir);
    }
});

test('globFiles - Windows 风格的 pattern 也能命中', async () => {
    const dir = makeTempDir();
    try {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};\n', 'utf8');

        const result = String(
            await new GlobFilesTool().executeCommand(
                { pattern: 'src\\*.ts', path: dir, maxResults: 20 } as never,
                { getWorkspace: () => dir } as never
            )
        );

        assert.match(result, /a\.ts/);
    } finally {
        cleanup(dir);
    }
});

/** 单文件搜索时相对路径为空，结果块必须仍带文件名标识 */
test('grepFiles - 单文件搜索的结果带文件名', async () => {
    const dir = makeTempDir();
    try {
        const file = path.join(dir, 'single.ts');
        fs.writeFileSync(file, 'SINGLE_MARK\n', 'utf8');

        const result = await grep(file, 'SINGLE_MARK');

        assert.match(result, /single\.ts\n> 1 \| SINGLE_MARK/);
    } finally {
        cleanup(dir);
    }
});
