/**
 * 回归测试：.gitignore 中的反向规则（!pattern）不能把未被忽略的文件一并过滤掉。
 *
 * 缺陷现场：仓库根 .gitignore 含有 `!.env.example` 这类反向规则，转换后以 `!` 前缀进入
 * 同一组 picomatch 模式数组。picomatch 对 `!x` 的语义是"匹配除 x 以外的一切"，于是
 * 整个 ignore 匹配器对所有路径都返回 true，grepFiles 在仓库根永远返回"未找到匹配的内容"。
 *
 * 同时锁定忽略规则的各种边界：
 *  - 目录剪枝不得跳过仍可重新纳入子项的子树（内容规则 X/** 天然不排除 X 目录本身）；
 *  - 仅目录规则（`!*\/`、`!fixtures/`）只能参与目录判定，否则整份 .gitignore 会失效；
 *  - `.gitignore` 里的 `\` 是转义符，不能被分隔符归一改写；
 *  - 退化模式（裸 `!`、空串）不得让搜索整体失败。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GlobFilesTool, GrepFilesTool } from '../../../../main/applications/filemgr/tools.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-grep-gitignore-'));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function makeTaskState(workspace: string): { getWorkspace: () => string } {
    return { getWorkspace: () => workspace };
}

async function grep(dir: string, pattern: string, contextLines = 1): Promise<string> {
    return String(
        await new GrepFilesTool().executeCommand(
            { pattern, path: dir, ignoreCase: true, maxResults: 20, contextLines } as never,
            makeTaskState(dir) as never
        )
    );
}

test('grepFiles - .gitignore 的反向规则不会让搜索整体失效', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n!.env.example\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "dep": "NEGATION_MARKER"\n}\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = "NEGATION_MARKER";\n', 'utf8');

        const result = await grep(dir, 'NEGATION_MARKER');

        assert.match(result, /在 2 个文件中找到 2 处匹配/);
        assert.match(result, /package\.json/);
        assert.match(result, /app\.ts/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 普通忽略规则仍然生效', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.ts'), 'const v = "KEEP_MARKER";\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'noise.log'), 'KEEP_MARKER\n', 'utf8');

        const result = await grep(dir, 'KEEP_MARKER');

        assert.match(result, /keep\.ts/);
        assert.doesNotMatch(result, /noise\.log/);
    } finally {
        cleanup(dir);
    }
});

test('grepFiles - 反向规则能放行被忽略的文件', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*.env\n!app.env\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'app.env'), 'REINCLUDE_MARKER=1\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'other.env'), 'REINCLUDE_MARKER=2\n', 'utf8');

        const result = await grep(dir, 'REINCLUDE_MARKER', 0);

        assert.match(result, /app\.env/);
        assert.doesNotMatch(result, /other\.env/);
    } finally {
        cleanup(dir);
    }
});

/**
 * 反向规则命中目录本身时，遍历必须进入该目录：目录剪枝不能先于重新纳入判定。
 * 依据 git 语义，父目录仍被排除时其内容无法重新纳入，因此 other/ 下的文件不应出现。
 */
test('grepFiles - 反向规则能放行被排除的目录', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!keep\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'keep'));
        fs.mkdirSync(path.join(dir, 'other'));
        fs.writeFileSync(path.join(dir, 'keep', 'a.txt'), 'DIR_MARKER\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'other', 'b.txt'), 'DIR_MARKER\n', 'utf8');

        const result = await grep(dir, 'DIR_MARKER', 0);

        assert.match(result, /keep[\\/]a\.txt/);
        assert.doesNotMatch(result, /other/);
    } finally {
        cleanup(dir);
    }
});

/**
 * `out/*` 只排除 out 的直接子项，out 本身没有被排除，因此 `!out/keep.ts` 能重新纳入。
 * 目录剪枝若以"目录内容哨兵"判定，会把整个 out 剪掉，导致这个文件搜不到。
 */
test('grepFiles - 目录未被排除时不会因内容被排除而跳过整棵子树', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'out/*\n!out/keep.ts\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'out'));
        fs.writeFileSync(path.join(dir, 'out', 'keep.ts'), 'SUBTREE_MARKER\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'out', 'noise.ts'), 'SUBTREE_MARKER\n', 'utf8');

        const result = await grep(dir, 'SUBTREE_MARKER', 0);

        assert.match(result, /out[\\/]keep\.ts/);
        assert.doesNotMatch(result, /noise\.ts/);
    } finally {
        cleanup(dir);
    }
});

