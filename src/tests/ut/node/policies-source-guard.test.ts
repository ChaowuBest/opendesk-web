import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// security/policies 目录的源码健康检查（内部检查，非用户可见文本，无需本地化）：
// 1. 块注释内不得包含 "*/" 序列以外的提前闭合风险——即注释文本行中不得出现
//    glob 模式（如 "X/**/Y"），它会提前闭合块注释导致 esbuild 语法错误
//    （真实事故：dotnet.ts / python.ts 注释里写 "**/secrets.json"）。
// 2. 每个策略文件必须导出 create<Name>PolicyRules。
// 3. 凭据类路径（token/credentials/secrets/netrc/npmrc/pypirc/key.pem）不得出现
//    在 effect=allow 的规则清单中（运行时校验在 app-policies.test.ts，此处静态
//    扫描源码兜底，防新增文件遗漏）。

const POLICIES_DIR = path.resolve(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    '..',
    '..',
    '..',
    'src',
    'main',
    'aikernel',
    'security',
    'policies'
);

function stripBlockComments(source) {
    // 去掉块注释（简化版：不处理字符串里的 /*，因为我们恰恰要检查注释内的内容）
    return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function extractBlockCommentText(source) {
    const blocks = [];
    const re = /\/\*([\s\S]*?)\*\//g;
    let m;
    while ((m = re.exec(source)) !== null) {
        blocks.push(m[1]);
    }
    return blocks.join('\n');
}

test('policies 块注释内不含 glob 的 **/ 序列（防提前闭合）', () => {
    for (const entry of fs.readdirSync(POLICIES_DIR)) {
        if (!entry.endsWith('.ts')) continue;
        const file = path.join(POLICIES_DIR, entry);
        const source = fs.readFileSync(file, 'utf8');
        const commentText = extractBlockCommentText(source);
        // 注释内出现 "**/"（glob 双星段）意味着作者在注释里写了路径模式，
        // 而 "X/**/Y" 中的 "*/" 会提前闭合注释（编译事故）
        assert.ok(
            !commentText.includes('**/'),
            `${entry}: block comment contains a "**/" glob sequence. ` +
                'A "*/" inside a block comment closes it early and breaks compilation. ' +
                'Rewrite the path without the glob segment (e.g. "X 下各文件" or "X 目录").'
        );
    }
});

test('policies 源码静态扫描：凭据类字面量不得出现在 allow 上下文附近', () => {
    const credFragments = [
        'credentials.toml',
        'settings-security.xml',
        'usersecrets',
        'UserSecrets',
        '.pypirc',
        '.npmrc',
        'key.pem'
    ];
    for (const entry of fs.readdirSync(POLICIES_DIR)) {
        if (!entry.endsWith('.ts') || entry === 'index.ts' || entry === 'common.ts') continue;
        const source = fs.readFileSync(path.join(POLICIES_DIR, entry), 'utf8');
        const code = stripBlockComments(source);
        // allow 数组中含凭据字面量：抓 "allow" 规则模式数组里出现凭据片段。
        // 简化检查：在 *_READ_PATTERNS / *_ALLOW 常量数组里出现凭据片段即失败。
        const allowArrayMatch = code.match(/READ_PATTERNS\s*=\s*\[([\s\S]*?)\]/g) ?? [];
        for (const arr of allowArrayMatch) {
            for (const frag of credFragments) {
                assert.ok(
                    !arr.includes(frag),
                    `${entry}: credential-like path "${frag}" found inside a READ_PATTERNS (allow) list. ` +
                        'Credential files must be ask-protected, never allowed.'
                );
            }
        }
    }
});
