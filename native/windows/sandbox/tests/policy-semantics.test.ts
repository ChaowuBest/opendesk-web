import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const sandboxRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(sandboxRoot, 'runtime', 'sandbox.exe');
const windows = process.platform === 'win32';

async function run(file: string, args: string[], timeoutMs = 60000) {
    const proc = spawn(file, args, { windowsHide: true, env: process.env });
    // spawn 失败（ENOENT/EACCES：runtime/sandbox.exe 未构建、被杀软隔离、构建替换
    // 窗口期）只 emit 'error'；无人监听时 Node 会以 "Unhandled 'error' event" 直接
    // 终止整个测试进程，同文件其它用例结果全丢。捕获后随返回值带出（code = null），
    // 让调用方的断言变成一条明确的失败。
    let spawnError: NodeJS.ErrnoException | null = null;
    proc.once('error', (e) => { spawnError = e as NodeJS.ErrnoException; });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.stdin.on('error', () => {});
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
        const [code] = await once(proc, 'close');
        // spawn 失败直接抛，而不是返回 code=null：null 会让 `assert.notEqual(code, 0)`
        // 这类"期望失败"的断言静默通过（把崩溃伪装成预期结果）；抛出则让该用例
        // 明确失败，且不影响同文件其它用例（异常被 test runner 归到当前用例）。
        if (spawnError) throw new Error(`sandbox.exe spawn failed: ${spawnError.code ?? 'unknown'}`);
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

function virtualPath(hostPath: string): string {
    return '/' + hostPath.replace(/\\/g, '/').replace(':', '');
}

function rule(pattern: string, access: string, perm: string): string {
    return `[[rules]]\npath = "${pattern}"\naccess = "${access}"\nperm = "${perm}"`;
}

function writePolicy(directory: string, rules: string[]): string {
    const policy = path.join(directory, 'policy.toml');
    fs.writeFileSync(policy, ['version = 1', 'default = "deny"', ...rules].join('\n'));
    return policy;
}

async function decide(rules: string[], vpath: string, access: string) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-sem-'));
    try {
        const policy = writePolicy(directory, rules);
        const result = await run(executable, [
            'debug-rules', '--policy', policy, '--path', vpath, '--access', access
        ]);
        assert.equal(result.code, 0, `debug-rules failed: ${result.stdout}${result.stderr}`);
        const hit = result.stdout.match(/check -> (allow|deny) \((.*)\)/);
        assert.ok(hit, `unexpected debug-rules output: ${result.stdout}`);
        return { allowed: hit[1] === 'allow', why: hit[2] };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function powershell(): string {
    return path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
}

// 规则求值语义（四平台统一，与 core 的 dbox_policy_eval_static 对齐）：命中规则里
// 取 specificity 最大者，同 specificity 取 perm 更严者（deny > ask > allow）。
// Windows 的历史实现是 first-match-wins：宽规则写在前面会吞掉后面更具体的规则
// （bugs.md BUG-009 的 fail-open 陷阱），因此这些用例既验证语义，也锁定"与书写
// 顺序无关"这一性质。
test('most specific rule wins regardless of declaration order', { skip: !windows }, async () => {
    const broadDeny = rule('/C/probe/**', 'all', 'deny');
    const deepAllow = rule('/C/probe/allow/**', 'all', 'allow');
    for (const rules of [[broadDeny, deepAllow], [deepAllow, broadDeny]]) {
        const decision = await decide(rules, '/C/probe/allow/x.txt', 'read');
        assert.equal(decision.allowed, true, `most specific allow must win: ${JSON.stringify(decision)}`);
        assert.match(decision.why, /^rule#\d+ allow$/);
    }
});

test('most specific deny wins over a broader allow declared first', { skip: !windows }, async () => {
    const broadAllow = rule('/**', 'read', 'allow');
    const deepDeny = rule('/C/probe/secret/**', 'read', 'deny');
    for (const rules of [[broadAllow, deepDeny], [deepDeny, broadAllow]]) {
        const decision = await decide(rules, '/C/probe/secret/a.txt', 'read');
        assert.equal(decision.allowed, false, `most specific deny must win: ${JSON.stringify(decision)}`);
        assert.match(decision.why, /^rule#\d+ deny$/);
    }
});

test('same specificity: deny beats allow in either declaration order', { skip: !windows }, async () => {
    const allow = rule('/C/probe/**', 'all', 'allow');
    const deny = rule('/C/probe/**', 'all', 'deny');
    for (const rules of [[allow, deny], [deny, allow]]) {
        const decision = await decide(rules, '/C/probe/x.txt', 'read');
        assert.equal(decision.allowed, false, `deny must win the tie: ${JSON.stringify(decision)}`);
        assert.match(decision.why, /^rule#\d+ deny$/);
    }
});

test('same specificity: ask outranks allow, deny outranks ask', { skip: !windows }, async () => {
    const askOverAllow = await decide(
        [rule('/C/probe/**', 'all', 'allow'), rule('/C/probe/**', 'all', 'ask')],
        '/C/probe/x.txt', 'read'
    );
    // debug-rules 没有 ask 端点：选中 ask 规则后 fail-closed（why 里能看到 +ask）
    assert.match(askOverAllow.why, /^rule#\d+\+ask\(fail-closed\)$/, JSON.stringify(askOverAllow));

    const denyOverAsk = await decide(
        [rule('/C/probe/**', 'all', 'ask'), rule('/C/probe/**', 'all', 'deny')],
        '/C/probe/x.txt', 'read'
    );
    assert.equal(denyOverAsk.allowed, false, JSON.stringify(denyOverAsk));
    assert.match(denyOverAsk.why, /^rule#\d+ deny$/);
});

test('sandboxed read is denied by a more specific rule even when a broad allow comes first (BUG-009)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-sem-read-'));
    try {
        const secret = path.join(directory, 'secret');
        fs.mkdirSync(secret);
        const file = path.join(secret, 'a.txt');
        fs.writeFileSync(file, 'top-secret');
        const policy = writePolicy(directory, [
            rule('/**', 'read', 'allow'),
            rule('/**', 'execute', 'allow'),
            rule(`${virtualPath(secret)}/**`, 'read', 'deny')
        ]);
        const inner = `try { Get-Content -LiteralPath ${JSON.stringify(file)} -ErrorAction Stop; 'READ-ALLOWED' } catch { 'READ-DENIED' }`;
        const result = await run(executable, [
            'run', '--automount', '--policy', policy, '--',
            `"${powershell()}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /READ-DENIED/, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /READ-ALLOWED/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('/dir/** covers only the subtree: the directory itself stays readable while its content is denied', { skip: !windows }, async () => {
    // 用户预期的语义（四平台统一）：`/dir/** deny` 只拒绝目录里的内容，不拒绝
    // `/dir` 目录本身的读取。core 的尾部 ** 不匹配空段，Windows 的 Rule::matches
    // 也显式排除 basePath，二者一致。真实目录枚举（cmd dir）+ debug-rules 双验证。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-sem-dirself-'));
    try {
        const secret = path.join(directory, 'secret');
        fs.mkdirSync(secret);
        const file = path.join(secret, 'a.txt');
        fs.writeFileSync(file, 'top-secret');
        const rules = [
            rule('/**', 'read', 'allow'),
            rule('/**', 'execute', 'allow'),
            rule(`${virtualPath(secret)}/**`, 'read', 'deny')
        ];
        const policy = writePolicy(directory, rules);

        const dirDecision = await decide(rules, virtualPath(secret), 'read');
        assert.equal(dirDecision.allowed, true,
            `/dir/** must not cover the directory itself: ${JSON.stringify(dirDecision)}`);
        const fileDecision = await decide(rules, virtualPath(file), 'read');
        assert.equal(fileDecision.allowed, false, JSON.stringify(fileDecision));

        // 真实子进程：列目录必须成功（否则敏感目录的"目录可见、内容被拒"语义失效）
        const listing = await run(executable, [
            'run', '--automount', '--policy', policy, '--',
            'cmd.exe', '/c', 'dir', '/b', secret
        ]);
        assert.equal(listing.code, 0, listing.stdout + listing.stderr);
        assert.match(listing.stdout, /a\.txt/, `directory listing must stay available: ${listing.stdout}${listing.stderr}`);
        // 读内容仍被拒
        const read = await run(executable, [
            'run', '--automount', '--policy', policy, '--',
            'cmd.exe', '/c', 'type', file
        ]);
        assert.notEqual(read.code, 0, `reading the denied file must fail: ${read.stdout}${read.stderr}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('/dir/** allow does not cover the directory itself (generator adds the exact rule)', { skip: !windows }, async () => {
    // 反向：allow 侧同样不覆盖目录自身。这里锁住"补 X 是策略生成侧
    // （expandAllowTreeRules）的职责"，native 不会自动补——否则
    // "全盘 deny + 子树 allow" 的 readonly 策略会因为隐式放行目录自身而扩大面。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-sem-dirallow-'));
    try {
        const open = path.join(directory, 'open');
        fs.mkdirSync(open);
        const rules = [
            rule('/**', 'read', 'deny'),
            rule(`${virtualPath(open)}/**`, 'read', 'allow')
        ];
        const dirDecision = await decide(rules, virtualPath(open), 'read');
        assert.equal(dirDecision.allowed, false,
            `/dir/** allow must not cover the directory itself: ${JSON.stringify(dirDecision)}`);
        const childDecision = await decide(rules, virtualPath(path.join(open, 'x.txt')), 'read');
        assert.equal(childDecision.allowed, true, JSON.stringify(childDecision));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('built-in /dynobox allow cannot be disabled by a user deny', { skip: !windows }, async () => {
    // 沙箱内部路径（判定日志、ask 端点）由内置引导区规则保证可用。most-specific
    // 语义下"排在最前"不再等于优先（同 specificity 时 deny 反超 allow），所以内置
    // 规则用最大 specificity 固定住：用户 deny 同长度或更长也无法关闭它。
    for (const pattern of ['/dynobox', '/dynobox/**', '/dynobox/log.txt']) {
        const decision = await decide([rule(pattern, 'all', 'deny')], '/dynobox/log.txt', 'write');
        assert.equal(decision.allowed, true,
            `user deny ${pattern} must not disable the built-in allow: ${JSON.stringify(decision)}`);
    }
});

test('a more specific write allow beats a broad write deny (readonly-style policy)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sbx-sem-write-'));
    try {
        const writable = path.join(directory, 'writable');
        fs.mkdirSync(writable);
        const file = path.join(writable, 'a.txt');
        const policy = writePolicy(directory, [
            rule('/**', 'write', 'deny'),
            rule('/**', 'execute', 'allow'),
            rule(`${virtualPath(writable)}/**`, 'write', 'allow')
        ]);
        const result = await run(executable, [
            'run', '--automount', '--policy', policy, '--',
            'cmd.exe', '/c', `echo hi > "${file}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(fs.existsSync(file), true, `write must be allowed under the more specific rule: ${result.stdout}${result.stderr}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