/**
 * `X/**` 表达的是"X 的内容"，不排除 X 目录本身，因此 `!X/keep.ts` 仍然能重新纳入。
 * 目录剪枝若用这类"内容规则"判定，会把整棵子树剪掉，导致 keep.ts 搜不到（比 git 少结果）。
 */
test('grepFiles - 内容规则 X/** 不会让目录整棵被剪枝', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'generated/**\n!generated/keep.ts\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'generated'));
        fs.writeFileSync(path.join(dir, 'generated', 'keep.ts'), 'CONTENT_RULE_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'generated', 'noise.ts'), 'CONTENT_RULE_MARK\n', 'utf8');

        const result = await grep(dir, 'CONTENT_RULE_MARK', 0);

        assert.match(result, /generated[\\/]keep\.ts/);
        assert.doesNotMatch(result, /noise\.ts/);
    } finally {
        cleanup(dir);
    }
});

/**
 * .gitignore 里 `\` 是转义符（`\!important.txt` 表示字面量文件名 !important.txt），
 * 转换出的模式必须原样交给 picomatch。分隔符归一只能作用在 LLM 传入的模式上，
 * 若在内部给所有忽略模式都做一次 \ → / 替换，这类转义规则会被拆坏而静默失效。
 */
test('grepFiles - .gitignore 的转义规则不被当作路径分隔符', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '\\!important.txt\n\\#draft.txt\n', 'utf8');
        fs.writeFileSync(path.join(dir, '!important.txt'), 'ESCAPE_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, '#draft.txt'), 'ESCAPE_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.txt'), 'ESCAPE_MARK\n', 'utf8');

        const result = await grep(dir, 'ESCAPE_MARK', 0);

        assert.match(result, /keep\.txt/);
        assert.doesNotMatch(result, /important\.txt/);
        assert.doesNotMatch(result, /draft\.txt/);
    } finally {
        cleanup(dir);
    }
});

/**
 * `logs/` 只忽略目录：与目录同名的**文件**不受影响（git 同语义）。
 * `pattern/**` 这类内容模式会顺带命中 pattern 本身，仅目录规则的内容必须用 `pattern/**\/*`。
 */
test('grepFiles - 仅目录规则不影响同名文件', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'logs/\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'logs'));
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.writeFileSync(path.join(dir, 'logs', 'inside.txt'), 'SAMENAME_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'sub', 'logs'), 'SAMENAME_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.txt'), 'SAMENAME_MARK\n', 'utf8');

        const result = await grep(dir, 'SAMENAME_MARK', 0);

        assert.match(result, /keep\.txt/);
        assert.match(result, /sub[\\/]logs/);
        assert.doesNotMatch(result, /inside\.txt/);
    } finally {
        cleanup(dir);
    }
});

/**
 * 内容规则（src/**）与仅目录规则（logs/）必须各归各的判定：前者不参与目录剪枝，后者要参与。
 * 把两者混进同一份匹配器时，仅目录规则会失效（该剪的没剪）。
 */
test('grepFiles - 内容规则与仅目录规则互不干扰', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'src/**\nlogs/\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'src'));
        fs.mkdirSync(path.join(dir, 'logs'));
        fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'MIX_RULE_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'logs', 'b.txt'), 'MIX_RULE_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.txt'), 'MIX_RULE_MARK\n', 'utf8');

        const result = await grep(dir, 'MIX_RULE_MARK', 0);

        assert.match(result, /keep\.txt/);
        assert.doesNotMatch(result, /a\.txt/);
        assert.doesNotMatch(result, /b\.txt/);
    } finally {
        cleanup(dir);
    }
});

/**
 * 允许清单写法（`*` + `!*\/` + `!*.ts`）是最常见的 .gitignore 形态之一：
 * `!*\/` 只是"重新纳入所有目录"，不能让后续/前置的排除规则全部失效。
 * 若把仅目录规则当成"重新纳入所有路径"，整份 .gitignore 会变成什么都不忽略。
 */
