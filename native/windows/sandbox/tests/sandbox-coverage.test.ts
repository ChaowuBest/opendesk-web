import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';

const sandboxRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(sandboxRoot, 'runtime', 'sandbox.exe');
const windows = process.platform === 'win32';

async function run(file: string, args: string[], stdin = '', env = process.env, timeoutMs = 60000, cwd?: string) {
    if (file === executable && args[0] === 'run' && !args.includes('--src') && !args.includes('--automount'))
        args = ['run', '--automount', ...args.slice(1)];
    const proc = spawn(file, args, { windowsHide: true, env, cwd });
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
    proc.stdin.end(stdin);
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

function resolvePython(): string | null {
    const fromEnv = process.env.OPENDESK_SANDBOX_PYTHON;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    const found = spawnSync('where.exe', ['python'], { encoding: 'utf8', windowsHide: true });
    const candidates = (found.stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((e) => /\.exe$/i.test(e) && fs.existsSync(e));
    return candidates.find((e) => !/windowsapps/i.test(e)) ?? candidates[0] ?? null;
}

function writeAllowPolicy(p: string): void {
    fs.writeFileSync(p, 'version = 1\ndefault = "allow"\n');
}

// ===== A. review 修复的针对性回归 =====

test('trailing-backslash access to a denied directory cannot escape (paths normalization)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-trailing-'));
    try {
        // 精确 deny 规则（不带 /**）：`sub` 目录读被拒。以带尾反斜杠的形式探测
        // （PowerShell Test-Path 'C:\...\sub\' 经 GetFileAttributesW → hook），
        // 归一化必须剥掉尾 '\' 命中 /C/.../sub 的 deny；否则映射出 /C/.../sub/
        // （尾斜杠）不匹配精确 deny → 默认放行 → 逃逸。用 PowerShell 而非 cmd：
        // cmd 的 dir 会自动把目录展开成 `dir\*`（通配路径不落在精确规则上）。
        fs.mkdirSync(path.join(directory, 'sub'));
        const policy = path.join(directory, 'policy.toml');
        const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${dirVirtual}/sub"\naccess = "read"\nperm = "deny"\n` +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n'
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 不带 $ErrorActionPreference='Stop'：Test-Path 对权限拒绝返回 $false（而非抛错）
        const inner = `if (Test-Path -LiteralPath '${path.join(directory, 'sub')}\\') { 'ESCAPED' } else { 'BLOCKED' }`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /BLOCKED/);
        assert.doesNotMatch(result.stdout, /ESCAPED/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('--del-to-trash honors system recycle-bin disable (NukeOnDelete)', { skip: !windows }, async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-bin-disable-'));
    const key = 'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer';
    const reg = 'C:/Windows/System32/reg.exe';
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const target = path.join(directory, 'keep.txt');
        fs.writeFileSync(target, 'x');
        // 临时启用全局回收站禁用（HKCU NukeOnDelete=1）。该策略位可能被组策略/
        // 本机 ACL 锁定（写入被拒），此时跳过用例（避免污染环境）；可写则验证
        // 沙箱内删除必须拒绝并保留原文件（绝不静默永久删除）。
        const set = spawnSync(reg, ['add', `HKCU\\${key}`, '/v', 'NukeOnDelete', '/t', 'REG_DWORD', '/d', '1', '/f'], { windowsHide: true });
        if (set.status !== 0) {
            context.skip(`cannot write HKCU ${key} NukeOnDelete (locked by policy/ACL)`);
            return;
        }
        try {
            const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
            const result = await run(executable, [
                'run', '--del-to-trash', '--policy', policy, '--',
                `"${cmd}" /d /c "del /q \"${target}\" & echo DEL-ATTEMPTED"`
            ]);
            assert.equal(result.code, 0, result.stdout + result.stderr);
            // 回收站禁用时删除失败 → 文件必须仍在
            assert.equal(fs.existsSync(target), true, 'file must survive when recycle bin is disabled');
        } finally {
            spawnSync(reg, ['delete', `HKCU\\${key}`, '/v', 'NukeOnDelete', '/f'], { windowsHide: true });
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// ===== B. 策略语义 =====

test('read deny blocks opening a file while directory listing of the parent still works', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-readdeny-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const secret = path.join(directory, 'secret.txt');
        const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
        fs.writeFileSync(secret, 'x');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${dirVirtual}/secret.txt"\naccess = "read"\nperm = "deny"\n`
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner =
            `$ErrorActionPreference = 'Stop'; ` +
            `try { Get-Content -LiteralPath ${JSON.stringify(secret)} -ErrorAction Stop; 'READ-ESCAPED' } catch { 'READ-BLOCKED' }; ` +
            `@(Get-ChildItem -LiteralPath ${JSON.stringify(directory)} | Measure-Object).Count`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /READ-BLOCKED/);
        assert.doesNotMatch(result.stdout, /READ-ESCAPED/);
        assert.match(result.stdout, /1/);   // 目录本身仍可枚举（secret.txt 存在）
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('execute deny rejects launching an exe', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-execdeny-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const exeVirtual = '/' + path.join(directory, 'blocked.exe').replace(/\\/g, '/').replace(':', '');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${exeVirtual}"\naccess = "execute"\nperm = "deny"\n`
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 把 cmd.exe 复制为 blocked.exe 放到受控目录，再尝试启动它
        const blocked = path.join(directory, 'blocked.exe');
        fs.copyFileSync(path.join(process.env.SystemRoot!, 'System32', 'cmd.exe'), blocked);
        const inner =
            `$ErrorActionPreference = 'Stop'; ` +
            `try { & ${JSON.stringify(blocked)} /c echo SHOULD-NOT-RUN; 'EXEC-ESCAPED' } catch { 'EXEC-BLOCKED' }`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /EXEC-BLOCKED/);
        assert.doesNotMatch(result.stdout, /SHOULD-NOT-RUN/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ask grants a subtree so subsequent writes skip the endpoint (grants v2)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-grants-'));
    // PS 启动会写系统目录（catroot 等）产生额外 ask；只统计 scratch 树路径的 ask
    let scratchAsks = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const o = JSON.parse(body || '{}');
            if (String(o.path || '').includes('scratch')) scratchAsks++;
            const allow = String(o.path || '').includes('scratch');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                decision: allow ? 'allow' : 'deny',
                grants: allow ? [{ path: '/C/**/scratch/**', access: 'write', ttl: 120 }] : []
            }));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const port = (server.address() as { port: number }).port;
        const policy = path.join(directory, 'policy.toml');
        const scratch = path.join(directory, 'scratch');
        fs.mkdirSync(scratch);
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                `[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 3000\ncache_ttl_seconds = 0\n` +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 连续写 scratch 下 3 个文件：第一次触 ask 并下发 grants，后两次应命中授权零问询
        const target1 = path.join(scratch, 'a.txt');
        const target2 = path.join(scratch, 'b.txt');
        const target3 = path.join(scratch, 'c.txt');
        const inner =
            `Set-Content -LiteralPath ${JSON.stringify(target1)} -Value '1'; ` +
            `Set-Content -LiteralPath ${JSON.stringify(target2)} -Value '2'; ` +
            `Set-Content -LiteralPath ${JSON.stringify(target3)} -Value '3'`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.ok(scratchAsks <= 1, `expected <=1 ask for the scratch subtree (grant hit), got ${scratchAsks}`);
        assert.equal(fs.readFileSync(target1, 'utf8').trim(), '1');
        assert.equal(fs.readFileSync(target2, 'utf8').trim(), '2');
        assert.equal(fs.readFileSync(target3, 'utf8').trim(), '3');
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ask decision cache expires after TTL and re-asks', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-ttl-'));
    let targetAsks = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const o = JSON.parse(body || '{}');
            if (String(o.path || '').endsWith('/w.txt')) targetAsks++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ decision: 'deny' }));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const port = (server.address() as { port: number }).port;
        const policy = path.join(directory, 'policy.toml');
        const target = path.join(directory, 'w.txt');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                `[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 2000\ncache_ttl_seconds = 1\n` +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
        );
        // 用 node 脚本做三次写（可控性优于 PowerShell）：前两次在 TTL 内应命中
        // 缓存（同路径只 ask 一次），Sleep 1.3s 后第三次应因缓存过期重新 ask
        const script = path.join(directory, 'ttl.mjs');
        fs.writeFileSync(
            script,
            `import fs from 'node:fs';\n` +
                `const T = ${JSON.stringify(target)};\n` +
                `for (let i = 0; i < 2; i++) { try { fs.writeFileSync(T, 'x') } catch {} }\n` +
                `await new Promise((r) => setTimeout(r, 1300));\n` +
                `try { fs.writeFileSync(T, 'x') } catch {}\n`
        );
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${process.execPath}" "${script}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.ok(targetAsks >= 2, `expected TTL expiry to re-ask the target, got ${targetAsks} asks`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('HTTP 500 from the endpoint fails closed (not cached)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-http500-'));
    // 统计目标路径的 ask；PS 启动写系统目录也会触发 500 拒绝（同样不缓存）
    let targetAsks = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            if (String(JSON.parse(body || '{}').path || '').endsWith('/w.txt')) targetAsks++;
            res.statusCode = 500;
            res.end('boom');
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const port = (server.address() as { port: number }).port;
        const policy = path.join(directory, 'policy.toml');
        const target = path.join(directory, 'w.txt');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                `[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 2000\ncache_ttl_seconds = 30\n` +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 500 response → fail-closed deny 且不缓存（连续两次都应再次发起请求）
        const inner =
            `try { Set-Content -LiteralPath ${JSON.stringify(target)} -Value '1' -ErrorAction Stop } catch {}; ` +
            `try { Set-Content -LiteralPath ${JSON.stringify(target)} -Value '2' -ErrorAction Stop } catch {}`;
        // PS 启动会写系统目录并触发 500 拒绝，可能改变 PS 退出码——断言核心语义：
        // 每个 target 写都真实发起请求（fail-closed 不缓存），且文件未落盘。
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.ok(targetAsks >= 2, `fail-closed must not cache the 500 decision (targetAsks=${targetAsks})`);
        assert.equal(fs.existsSync(target), false, 'file must not be written');
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('hook log output never leaks into the child stdout (stdout stays clean)', { skip: !windows }, async () => {
    // hook 的诊断日志（ask 失败等）只允许走 stderr/--log-file，绝不能混进子进程
    // 的 stdout 透传（log.h 的契约）。曾用 _vscwprintf 测长度会真的把日志写到
    // stdout（MSVC vswprintf 家族语义）——此用例守住 stdout 纯净。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-logclean-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const target = path.join(directory, 'w.txt');
        // 端点指向不可达端口：写操作触发 ask -> HTTP 连接失败 -> hook Log::warn
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                '[ask]\nendpoint = "http://127.0.0.1:1/decide"\ntimeout_ms = 500\n' +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
        );
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `cmd.exe /d /c "echo hi > \\"${target}\\""`
        ]);
        // stdout 只有子进程自身输出（cmd echo 重定向无输出 -> 应为空或仅换行）
        assert.doesNotMatch(result.stdout, /\[WRN\]|\[ERR\]|\[DBG\]|ASK|上游|err=|连接|失败/i,
            'hook log leaked into child stdout: ' + JSON.stringify(result.stdout));
        assert.equal(fs.existsSync(target), false, 'fail-closed write must not land');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('symbolic-link creation behaves like the host (no silent fake success)', { skip: !windows }, async () => {
    // 修复前：detours 注入环境下 kernelbase CreateSymbolicLinkW "假成功"（返回
    // 成功但文件系统无任何产物，lstat ENOENT），与宿主（无符号链接特权时
    // ERROR_PRIVILEGE_NOT_HELD/EPERM）不一致。修复后行为与宿主一致：
    //   有权限环境 -> 产物真实存在且 lstat 识别为符号链接；
    //   无权限环境（如本机普通令牌）-> symlinkSync 抛 EPERM，与宿主一致。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-symlink-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const outside = path.join(directory, 'outside.txt');
        const link = path.join(directory, 'linked.txt');
        const scriptFile = path.join(directory, 'symlink_probe.cjs');
        fs.writeFileSync(scriptFile, [
            "const fs = require('fs');",
            "const path = require('path');",
            `const outside = ${JSON.stringify(outside)};`,
            `const link = ${JSON.stringify(link)};`,
            "fs.writeFileSync(outside, 'x');",
            "let created = false, errCode = '';",
            "try { fs.symlinkSync(outside, link); created = true; } catch (e) { errCode = e.code || ''; }",
            "if (created) {",
            "  try {",
            "    const st = fs.lstatSync(link);",
            "    console.log('RESULT created-real-symlink=' + st.isSymbolicLink());",
            "  } catch (e) { console.log('RESULT created-but-unreachable err=' + e.code); }",
            "} else {",
            "  console.log('RESULT denied err=' + errCode);",
            "}",
        ].join('\n'));
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${process.execPath}" "${scriptFile}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        if (/created-real-symlink=true/.test(result.stdout)) {
            // 有权限环境：必须真实创建（修复前是 created-but-unreachable）
        } else if (/created-but-unreachable/.test(result.stdout)) {
            assert.fail('symlinkSync "succeeded" but produced no filesystem object (fake success)');
        } else if (/denied err=EPERM/.test(result.stdout)) {
            // 无权限环境：与宿主一致（宿主 symlinkSync 同样 EPERM）
        } else {
            assert.fail('unexpected symlink probe result: ' + JSON.stringify(result.stdout));
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('concurrent asks for the same path are coalesced into one upstream request', { skip: !windows }, async () => {
    // ask 风暴防护：单进程多线程并发写同一文件（同 key）只发一次上游请求，
    // 其他线程合并等待其结果（含 cache_ttl_seconds=0 场景，结果经 pending 共享）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-coalesce-'));
    let asks = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            asks++;
            setTimeout(() => { res.end(JSON.stringify({ decision: 'allow', grants: [] })); }, 30);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const port = (server.address() as { port: number }).port;
        const policy = path.join(directory, 'policy.toml');
        const target = path.join(directory, 'same.txt');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                `[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 3000\ncache_ttl_seconds = 0\n` +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
        );
        const script = path.join(directory, 'coalesce.mjs');
        fs.writeFileSync(
            script,
            "import fs from 'node:fs';\n" +
                `const T = ${JSON.stringify(target)};\n` +
                "const rs = await Promise.allSettled(Array.from({length: 8}, (_, i) => fs.promises.appendFile(T, String(i) + '\\n')));\n" +
                "console.log('FULFILLED=' + rs.filter((r) => r.status === 'fulfilled').length);\n"
        );
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${process.execPath}" "${script}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.ok(asks <= 2, `8 concurrent same-key asks must coalesce, got ${asks}`);
        assert.match(result.stdout, /FULFILLED=8/);
        // 全部追加成功 -> 8 行（每行一个数字 + 换行）
        const lines = fs.readFileSync(target, 'utf8').split('\n').filter((l) => l.length > 0);
        assert.equal(lines.length, 8, 'all coalesced writers must land');
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unreachable ask endpoint is circuit-broken so failures do not stack timeouts', { skip: !windows }, async () => {
    // 失败熔断：端点不可达（连接拒绝）时，传输级失败后 1s 冷却期内直接
    // fail-closed；连续 6 次写不同路径不应每次都打满 timeout（无熔断会 ~6×N）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-fuse-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                '[ask]\nendpoint = "http://127.0.0.1:1/decide"\ntimeout_ms = 3000\n' +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
        );
        const script = path.join(directory, 'fuse.mjs');
        fs.writeFileSync(
            script,
            "import fs from 'node:fs';\n" +
                `const D = ${JSON.stringify(directory)};\n` +
                "const t0 = Date.now();\n" +
                "await Promise.allSettled(Array.from({length: 6}, (_, i) => fs.promises.writeFile(D + '/w' + i + '.txt', 'x')));\n" +
                "console.log('DURATION=' + (Date.now() - t0));\n"
        );
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${process.execPath}" "${script}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // 熔断后整体耗时远小于 6×timeout（无熔断会约 18s；连接拒绝快 + 熔断约 3s）
        const m = /DURATION=(\d+)/.exec(result.stdout);
        assert.ok(m, 'DURATION marker missing: ' + JSON.stringify(result.stdout));
        assert.ok(Number(m[1]) < 2 * 3000, `unreachable endpoint must circuit-break (duration=${m[1]}ms)`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// ===== C. 文件系统语义 =====

test('concurrent threads create and write private files without interference', { skip: !windows }, async (context) => {
    const python = resolvePython();
    if (!python) return context.skip('Python not installed');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-threads-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        // 注：同文件多线程追加在 Windows 上本身不保证原子（CPython/CRT 的
        // O_APPEND 是 seek+write，宿主实测也会丢行，非沙箱问题）。改为验证
        // 多线程并发创建/写入各自私有文件（共享父目录），无跨文件干扰。
        const script = path.join(directory, 'threads.py');
        fs.writeFileSync(
            script,
            [
                'import threading, os',
                `D = ${JSON.stringify(directory)}`,
                'def worker(n):',
                '    p = os.path.join(D, f"t{n}.txt")',
                "    with open(p, 'w') as f:",
                "        for i in range(200): f.write(f'{n}-{i}\\n')",
                'threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]',
                '[t.start() for t in threads]',
                '[t.join() for t in threads]',
                'total = sum(sum(1 for _ in open(os.path.join(D, f"t{n}.txt"))) for n in range(4))',
                "print('TOTAL', total)"
            ].join('\n')
        );
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${python}" "${script}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        const m = /TOTAL (\d+)/.exec(result.stdout);
        assert.ok(m, result.stdout);
        assert.equal(parseInt(m[1], 10), 800, `expected 800 lines across 4 private files, got ${m[1]}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('2MB binary file roundtrip keeps byte-identical hash', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-big-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const src = path.join(directory, 'big.bin');
        const dst = path.join(directory, 'copy.bin');
        const data = Buffer.alloc(2 * 1024 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
        fs.writeFileSync(src, data);
        const nodeScript = path.join(directory, 'copy.mjs');
        fs.writeFileSync(
            nodeScript,
            `import fs from 'node:fs';\n` +
                `const s = fs.readFileSync(${JSON.stringify(src)});\n` +
                `fs.writeFileSync(${JSON.stringify(dst)}, s);\n` +
                `const c = fs.readFileSync(${JSON.stringify(dst)});\n` +
                `console.log('LEN=' + c.length + ' EQ=' + (s.equals(c)));\n`
        );
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${process.execPath}" "${nodeScript}"`, '', process.env, 60000
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /LEN=2097152/);
        assert.match(result.stdout, /EQ=true/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unicode/space filenames read and write correctly', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-unicode-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const file = path.join(directory, '中文 文件 ünïcode.txt');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner =
            `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
            `Set-Content -LiteralPath ${JSON.stringify(file)} -Value 'unicode-content' -Encoding UTF8; ` +
            `Get-Content -LiteralPath ${JSON.stringify(file)} -Encoding UTF8`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /unicode-content/);
        assert.equal(fs.readFileSync(file, 'utf8').includes('unicode-content'), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('--src single-root mode maps workdir to / and rejects outside paths', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-src-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "allow"\n');
        // cmd 副本放进 src 内（System32 cmd 在映射外）
        const cmdProbe = path.join(directory, 'cmd.exe');
        fs.copyFileSync(path.join(process.env.SystemRoot!, 'System32', 'cmd.exe'), cmdProbe);
        fs.writeFileSync(path.join(directory, 'inside.txt'), 'inside');
        const outer = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        // cmd 的 if exist 走 NtQueryAttributesFile（绕过 hook）→ 改用 type（CreateFileW）
        const inner =
            `type "${directory}\\inside.txt" > NUL && echo IN_1 || echo NOT_FOUND_1 & ` +
            `type "${outer}" > NUL && echo MAPPED_2 || echo NOT_FOUND_2`;
        const result = await run(executable, [
            'run', '--src', directory, '--policy', policy, '--',
            `"${cmdProbe}" /d /c "${inner}"`
        ], '', process.env, 60000);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /IN_1/);
        // 映射外的宿主路径 → not-found（而非 AccessDenied）
        assert.match(result.stdout, /NOT_FOUND_2/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('--env passes through to the child environment', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-env-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const secret = 'cov-secret-7c2a';
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const result = await run(executable, [
            'run', '--env', `COV_TEST_ENV=${secret}`, '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "Write-Output $env:COV_TEST_ENV"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, new RegExp(secret));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('child cwd is the host real path and relative paths resolve there', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-cwd-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        fs.writeFileSync(path.join(directory, 'rel.txt'), 'relative-ok');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 以宿主真实路径作为 spawn cwd 传入 sandbox.exe；子进程应继承该 cwd，
        // 相对路径（rel.txt）从该目录解析
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "Get-Content -LiteralPath 'rel.txt'; (Get-Location).Path"`
        ], '', process.env, 60000, directory);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // rel.txt 是相对路径：必须从传入 cwd（directory）解析；(Get-Location) 也应
        // 是 directory（宿主真实路径，非 /C/... 虚拟形式）
        assert.match(result.stdout, /relative-ok/);
        assert.ok(result.stdout.includes(directory), result.stdout);
        assert.doesNotMatch(result.stdout, /\/C\//);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('--del-to-trash removes a directory tree (folder path in recycle bin)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-dirtrash-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const removeMe = path.join(directory, 'remove-me');
        fs.mkdirSync(path.join(removeMe, 'inner'), { recursive: true });
        fs.writeFileSync(path.join(removeMe, 'inner', 'f.txt'), 'x');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner = `Remove-Item -LiteralPath ${JSON.stringify(removeMe)} -Recurse -Force -ErrorAction Stop; 'DIR-REMOVED'`;
        const result = await run(executable, [
            'run', '--del-to-trash', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /DIR-REMOVED/);
        assert.equal(fs.existsSync(removeMe), false, 'trashed directory must leave the source');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// ===== 第二轮补充：枚举/管道/句柄/策略健壮性/治理 =====

test('wildcard enumeration of a denied directory is blocked, allowed ones list contents', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-enum-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
        fs.mkdirSync(path.join(directory, 'secret'));
        fs.writeFileSync(path.join(directory, 'secret', 'key.txt'), 'TOP-SECRET');
        fs.mkdirSync(path.join(directory, 'pub'));
        fs.writeFileSync(path.join(directory, 'pub', 'ok.txt'), 'pub');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${dirVirtual}/secret"\naccess = "read"\nperm = "deny"\n` +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n'
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // Get-ChildItem 通配枚举：-LiteralPath 不展开通配符（把 * 当字面名），
        // 必须用 -Path 才能触发 FindFirstFile("dir\*") 枚举
        const inner =
            `$denied = (Get-ChildItem -Path ${JSON.stringify(path.join(directory, 'secret') + '\\*')} -ErrorAction SilentlyContinue | Measure-Object).Count; ` +
            `$allowed = (Get-ChildItem -Path ${JSON.stringify(path.join(directory, 'pub') + '\\*')} -ErrorAction Stop | Measure-Object).Count; ` +
            `if ($denied -gt 0) { 'DENIED-ENUM-ESCAPED' } else { 'DENIED-BLOCKED' }; 'ALLOWED=' + $allowed`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /DENIED-BLOCKED/);
        assert.doesNotMatch(result.stdout, /DENIED-ENUM-ESCAPED/);
        assert.match(result.stdout, /ALLOWED=1/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('named-pipe ask transport works end-to-end inside the sandbox', { skip: !windows }, async () => {
    // 管道 ask（pipe://）端到端：宿主管道端点 + 沙箱内 write ask 经命名管道询问。
    // 管道名需取 "pipe://" 之后的子串（见 ask.h pipeName）；此用例守住
    // "管道 ask 在沙箱内可用"这一行为，防止退化为 skip（曾因根因未明被跳过）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-pipeask-'));
    const pipeName = 'opendesk-cov-pipe-' + crypto.randomUUID().replace(/-/g, '');
    const policy = path.join(directory, 'policy.toml');
    fs.writeFileSync(
        policy,
        'version = 1\ndefault = "deny"\n' +
            `[ask]\nendpoint = "pipe://${pipeName}"\ntimeout_ms = 3000\ncache_ttl_seconds = 0\n` +
            '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
            '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
            '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
    );
    const endpoint = spawn(executable, ['endpoint', '--pipe', pipeName, '--default', 'allow'], {
        windowsHide: true,
        stdio: 'ignore'
    });
    // 无监听器时 spawn 失败会崩掉整个测试进程；端点没起来时下面的断言会给出
    // 明确的失败信息（write ask fail-closed）。
    endpoint.once('error', () => {});
    try {
        // 服务器就绪后触发 write ask：echo 重定向 -> CreateFileW write -> hook 经
        // 命名管道询问宿主管道端点 -> allow -> 文件写入成功
        const target = path.join(directory, 'write.txt');
        const result = await run(executable, ['run', '--policy', policy, '--', 'cmd.exe', '/d', '/c', `echo hello > "${target}"`]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(fs.readFileSync(target, 'utf-8').trim(), 'hello');
    } finally {
        endpoint.kill();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('already-open handles are not re-checked when policy changes (open semantics)', { skip: !windows }, async () => {
    // 与 NTFS 语义一致：已打开句柄不受后续策略变化影响。此用例验证"打开时已
    // 放行"的文件句柄在策略收紧后仍可继续读（hook 只在打开时判定）。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-openhandle-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const file = path.join(directory, 'open.txt');
        fs.writeFileSync(file, 'content-before');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 打开并读取一次（放行）；随后把文件删除（写拒绝），已打开句柄仍可读
        const inner =
            `$f = [IO.File]::Open(${JSON.stringify(file)}, 'Open', 'Read', 'Read'); ` +
            `$reader = [IO.StreamReader]::new($f); $first = $reader.ReadToEnd(); $reader.Dispose(); ` +
            `Remove-Item -LiteralPath ${JSON.stringify(file)} -Force -ErrorAction SilentlyContinue; ` +
            `$f.Dispose(); 'FIRST=' + $first`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /FIRST=content-before/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('malformed policy fails closed at startup', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-badpolicy-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        fs.writeFileSync(policy, 'version = 1\ndefault = "nonsense"\n[[rules]]\npath = "/**"\naccess = "bogus"\nperm = "allow"\n');
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${path.join(process.env.SystemRoot!, 'System32', 'cmd.exe')}" /c echo SHOULD-NOT-RUN`
        ]);
        assert.equal(result.code, 1, 'malformed policy must fail startup');
        assert.doesNotMatch(result.stdout + result.stderr, /SHOULD-NOT-RUN/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ask rule without endpoint fails closed (no upstream configured)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-noendpoint-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const target = path.join(directory, 'w.txt');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner = `try { Set-Content -LiteralPath ${JSON.stringify(target)} -Value 'x' -ErrorAction Stop } catch {}; 'DONE'`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(fs.existsSync(target), false, 'write must fail closed without an ask endpoint');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('killing the manager stops the descendant heartbeat (Job tree termination)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-heartbeat-'));
    const policy = path.join(directory, 'policy.toml');
    writeAllowPolicy(policy);
    const beatFile = path.join(directory, 'beat.txt');
    try {
        // 后代进程每秒递增写入心跳；杀管理进程后心跳必须停止（Job KILL_ON_JOB_CLOSE）
        const beatScript = path.join(directory, 'beat.cjs');
        fs.writeFileSync(
            beatScript,
            `const fs = require('node:fs');\n` +
                `const B = ${JSON.stringify(beatFile)};\n` +
                `const loop = () => {\n` +
                `    const n = fs.existsSync(B) ? parseInt(fs.readFileSync(B, 'utf8') || '0', 10) : 0;\n` +
                `    fs.writeFileSync(B, String(n + 1));\n` +
                `    setTimeout(loop, 100);\n` +
                `};\n` +
                `loop();\n`
        );
        const proc = spawn(executable, [
            'run', '--automount', '--policy', policy, '--',
            `"${process.execPath}" "${beatScript}"`
        ], { windowsHide: true, stdio: 'ignore' });
        // 无监听器时 spawn 失败会崩掉整个测试进程；这里记录后让下面的心跳等待
        // 循环尽快以明确信息失败，而不是白等 15 秒。
        let procSpawnError: NodeJS.ErrnoException | null = null;
        proc.once('error', (e) => { procSpawnError = e as NodeJS.ErrnoException; });
        // 等心跳写入
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(beatFile) || parseInt(fs.readFileSync(beatFile, 'utf8'), 10) < 3) {
            if (procSpawnError) assert.fail(`sandbox.exe spawn failed: ${procSpawnError.code ?? 'unknown'}`);
            if (Date.now() > deadline) throw new Error('heartbeat never started');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const before = parseInt(fs.readFileSync(beatFile, 'utf8'), 10);
        proc.kill('SIGKILL');
        await once(proc, 'close');
        // 杀管理进程后后代应被 Job 终止：心跳不再增长
        await new Promise((resolve) => setTimeout(resolve, 600));
        const after = fs.existsSync(beatFile) ? parseInt(fs.readFileSync(beatFile, 'utf8'), 10) : before;
        assert.ok(after <= before + 2, `heartbeat must stop after manager kill (before=${before}, after=${after})`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('deep nesting and long filenames roundtrip', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-deep-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        // 10 层嵌套 + 长文件名（~120 字符）
        let deep = directory;
        for (let i = 0; i < 10; i++) deep = path.join(deep, `level-${i}`);
        const longName = 'very-long-filename-' + 'x'.repeat(90) + '.txt';
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner =
            `$d = ${JSON.stringify(deep)}; ` +
            `New-Item -ItemType Directory -Path $d -Force | Out-Null; ` +
            `Set-Content -LiteralPath (Join-Path $d ${JSON.stringify(longName)}) -Value 'deep-ok' -ErrorAction Stop; ` +
            `Get-Content -LiteralPath (Join-Path $d ${JSON.stringify(longName)}) -ErrorAction Stop`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /deep-ok/);
        assert.equal(fs.readFileSync(path.join(deep, longName), 'utf8').trim(), 'deep-ok');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('case-insensitive access to the same file is allowed (NTFS semantics)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-case-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const file = path.join(directory, 'CaseFile.TXT');
        fs.writeFileSync(file, 'case-ok');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 用小写路径读取实际大写文件
        const lower = path.join(directory, 'casefile.txt');
        const inner = `Get-Content -LiteralPath ${JSON.stringify(lower)} -ErrorAction Stop`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /case-ok/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SetFileAttributes write denial protects read-only toggle', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-attr-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const dirVirtual = '/' + directory.replace(/\\/g, '/').replace(':', '');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${dirVirtual}/lock.txt"\naccess = "write"\nperm = "deny"\n`
        );
        const file = path.join(directory, 'lock.txt');
        fs.writeFileSync(file, 'x');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner =
            `try { Set-ItemProperty -LiteralPath ${JSON.stringify(file)} -Name IsReadOnly -Value $true -ErrorAction Stop; 'ATTR-ESCAPED' } ` +
            `catch { 'ATTR-BLOCKED' }`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /ATTR-BLOCKED/);
        assert.doesNotMatch(result.stdout, /ATTR-ESCAPED/);
        const attrs = fs.statSync(file);
        assert.equal((attrs.mode & 0o200) === 0, false, 'file must not become read-only');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
// ===== 第三轮补充：进程/文件/授权细化 =====

test('multi-process concurrent appends keep every line (process-level O_APPEND)', { skip: !windows }, async (context) => {
    const python = resolvePython();
    if (!python) return context.skip('Python not installed');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-mproc-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const target = path.join(directory, 'shared.txt');
        fs.writeFileSync(target, '');
        // 4 个独立进程各追加 200 行（进程级 FILE_APPEND_DATA 原子，宿主实测 800）
        const worker = path.join(directory, 'worker.py');
        fs.writeFileSync(
            worker,
            "import sys\nwith open(sys.argv[1], 'ab') as f:\n" +
                "    for i in range(200):\n" +
                "        f.write(('%d-%d\\n' % (int(sys.argv[2]), i)).encode())\n"
        );
        const inner =
            `"${python}" "${worker}" "${target}" 0 & ` +
            `"${python}" "${worker}" "${target}" 1 & ` +
            `"${python}" "${worker}" "${target}" 2 & ` +
            `"${python}" "${worker}" "${target}" 3`;
        const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${cmd}" /d /c "${inner}"`
        ], '', process.env, 60000);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // 后台 4 进程追加完成后统计（轮询直到稳定）
        const deadline = Date.now() + 15000;
        let count = 0;
        while (Date.now() < deadline) {
            try { count = fs.readFileSync(target, 'utf8').split('\n').filter((l) => l).length; } catch { count = 0; }
            if (count >= 800) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        assert.equal(count, 800, `expected 800 lines from 4 processes, got ${count}`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('git init/add/commit/branch workflow works inside the sandbox', { skip: !windows }, async (context) => {
    const git = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
    const gitPath = (git.stdout ?? '').split(/\r?\n/).find((l) => /\.exe$/i.test(l) && fs.existsSync(l));
    if (!gitPath) return context.skip('git not installed');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-git-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const repo = path.join(directory, 'repo');
        fs.mkdirSync(repo);
        const gitCmd = (cmd: string) =>
            `"${gitPath}" -c user.email=t@t -c user.name=t -C "${repo}" ${cmd}`;
        const script = path.join(directory, 'git-flow.cmd');
        fs.writeFileSync(
            script,
            [
                '@echo off',
                gitCmd('init -q'),
                'echo v1 > "' + repo + '\\a.txt"',
                gitCmd('add a.txt'),
                gitCmd('commit -q -m c1'),
                gitCmd('branch -q feature'),
                'echo v2 > "' + repo + '\\a.txt"',
                gitCmd('add a.txt'),
                gitCmd('commit -q -m c2'),
                gitCmd('checkout -q feature'),
                gitCmd('reset -q --hard HEAD~1'),
                'echo GIT-OK'
            ].join('\r\n')
        );
        const cmd = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe');
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${cmd}" /d /c "${script}"`
        ], '', process.env, 90000);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /GIT-OK/);
        // 宿主侧验证 .git 落盘
        assert.ok(fs.existsSync(path.join(repo, '.git', 'HEAD')), 'git repo must materialize on host');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('directory rename via Move-Item works', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-dirrename-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const from = path.join(directory, 'old-name');
        const to = path.join(directory, 'new-name');
        fs.mkdirSync(path.join(from, 'inner'), { recursive: true });
        fs.writeFileSync(path.join(from, 'inner', 'f.txt'), 'x');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner =
            `Move-Item -LiteralPath ${JSON.stringify(from)} -Destination ${JSON.stringify(to)} -ErrorAction Stop; ` +
            `Get-Content -LiteralPath ${JSON.stringify(path.join(to, 'inner', 'f.txt'))} -ErrorAction Stop; 'RENAMED'`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /RENAMED/);
        assert.equal(fs.existsSync(from), false);
        assert.equal(fs.existsSync(path.join(to, 'inner', 'f.txt')), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('large directory enumeration lists all entries (600 files)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-bigenum-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(directory, `f${i}.txt`), 'x');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner = `$count = (Get-ChildItem -Path ${JSON.stringify(path.join(directory, '*'))} -ErrorAction Stop | Measure-Object).Count; 'COUNT=' + $count`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // 600 个文件 + policy.toml = 601
        assert.match(result.stdout, /COUNT=601|COUNT=600/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ask rule can authorize launching an exe (execute ask)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-execask-'));
    let execAsks = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const o = JSON.parse(body || '{}');
            if (String(o.access || '') === 'execute') execAsks++;
            const allow = String(o.path || '').includes('runme');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ decision: allow ? 'allow' : 'deny' }));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const port = (server.address() as { port: number }).port;
        const policy = path.join(directory, 'policy.toml');
        const runme = path.join(directory, 'runme.exe');
        fs.copyFileSync(path.join(process.env.SystemRoot!, 'System32', 'cmd.exe'), runme);
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "deny"\n' +
                `[ask]\nendpoint = "http://127.0.0.1:${port}/decide"\ntimeout_ms = 3000\n` +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n' +
                '[[rules]]\npath = "/**"\naccess = "execute"\nperm = "ask"\n'
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner =
            `$ErrorActionPreference = 'Stop'; ` +
            `try { & ${JSON.stringify(runme)} /c echo EXEC-ALLOWED; 'LAUNCHED' } catch { 'LAUNCH-DENIED' }`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /LAUNCHED/);
        assert.match(result.stdout, /EXEC-ALLOWED/);
        assert.ok(execAsks >= 1, 'execute ask must reach endpoint');
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('more specific deny beats a broad allow in either declaration order (most-specific evaluation)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-denyorder-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        const file = path.join(directory, 'blocked.txt');
        const fileVirtual = '/' + file.replace(/\\/g, '/').replace(':', '');
        fs.writeFileSync(file, 'x');
        fs.writeFileSync(
            policy,
            'version = 1\ndefault = "allow"\n' +
                `[[rules]]\npath = "${fileVirtual}"\naccess = "read"\nperm = "deny"\n` +
                '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n'
        );
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const inner = `try { Get-Content -LiteralPath ${JSON.stringify(file)} -ErrorAction Stop; 'READ-ALLOWED' } catch { 'READ-DENIED' }`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        // 精确 deny 比 "/**" allow 更具体，因此与两者的书写顺序无关
        assert.match(result.stdout, /READ-DENIED/);
        assert.doesNotMatch(result.stdout, /READ-ALLOWED/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('junction target inside the root is judged by the named path (no reparse resolution)', { skip: !windows }, async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-junction-'));
    const junction = path.join(directory, 'link');
    const targetDir = path.join(directory, 'real-target');
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        fs.mkdirSync(targetDir);
        fs.writeFileSync(path.join(targetDir, 'f.txt'), 'junction-ok');
        const mklink = spawnSync('cmd.exe', ['/d', '/c', `mklink /J "${junction}" "${targetDir}"`], { encoding: 'utf8', windowsHide: true });
        if (mklink.status !== 0) return context.skip('junction creation failed');
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 经 junction 路径访问：hook 按传入路径名判定（策略全放行 → 允许），
        // 不解析落点（落点也在 roots 内，语义一致）
        const inner = `Get-Content -LiteralPath ${JSON.stringify(path.join(junction, 'f.txt'))} -ErrorAction Stop; 'JUNCTION-OK'`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /junction-ok/);
        assert.match(result.stdout, /JUNCTION-OK/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('hook stays robust with empty and overlong paths (no crash)', { skip: !windows }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cov-robust-'));
    try {
        const policy = path.join(directory, 'policy.toml');
        writeAllowPolicy(policy);
        const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        // 空路径与超长路径访问：hook 不得崩溃（放行/拒绝皆可，进程必须存活）
        const longPath = path.join(directory, 'x'.repeat(400) + '.txt');
        const inner =
            `try { Get-Item -LiteralPath '' -ErrorAction Stop } catch {}; ` +
            `try { Get-Item -LiteralPath ${JSON.stringify(longPath)} -ErrorAction Stop } catch {}; ` +
            `'STILL-ALIVE'`;
        const result = await run(executable, [
            'run', '--policy', policy, '--',
            `"${shell}" -NoProfile -NonInteractive -Command "${inner.replace(/"/g, '\\"')}"`
        ]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /STILL-ALIVE/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});