test('grepFiles - 允许清单写法的 .gitignore 依然生效', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!*/\n!*.ts\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.ts'), 'ALLOWLIST_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'skip.md'), 'ALLOWLIST_MARK\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'nested'));
        fs.writeFileSync(path.join(dir, 'nested', 'deep.ts'), 'ALLOWLIST_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'nested', 'noise.md'), 'ALLOWLIST_MARK\n', 'utf8');

        const result = await grep(dir, 'ALLOWLIST_MARK', 0);

        assert.match(result, /keep\.ts/);
        assert.match(result, /deep\.ts/);
        assert.doesNotMatch(result, /skip\.md/);
        assert.doesNotMatch(result, /noise\.md/);
    } finally {
        cleanup(dir);
    }
});

/**
 * `!fixtures/` 只放行目录本身：git 不会顺带放行目录里的文件（它们仍被 `*` 命中）。
 * 仅目录的重新纳入若带上"内容"模式，会把 fixtures 下的所有文件一起放行。
 */
test('grepFiles - 仅目录的重新纳入不连带放行目录内容', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!*/\n!fixtures/\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'fixtures'));
        fs.writeFileSync(path.join(dir, 'fixtures', 'data.txt'), 'DIRONLY_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'top.ts'), 'DIRONLY_MARK\n', 'utf8');

        const result = await grep(dir, 'DIRONLY_MARK', 0);

        assert.doesNotMatch(result, /data\.txt/);
        assert.doesNotMatch(result, /top\.ts/);
        assert.match(result, /未找到匹配的内容/);
    } finally {
        cleanup(dir);
    }
});

/**
 * Windows 检出（core.autocrlf）会得到 CRLF 行尾的 .gitignore，普通规则与反向规则都必须照常生效。
 */
test('grepFiles - CRLF 行尾的 .gitignore 规则照常生效', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\r\n!keep.log\r\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'noise.log'), 'CRLF_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.log'), 'CRLF_MARK\n', 'utf8');

        const result = await grep(dir, 'CRLF_MARK', 0);

        assert.match(result, /keep\.log/);
        assert.doesNotMatch(result, /noise\.log/);
    } finally {
        cleanup(dir);
    }
});

/**
 * picomatch 在所有平台都把 `\` 当转义符，因此 Windows 风格的 ignore 模式必须与 pattern 一样归一化，
 * 否则会静默失效（不是 Windows 平台专有问题）。
 */
test('globFiles - Windows 风格的 ignore 模式也能生效', async () => {
    const dir = makeTempDir();
    try {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'b.ts'), 'export {};\n', 'utf8');

        const result = String(
            await new GlobFilesTool().executeCommand(
                { pattern: '**/*.ts', path: dir, ignore: ['src\\*'], maxResults: 20 } as never,
                makeTaskState(dir) as never
            )
        );

        assert.match(result, /b\.ts/);
        assert.doesNotMatch(result, /a\.ts/);
    } finally {
        cleanup(dir);
    }
});

/**
 * globFiles 的 ignore 参数同样要支持重新纳入，且 `X/**` 不能把 X 目录本身剪掉。
 */
test('globFiles - 内容规则 X/** 不会让目录整棵被剪枝', async () => {
    const dir = makeTempDir();
    try {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export {};\n', 'utf8');

        const result = String(
            await new GlobFilesTool().executeCommand(
                { pattern: '**/*.ts', path: dir, ignore: ['src/**', '!src/a.ts'], maxResults: 20 } as never,
                makeTaskState(dir) as never
            )
        );

        assert.match(result, /a\.ts/);
        assert.doesNotMatch(result, /b\.ts/);
    } finally {
        cleanup(dir);
    }
});

/** 裸 `!` 或空字符串都会拼出空模式，picomatch 对它直接抛错，不能因此让整次搜索失败 */
test('globFiles - 退化忽略模式不会让搜索整体失败', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'app.ts'), 'export {};\n', 'utf8');

        for (const ignore of [['!'], ['']]) {
            const result = String(
                await new GlobFilesTool().executeCommand(
                    { pattern: '**/*.ts', path: dir, ignore, maxResults: 20 } as never,
                    makeTaskState(dir) as never
                )
            );

            assert.match(result, /app\.ts/);
            assert.doesNotMatch(result, /搜索失败/);
        }
    } finally {
        cleanup(dir);
    }
});

/**
 * `out/` 只是"目录被忽略"，其内容属于**间接**忽略：目录被重新纳入（`!out/`）后内容重新可见
 * （git 同语义）。若把仅目录规则展开成内容模式，内容就永远无法恢复可见。
 */
test('grepFiles - 仅目录规则被重新纳入后内容恢复可见', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'out/\n!out/\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'out'));
        fs.writeFileSync(path.join(dir, 'out', 'a.txt'), 'REENABLE_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.txt'), 'REENABLE_MARK\n', 'utf8');

        const result = await grep(dir, 'REENABLE_MARK', 0);

        assert.match(result, /out[\\/]a\.txt/);
        assert.match(result, /keep\.txt/);
    } finally {
        cleanup(dir);
    }
});

/**
 * `out/**\/` 只匹配 out 的子目录（至少一层），不匹配 out 本身。
 * picomatch 的 `out/**` 会命中 out 自身，直接拿来剪枝会把 out 的直属文件一起剪掉。
 */
test('grepFiles - 目录通配的仅目录规则不剪掉父目录', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'out/**/\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'out', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'out', 'top.txt'), 'SUBDIRONLY_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'out', 'sub', 'deep.txt'), 'SUBDIRONLY_MARK\n', 'utf8');

        const result = await grep(dir, 'SUBDIRONLY_MARK', 0);

        assert.match(result, /out[\\/]top\.txt/);
        assert.doesNotMatch(result, /deep\.txt/);
    } finally {
        cleanup(dir);
    }
});

/**
 * 根 .gitignore 用 `*` 时，嵌套 .gitignore 文件本身也会命中忽略规则；
 * git 仍会读取它（只用"目录是否被排除"决定是否遍历），否则子目录里的规则永远不生效。
 */
test('grepFiles - 被忽略的嵌套 .gitignore 仍然被读取', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!*/\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'pkg'));
        fs.writeFileSync(path.join(dir, 'pkg', '.gitignore'), '*.ts\n!keep.ts\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'pkg', 'keep.ts'), 'NESTED_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'pkg', 'drop.ts'), 'NESTED_MARK\n', 'utf8');

        const result = await grep(dir, 'NESTED_MARK', 0);

        assert.match(result, /keep\.ts/);
        assert.doesNotMatch(result, /drop\.ts/);
    } finally {
        cleanup(dir);
    }
});

/**
 * 目录判定不能复用文件判定的匹配器：`logs/` 只排除目录，若目录判定误用了文件匹配器
 * （丢掉仅目录桶），logs 就不会被剪枝，下面的反向规则会把 logs/x.log 一起放进来。
 */
test('grepFiles - 目录判定不会误用文件判定的匹配器', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\nlogs/\n!logs/x.log\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'logs'));
        fs.writeFileSync(path.join(dir, 'logs', 'x.log'), 'MISKEY_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'a.log'), 'MISKEY_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'keep.txt'), 'MISKEY_MARK\n', 'utf8');

        const result = await grep(dir, 'MISKEY_MARK', 0);

        assert.match(result, /keep\.txt/);
        assert.doesNotMatch(result, /logs/);
        assert.doesNotMatch(result, /a\.log/);
    } finally {
        cleanup(dir);
    }
});

/**
 * 已知偏差（故意保留，锁住方向）：git 按"最后一个匹配的规则生效"，子目录 .gitignore 的排除规则
 * 能覆盖父目录的反向规则；这里简化为"重新纳入优先"，于是父级 `!*.ts` 赢过子级 `*.ts`。
 * 偏差只会多搜文件（结果集是 git 的超集），不会漏，对搜索是安全方向。
 */
test('grepFiles - 子目录排除无法覆盖父目录反向规则（只多不漏）', async () => {
    const dir = makeTempDir();
    try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!*/\n!*.ts\n', 'utf8');
        fs.mkdirSync(path.join(dir, 'pkg'));
        fs.writeFileSync(path.join(dir, 'pkg', '.gitignore'), '*.ts\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'pkg', 'a.ts'), 'OVERRIDE_MARK\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'pkg', 'b.md'), 'OVERRIDE_MARK\n', 'utf8');

        const result = await grep(dir, 'OVERRIDE_MARK', 0);

        // 多纳入方向：子目录的 *.ts 赢不过父目录的 !*.ts
        assert.match(result, /a\.ts/);
        // 但非反向命中的文件照常被忽略，不会变成"什么都不忽略"
        assert.doesNotMatch(result, /b\.md/);
    } finally {
        cleanup(dir);
    }
});
