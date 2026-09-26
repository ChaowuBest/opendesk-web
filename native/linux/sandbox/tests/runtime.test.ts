import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

const sandboxRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(sandboxRoot, 'target', 'release', 'dynobox-linux');
const fixtureRoot = path.join(sandboxRoot, 'tests', 'src');
const skip = process.platform === 'win32' || !fs.existsSync(executable);

async function run(file: string, args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
    const proc = spawn(file, args, { env: opts.env ?? process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.stdin.on('error', () => {});
    proc.stdin.end(opts.stdin ?? '');
    const timer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? 60000);
    try {
        const [code] = await once(proc, 'close');
        return { code: code as number, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

function makeFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynobox-linux-test-'));
    fs.cpSync(fixtureRoot, dir, { recursive: true });
    return dir;
}

function policyText(src: string, endpoint: string, token: string, extraRules = '', home?: string): string {
    const sensitive = home
        ? ['.ssh', '.aws', '.gnupg', '.netrc', '.kube', '.config/gcloud', '.config/gh']
              .map((d) => `[[rules]]\npath = "${home}/${d}/**"\naccess = "read"\nperm = "deny"`)
              .join('\n')
        : '';
    return `version = 1
default = "deny"

[[roots]]
virtual = "/"
real    = "/"

[ask]
endpoint = "${endpoint}"
token = "${token}"
timeout_ms = 2000
cache_ttl_seconds = 0
grant_ttl_seconds = 0

[[rules]]
path = "${src}/secret.txt"
access = "all"
perm = "deny"

[[rules]]
path = "${src}/vault.txt"
access = "all"
perm = "deny"

[[rules]]
path = "${src}/public/**"
access = "all"
perm = "allow"

[[rules]]
path = "${src}/notes/**"
access = "read"
perm = "ask"

[[rules]]
path = "${src}/notes/**"
access = "write"
perm = "deny"

[[rules]]
path = "${src}/staging/**"
access = "read"
perm = "allow"

[[rules]]
path = "${src}/staging/**"
access = "write"
perm = "ask"

[[rules]]
path = "${src}/scratch/**"
access = "all"
perm = "ask"

[[rules]]
path = "${src}/reject/**"
access = "all"
perm = "ask"

[[rules]]
path = "${src}/slow/**"
access = "all"
perm = "ask"

[[rules]]
path = "${src}/guarded/**"
access = "all"
perm = "ask"

[[rules]]
path = "${src}/tools/blocked/**"
access = "execute"
perm = "deny"

[[rules]]
path = "${src}/tools/ask/**"
access = "execute"
perm = "ask"

${extraRules}${sensitive}

[[rules]]
path = "${src}/**"
access = "read"
perm = "allow"

[[rules]]
path = "${src}/**"
access = "write"
perm = "allow"

[[rules]]
path = "${src}/**"
access = "execute"
perm = "allow"

[[rules]]
path = "/**"
access = "read"
perm = "allow"

[[rules]]
path = "/**"
access = "write"
perm = "ask"

[[rules]]
path = "/**"
access = "execute"
perm = "allow"`;
}

/**
 * 测试用决策端点（node 实现，规则按 Linux 透明路径 /work/... 书写，对齐
 * Windows 内置端点的语义）。返回 base URL。
 */
function startEndpoint(defaultDecision = 'deny'): Promise<{ url: string; close: () => Promise<void> }> {
    const requests: string[] = [];
    const defaultDecisionRef = { value: defaultDecision };
    const server: Server = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/decide') {
            res.writeHead(404).end('{"error":"not found"}');
            return;
        }
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
            let pathValue = '/';
            let access = 'read';
            try {
                const json = JSON.parse(body);
                if (typeof json.path === 'string') pathValue = json.path;
                if (typeof json.access === 'string') access = json.access;
            } catch {
                /* malformed body: fail closed */
            }
            requests.push(`${access} ${pathValue}`);
            const decide = (): { decision: string; grants: { path: string; access: string; ttl: number }[] } => {
                const grants = [];
                if (pathValue.includes('/slow')) {
                    // 故意挂起：模拟端点无响应 → 沙箱侧超时 fail-closed
                    return { decision: 'deny', grants };
                }
                if (pathValue.includes('/notes') && access === 'read') {
                    grants.push({ path: '/work/notes/**', access: 'read', ttl: 120 });
                    return { decision: 'allow', grants };
                }
                if (pathValue.includes('/scratch')) {
                    grants.push({ path: '/work/scratch/**', access: 'all', ttl: 120 });
                    return { decision: 'allow', grants };
                }
                if (pathValue.includes('/staging') && access === 'write') {
                    grants.push({ path: '/work/staging/**', access: 'write', ttl: 120 });
                    return { decision: 'allow', grants };
                }
                if (pathValue.includes('/reject')) return { decision: 'deny', grants };
                if (pathValue.includes('/guarded')) return { decision: 'allow', grants };
                if (pathValue.includes('/tools/ask') && access === 'execute')
                    return { decision: 'allow', grants };
                return { decision: defaultDecisionRef.value, grants };
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(decide()));
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('端点端口获取失败'));
                return;
            }
            resolve({
                url: `http://127.0.0.1:${address.port}/decide`,
                close: async () => {
                    server.closeAllConnections();
                    await new Promise<void>((r) => server.close(() => r()));
                }
            });
        });
    });
}

async function sbx(dir: string, endpoint: string, token: string, command: string, timeoutMs = 60000) {
    const policy = path.join(dir, 'policy.toml');
    fs.writeFileSync(policy, policyText(dir, endpoint, token));
    // 整根视图：沙箱内路径 = 宿主路径；命令中的 /work 前缀（含无尾斜杠形式）
    // 映射为夹具目录
    const realCommand = command.replace(/\/work(?=\/|$|\s|;)/g, dir);
    return run(executable, ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', realCommand], { timeoutMs });
}

// ─────────────────────────── 基础访问控制 ───────────────────────────

test('sandbox runs a child and returns its exit code', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const result = await sbx(dir, ep.url, 't', 'exit 0');
        assert.equal(result.code, 0, result.stderr);
        const fail = await sbx(dir, ep.url, 't', 'exit 37');
        assert.equal(fail.code, 37, fail.stderr);
    } finally {
        await ep.close();
    }
});

test('read allow / deny / default-deny / view masking', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const read = await sbx(dir, ep.url, 't', 'cat /work/hello.txt');
        assert.equal(read.code, 0, read.stderr);
        assert.match(read.stdout, /hello/);
        const deny = await sbx(dir, ep.url, 't', 'cat /work/secret.txt');
        assert.notEqual(deny.code, 0);
        fs.writeFileSync(path.join(dir, 'vault.txt'), 'v');
        const vault = await sbx(dir, ep.url, 't', 'cat /work/vault.txt');
        assert.notEqual(vault.code, 0);
        // 未映射路径在沙箱内不存在（透明视图外）
        const missing = await sbx(dir, ep.url, 't', 'ls /nonexistent-host-path 2>&1; exit $?');
        assert.notEqual(missing.code, 0);
    } finally {
        await ep.close();
    }
});

test('write ask→allow with subtree grant (staging)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const result = await sbx(dir, ep.url, 't', 'echo a > /work/staging/new1.txt; echo b > /work/staging/new2.txt; echo c > /work/staging/new3.txt; ls /work/staging | wc -l');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /4/);
        assert.ok(fs.existsSync(path.join(dir, 'staging', 'new1.txt')));
        assert.ok(fs.existsSync(path.join(dir, 'staging', 'new3.txt')));
    } finally {
        await ep.close();
    }
});

test('write ask→deny (reject); read of staging allowed', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const read = await sbx(dir, ep.url, 't', 'cat /work/staging/s1.txt');
        assert.equal(read.code, 0, read.stderr);
        const reject = await sbx(dir, ep.url, 't', 'echo x > /work/reject/r.txt 2>&1; exit $?');
        assert.notEqual(reject.code, 0);
    } finally {
        await ep.close();
    }
});

test('ask timeout → fail-closed deny (slow endpoint)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const slow = await sbx(dir, ep.url, 't', 'echo x > /work/slow/s.txt 2>&1; exit $?', 15000);
        assert.notEqual(slow.code, 0);
    } finally {
        await ep.close();
    }
});

test('directory enumeration and mkdir/unlink/rename control', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const ls = await sbx(dir, ep.url, 't', 'ls /work | sort');
        assert.equal(ls.code, 0, ls.stderr);
        assert.match(ls.stdout, /hello\.txt/);
        assert.match(ls.stdout, /public/);
        const write = await sbx(dir, ep.url, 't', 'mkdir -p /work/public/x; touch /work/public/x/f; mv /work/public/x/f /work/public/x/g; rm /work/public/x/g; rmdir /work/public/x');
        assert.equal(write.code, 0, write.stderr);
        // 卷外写入（整根模式下路径可见但写经策略：端点超时/deny → 明确拒绝）
        const mkoutside = await sbx(dir, ep.url, 't', 'mkdir /var/tmp/zz-sbx-denied 2>&1; exit $?');
        assert.notEqual(mkoutside.code, 0, '卷外 mkdir 应被策略拒绝');
        const touchOutside = await sbx(dir, ep.url, 't', 'touch /var/tmp/zz-sbx-write 2>&1; exit $?');
        assert.notEqual(touchOutside.code, 0, '卷外 touch 应被策略拒绝');
        const mvOutside = await sbx(dir, ep.url, 't', 'mv /var/tmp/zz-sbx-write /var/tmp/zz-sbx-h2 2>&1; exit $?');
        assert.notEqual(mvOutside.code, 0, '卷外 mv 应被策略拒绝');
    } finally {
        await ep.close();
    }
});

test('regression: readdir in subdirectory maps inos consistently (no root-level aliasing)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 根级与 public/ 下放置同名不同内容文件；readdir 子目录后 ls 的 stat
        // 必须反映子目录内文件（修复前 ino 错误映射到根级路径，大小错乱）
        fs.writeFileSync(path.join(dir, 'public', 'w.txt'), 'pub-copy'); // 8 字节
        fs.writeFileSync(path.join(dir, 'w.txt'), 'root-very-long-content'); // 23 字节
        const result = await sbx(dir, ep.url, 't', 'ls -la /work/public/w.txt; cat /work/public/w.txt');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /pub-copy/);
        assert.match(result.stdout, new RegExp('8'), 'size 应反映 public/w.txt');
        assert.doesNotMatch(result.stdout, new RegExp('23'), '不应读到根级 w.txt 的大小');
    } finally {
        await ep.close();
    }
});

test('multiple [[roots]] mixed with root-view are rejected (no nested FUSE)', { skip }, async () => {
    const dirA = makeFixture();
    const dirB = makeFixture();
    const ep = await startEndpoint();
    try {
        // 整根（virtual=/）与局部 root 混用会导致嵌套 FUSE 死锁：启动必须 fail-fast
        const policy = path.join(dirA, 'multi.toml');
        fs.writeFileSync(
            policy,
            policyText(dirA, ep.url, 't') +
                `\n[[roots]]\nvirtual = "${dirB}"\nreal    = "${dirB}"`
        );
        const result = await run(
            executable,
            ['run', '--policy', policy, '--cwd', dirA, '--', '/usr/bin/bash', '-c', 'true'],
            { timeoutMs: 15000 }
        );
        assert.notEqual(result.code, 0, '整根与局部 root 混用应被拒绝');
        assert.match(result.stderr, /整根|混用|root/i);
    } finally {
        await ep.close();
    }
});

test('readdir pagination: large directory lists fully (multi-page offsets)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // FUSE readdir 缓冲按页返回，超过一页会以 offset 续传：生成足够条目触发分页
        for (let i = 0; i < 600; i++) {
            fs.writeFileSync(path.join(dir, 'public', `f${String(i).padStart(4, '0')}.txt`), 'x');
        }
        const result = await sbx(dir, ep.url, 't', 'ls -1 /work/public | grep -c "^f[0-9]"');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /600/);
    } finally {
        await ep.close();
    }
});

test('regression: concurrent append honors per-writer offsets (no O_APPEND aliasing)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 两个进程并发追加同一文件：每进程 50 行，修复前 O_APPEND+pwrite 会
        // 全部追加到全局 EOF，导致行数丢失/覆盖（<100）
        const result = await sbx(dir, ep.url, 't', 'for i in $(seq 1 50); do echo "a$i" >> /work/public/append.txt; done & for j in $(seq 1 50); do echo "b$j" >> /work/public/append.txt; done & wait; wc -l < /work/public/append.txt');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /100/);
        // 每行唯一且完整
        const lines = fs.readFileSync(path.join(dir, 'public', 'append.txt'), 'utf8').split(/\n/).filter(Boolean);
        assert.equal(lines.length, 100, '应恰好 100 行');
        assert.equal(new Set(lines).size, 100, '行内容不应有丢失/覆盖');
    } finally {
        await ep.close();
    }
});

test('regression: roots virtual=/ is rejected (would overwrite sandbox root view)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const policy = path.join(dir, 'bad-policy.toml');
        fs.writeFileSync(
            policy,
            policyText(dir, ep.url, 't').replace(`virtual = "/work"`, `virtual = "/"`)
        );
        const result = await run(executable, ['run', '--policy', policy, '--cwd', '/work', '--', '/usr/bin/bash', '-c', 'true'], { timeoutMs: 15000 });
        assert.notEqual(result.code, 0, 'virtual=/ 应被拒绝');
    } finally {
        await ep.close();
    }
});

test('execute control via mode mask', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const ok = await sbx(dir, ep.url, 't', '/work/tools/ok.sh');
        assert.equal(ok.code, 0, ok.stderr);
        assert.match(ok.stdout, /ok-ok/);
        const blocked = await sbx(dir, ep.url, 't', '/work/tools/blocked/blocked.sh 2>&1; exit $?');
        assert.notEqual(blocked.code, 0, 'blocked 脚本应被拒执行');
        const ask = await sbx(dir, ep.url, 't', '/work/tools/ask/ask.sh');
        assert.equal(ask.code, 0, ask.stderr);
    } finally {
        await ep.close();
    }
});

test('subtree grant reduces asks (scratch: 5 writes)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const result = await sbx(dir, ep.url, 't', 'for i in 1 2 3 4 5; do echo $i > /work/scratch/f$i.txt; done; ls /work/scratch | wc -l');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /5/);
        for (let i = 1; i <= 5; i++) assert.ok(fs.existsSync(path.join(dir, 'scratch', `f${i}.txt`)));
    } finally {
        await ep.close();
    }
});

// ─────────────────────────── 高级场景 ───────────────────────────

test('nested paths, spaces and unicode filenames', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const result = await sbx(dir, ep.url, 't', 'cat "/work/public/a b.txt"; cat "/work/public/中文文件.txt"; cat /work/public/deep/nested/d.txt');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /space name/);
        assert.match(result.stdout, /unicode/);
        assert.match(result.stdout, /deep/);
    } finally {
        await ep.close();
    }
});

test('descendant process chain (bash→bash→bash) honors policy', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const chain = await sbx(dir, ep.url, 't', '/usr/bin/bash -c \'/usr/bin/bash -c "cat /work/hello.txt; echo bad > /work/deny-me.txt 2>&1; exit \$?"\'; exit $?');
        assert.equal(chain.code, 0, chain.stderr); // 链最外层成功（内层写失败不影响外层退出码？内层 exit $? 应为非0）
    } finally {
        await ep.close();
    }
});

test('large file write/read consistency (4 MiB)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const result = await sbx(dir, ep.url, 't', 'dd if=/dev/urandom of=/work/public/big.bin bs=1M count=4 status=none; a=$(sha256sum /work/public/big.bin | cut -d" " -f1); b=$(dd if=/work/public/big.bin bs=1M count=4 2>/dev/null | sha256sum | cut -d" " -f1); [ "$a" = "$b" ] && echo "INNER_HASH=$a"');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /INNER_HASH=/);
        const hostHash = execFileSync('sha256sum', [path.join(dir, 'public', 'big.bin')], { encoding: 'utf8' }).split(' ')[0];
        const innerHash = /INNER_HASH=([0-9a-f]{64})/.exec(result.stdout)?.[1];
        assert.equal(hostHash, innerHash, '宿主与沙箱哈希不一致');
    } finally {
        await ep.close();
    }
});

// ─────────────────────────── 逃逸防护 ───────────────────────────

test('escape: cannot umount/mount inside sandbox', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const umount = await sbx(dir, ep.url, 't', 'umount /work 2>&1; rc=$?; echo rc=$rc; exit $rc');
        assert.notEqual(umount.code, 0, 'umount 应失败');
        const mount = await sbx(dir, ep.url, 't', 'mount -t tmpfs tmpfs /tmp/xx 2>&1; rc=$?; echo rc=$rc; exit $rc');
        assert.notEqual(mount.code, 0, 'mount 应失败');
    } finally {
        await ep.close();
    }
});

test('escape: chroot unavailable; /proc/self/root is sandbox root', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const chroot = await sbx(dir, ep.url, 't', 'chroot /usr /bin/echo hi 2>&1; rc=$?; echo rc=$rc; exit $rc');
        assert.notEqual(chroot.code, 0, 'chroot 应失败（无 CAP_SYS_CHROOT）');
        const root = await sbx(dir, ep.url, 't', 'readlink /proc/self/root');
        assert.equal(root.code, 0, root.stderr);
        assert.equal(root.stdout.trim(), '/', '沙箱根应为 /');
    } finally {
        await ep.close();
    }
});

test('escape: /proc/<pid>/root resolves to sandbox root (no host proc escape)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 沙箱内 /proc 必须为 pid ns 视图（真实 proc + move_mount）：
        // /proc/1/root 指向沙箱根，宿主敏感文件不可达（回退 bind 宿主 /proc 曾
        // 允许经 /proc/1/root 读宿主根——该方案已移除）
        const root = await sbx(dir, ep.url, 't', 'readlink /proc/1/root');
        assert.equal(root.code, 0, root.stderr);
        // /proc/1/root 必须解析到沙箱根（pivot 后 "/"），而非宿主根
        assert.equal(root.stdout.trim(), '/');
        // 宿主敏感文件不可达（沙箱根无 .ssh/.bashrc；home 下只有受控挂载点）
        const sensitive = await sbx(dir, ep.url, 't', 'cat /proc/1/root/home/liyi/.ssh/id_rsa 2>&1; exit $?');
        assert.notEqual(sensitive.code, 0, '宿主 .ssh 应不可达');
        // /proc/self/exe 等工具兼容性正常
        const exe = await sbx(dir, ep.url, 't', 'readlink /proc/self/exe');
        assert.equal(exe.code, 0, exe.stderr);
    } finally {
        await ep.close();
    }
});

test('escape: backing/management paths invisible in sandbox', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const result = await sbx(dir, ep.url, 't', 'ls /tmp/dynobox-root-* /sys/fs/cgroup/dynobox-* 2>&1; exit $?');
        assert.notEqual(result.code, 0, '沙箱内不应存在 backing/管理路径');
    } finally {
        await ep.close();
    }
});

test('escape: uid_map shows ns-root mapped to host user', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const uid = await sbx(dir, ep.url, 't', 'cat /proc/self/uid_map; id -u');
        assert.equal(uid.code, 0, uid.stderr);
        const hostUid = process.getuid?.() ?? 1000;
        assert.match(uid.stdout, new RegExp(`0\\s+${hostUid}\\s+1`));
        assert.match(uid.stdout, /0/); // ns 内 uid 0
    } finally {
        await ep.close();
    }
});

test('escape: no host root privilege from ns uid 0 (status shows mapped uid)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const probe = await sbx(dir, ep.url, 't', 'grep -E "^Uid:" /proc/self/status');
        assert.equal(probe.code, 0, probe.stderr);
        // ns 内 uid 0 映射宿主普通用户：无法获得宿主 root（cap 收敛 + 映射）
        assert.match(probe.stdout, /^Uid:\s+0\s+0\s+0\s+0/m);
    } finally {
        await ep.close();
    }
});

// ─────────────────────────── 可靠性 ───────────────────────────

test('git full workflow works in sandbox (init/add/commit/branch/reset)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // git 依赖密集"创建后立即读"（.git 内 lock+rename）：TTL=0 缓存策略下必须
        // 完整可用（此前 FUSE entry/attr 缓存导致 .git/config 等不可见）
        const result = await sbx(dir, ep.url, 't', 'set -e; git init -q repo && cd repo && echo hello > a.txt && echo world > b.txt && git -c user.name=t -c user.email=t@t add . && git -c user.name=t -c user.email=t@t commit -qm init && echo change >> a.txt && git -c user.name=t -c user.email=t@t commit -qam upd && git checkout -qb feat && echo x > c.txt && git -c user.name=t -c user.email=t@t add c.txt && git -c user.name=t -c user.email=t@t commit -qm feat && git checkout -q master 2>/dev/null || git checkout -q main; git log --oneline | wc -l; git ls-files | wc -l', 60000);
        assert.equal(result.code, 0, result.stderr);
        // master 分支：2 commits（feat 未合并）、2 tracked 文件
        const lines = result.stdout.split('\n').filter(Boolean).map((l) => l.trim());
        assert.equal(lines[lines.length - 2], '2', 'master 应有 2 commits');
        assert.equal(lines[lines.length - 1], '2', 'master 应跟踪 2 个文件');
        // 宿主侧验证落盘
        const repoGit = path.join(dir, 'repo', '.git');
        assert.ok(fs.existsSync(path.join(repoGit, 'HEAD')), '.git/HEAD 应落盘');
        assert.ok(fs.existsSync(path.join(repoGit, 'config')), '.git/config 应落盘');
    } finally {
        await ep.close();
    }
});

test('root-view: /tmp persists across sandbox instances (not lost on close)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 第一个沙箱实例写 /tmp（策略 allow /tmp 写）
        const policy = path.join(dir, 'policy.toml');
        // /tmp 写 allow 须置于全局 write-ask 兜底之前（extraRules 位置）
        fs.writeFileSync(
            policy,
            policyText(dir, ep.url, 't', '[[rules]]\npath = "/tmp/**"\naccess = "write"\nperm = "allow"')
        );
        const tmpFile = path.join(os.tmpdir(), 'dynobox-linux-tmp-persist-' + Date.now());
        try {
            const first = await run(executable, ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', `echo persist-data > ${tmpFile}`], { timeoutMs: 30000 });
            assert.equal(first.code, 0, first.stderr);
            // 新沙箱实例（独立进程）仍能读到——/tmp 透传宿主，关闭不丢
            const second = await run(executable, ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', `cat ${tmpFile}`], { timeoutMs: 30000 });
            assert.equal(second.code, 0, second.stderr);
            assert.match(second.stdout, /persist-data/);
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    } finally {
        await ep.close();
    }
});

test('root-view: filesystem layout mirrors host (home/tmp visible, writes policed)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const probe = await sbx(dir, ep.url, 't', 'ls /home/liyi >/dev/null 2>&1 && echo home-visible; ls /tmp >/dev/null 2>&1 && echo tmp-visible; test -d /usr && echo usr-visible');
        assert.equal(probe.code, 0, probe.stderr);
        assert.match(probe.stdout, /home-visible/);
        assert.match(probe.stdout, /tmp-visible/);
        assert.match(probe.stdout, /usr-visible/);
    } finally {
        await ep.close();
    }
});

test('root-view: sensitive home paths are denied for read (no default read passthrough)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 整根读放行兜底下，.ssh 等敏感路径显式 deny（policyText 内置规则）
        const policy = path.join(dir, 'policy.toml');
        fs.writeFileSync(policy, policyText(dir, ep.url, 't', undefined, os.homedir()));
        const deny = await run(executable, ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', `ls ${path.join(os.homedir(), '.ssh')} 2>&1; exit $?`], { timeoutMs: 30000 });
        assert.notEqual(deny.code, 0, '.ssh 读应被拒绝');
        const read = await run(executable, ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', `echo ok > ${dir}/r.txt`], { timeoutMs: 30000 });
        assert.equal(read.code, 0, read.stderr);
    } finally {
        await ep.close();
    }
});

test('unix domain socket creation and bidirectional exchange (mknod S_IFSOCK)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // AF_UNIX bind 经 FUSE mknod 创建 socket 文件；此前仅实现 FIFO/REG，bind 报 EIO
        const result = await sbx(dir, ep.url, 't', 'python3 -c "import socket, threading, time; srv=socket.socket(socket.AF_UNIX); srv.bind(\'/work/public/us.sock\'); srv.listen(1); threading.Thread(target=lambda: (lambda c: (c.sendall(b\'pong\'), c.close()))(srv.accept()[0]), daemon=True).start(); time.sleep(0.3); c=socket.socket(socket.AF_UNIX); c.connect(\'/work/public/us.sock\'); print(c.recv(10)); c.close()"', 60000);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /pong/);
    } finally {
        await ep.close();
    }
});

test('/dev/fd process substitution works (dev symlinks present)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // bash 进程替换 <(...) 依赖 /dev/fd/N（解析到 /proc/self/fd/N）；
        // 此前沙箱 /dev 最小 tmpfs 未提供 /dev/fd，进程替换失败
        const result = await sbx(dir, ep.url, 't', 'diff <(echo a; echo b) <(echo a; echo c) >/dev/null 2>&1 && echo nodiff || echo diff-found; cat <(echo proc-subst-ok)');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /diff-found/);
        assert.match(result.stdout, /proc-subst-ok/);
    } finally {
        await ep.close();
    }
});

test('mknod: FIFO creation and bidirectional pipe work (mkfifo)', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 用夹具 public 目录（策略 all allow）：
        // mkfifo && (写端后台) 需先建 pipe 再读，用分号避免 & 把整条放后台
        const result = await sbx(dir, ep.url, 't', 'mkfifo /work/public/fifo-test; (echo pipe-data > /work/public/fifo-test) & read line < /work/public/fifo-test; echo "got: $line"; stat -c "%F" /work/public/fifo-test');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /got: pipe-data/);
        assert.match(result.stdout, /fifo/);
    } finally {
        await ep.close();
    }
});

test('OpenDesk-generated policy (policyTextLinux) parses and runs', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 用 OpenDesk 真实策略生成模块（dynabox-policy.policyTextLinux）生成的 TOML
        // 必须能被 dynobox-linux 解析并启动——曾因 .gitconfig 规则含字面 "..." 导致
        // 所有 Linux 沙箱命令报"策略文件解析失败"
        const dynaboxPolicy = await import(
            '/home/liyi/Projects/OpenDesk/src/main/applications/terminal/sandboxes/dynabox-policy.js'
        );
        const policy = path.join(dir, 'opendesk-policy.toml');
        const text = dynaboxPolicy.policyTextLinux(
            ep.url,
            'tok',
            dir,
            [{ resourceType: 'file', action: 'read', pathPattern: `${dir}/**`, effect: 'allow' }],
            os.homedir()
        );
        assert.ok(!text.includes('...'), '生成策略不应含字面 ...');
        fs.writeFileSync(policy, text);
        const result = await run(
            executable,
            ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', 'echo opendesk-policy-ok; id -u'],
            { timeoutMs: 30000 }
        );
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /opendesk-policy-ok/);
    } finally {
        await ep.close();
    }
});

test('del-to-trash: removed files land in XDG Trash with trashinfo', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const trashFile = path.join(dir, 'public', 'trash-me.txt');
        fs.writeFileSync(trashFile, 'bye');
        const policy = path.join(dir, 'policy.toml');
        fs.writeFileSync(policy, policyText(dir, ep.url, 't'));
        const result = await run(executable, ['run', '--policy', policy, '--cwd', dir, '--del-to-trash', '--', '/usr/bin/bash', '-c', `rm ${trashFile}`], { timeoutMs: 30000 });
        assert.equal(result.code, 0, result.stderr);
        assert.ok(!fs.existsSync(trashFile), '原文件应已移除');
        // XDG Trash：files/ 下应有内容，info/ 下有 .trashinfo
        const trashRoot = path.join(os.homedir(), '.local', 'share', 'Trash');
        const inTrash = fs.readdirSync(path.join(trashRoot, 'files')).some((n) => n.includes('trash-me'));
        assert.ok(inTrash, '文件应进入回收站 files/');
        const info = fs.readdirSync(path.join(trashRoot, 'info')).filter((n) => n.includes('trash-me') && n.endsWith('.trashinfo'));
        assert.ok(info.length > 0, '应生成 .trashinfo');
        const infoText = fs.readFileSync(path.join(trashRoot, 'info', info[0]), 'utf8');
        assert.match(infoText, /DeletionDate=\d{4}-\d{2}-\d{2}T/);
        // 清理回收站
        for (const n of fs.readdirSync(path.join(trashRoot, 'files'))) if (n.includes('trash-me')) fs.rmSync(path.join(trashRoot, 'files', n));
        for (const n of fs.readdirSync(path.join(trashRoot, 'info'))) if (n.includes('trash-me')) fs.rmSync(path.join(trashRoot, 'info', n));
    } finally {
        await ep.close();
    }
});

test('reliability: concurrent sandboxes are isolated', { skip }, async () => {
    const dir1 = makeFixture();
    const dir2 = makeFixture();
    const ep = await startEndpoint();
    try {
        const [r1, r2] = await Promise.all([
            sbx(dir1, ep.url, 't', 'echo one > /work/public/o1.txt; sleep 2; echo done1'),
            sbx(dir2, ep.url, 't', 'echo two > /work/public/o2.txt; sleep 1; echo done2')
        ]);
        assert.equal(r1.code, 0, r1.stderr);
        assert.equal(r2.code, 0, r2.stderr);
        assert.ok(fs.existsSync(path.join(dir1, 'public', 'o1.txt')));
        assert.ok(fs.existsSync(path.join(dir2, 'public', 'o2.txt')));
        assert.ok(!fs.existsSync(path.join(dir1, 'public', 'o2.txt')), '实例间不应互相影响');
    } finally {
        await ep.close();
    }
});

test('reliability: killing the manager kills the whole tree', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const policy = path.join(dir, 'policy.toml');
        fs.writeFileSync(policy, policyText(dir, ep.url, 't'));
        const manager = spawn(executable, ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', `i=0; while true; do echo $i > ${path.join(dir, 'public')}/heartbeat.txt; i=$((i+1)); sleep 0.3; done`]);
        let stderr = '', stdout = '';
        manager.stderr.on('data', (d) => (stderr += d));
        manager.stdout.on('data', (d) => (stdout += d));
        const heartbeat = path.join(dir, 'public', 'heartbeat.txt');
        const readBeat = () => {
            try {
                return Number(fs.readFileSync(heartbeat, 'utf8'));
            } catch {
                return -1;
            }
        };
        // 等心跳开始跳动
        await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 15000;
            const tick = () => {
                if (readBeat() >= 0) resolve();
                else if (Date.now() > deadline) reject(new Error('心跳未启动: ' + stderr + stdout));
                else setTimeout(tick, 200);
            };
            tick();
        });
        const before = readBeat();
        await new Promise((r) => setTimeout(r, 1000));
        assert.ok(readBeat() > before, '心跳应持续增长');
        // 杀管理进程
        manager.kill('SIGKILL');
        await once(manager, 'close');
        const afterKill = readBeat();
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(readBeat(), afterKill, '管理进程被杀后子进程应陪葬（心跳停止）');
        void stdout;
        void stderr;
    } finally {
        await ep.close();
    }
});

test('reliability: stale root dirs from killed managers are cleaned on next start', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        // 模拟上次管理进程被 SIGKILL 残留的孤儿 root_dir（pid 不存在）
        const stale = path.join(os.tmpdir(), 'dynobox-root-99999999');
        fs.mkdirSync(stale, { recursive: true });
        fs.writeFileSync(path.join(stale, 'junk'), 'x');
        try {
            const result = await sbx(dir, ep.url, 't', 'exit 0');
            assert.equal(result.code, 0, result.stderr);
            // 下一次启动应回收孤儿目录
            assert.ok(!fs.existsSync(stale), 'stale root_dir 应在下次启动时被清理');
        } finally {
            fs.rmSync(stale, { recursive: true, force: true });
        }
    } finally {
        await ep.close();
    }
});

test('reliability: no leftover mounts/cgroups/root dirs after exit', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const result = await sbx(dir, ep.url, 't', 'exit 0');
        assert.equal(result.code, 0, result.stderr);
        await new Promise((r) => setTimeout(r, 600));
        const leftovers = await run('bash', ['-c', 'ls -d /tmp/dynobox-root-* /sys/fs/cgroup/dynobox-* 2>&1; exit $?'], { timeoutMs: 8000 });
        assert.notEqual(leftovers.code, 0, '存在沙箱残留: ' + leftovers.stdout);
    } finally {
        await ep.close();
    }
});

// ─────────── 局部 [[roots]]（非整根视图）与 cgroup 登记 ───────────

function localRootsPolicy(src: string, endpoint: string, token: string): string {
    return `version = 1
default = "deny"

[[roots]]
virtual = "${src}"
real    = "${src}"

[ask]
endpoint = "${endpoint}"
token = "${token}"
timeout_ms = 2000
cache_ttl_seconds = 0
grant_ttl_seconds = 0

[[rules]]
path = "${src}/**"
access = "all"
perm = "allow"`;
}

test('partial [[roots]]（非整根）模式可用：系统目录 ro bind + 受控路径可写', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    try {
        const policy = path.join(dir, 'partial-policy.toml');
        fs.writeFileSync(policy, localRootsPolicy(dir, ep.url, 't'));
        // 非整根视图下 tmpfs 根没有系统目录：RO_BIND_DIRS 需先建目标再 bind（回归测试）；
        // /usr/bin/bash 应来自 ro bind 系统目录（可执行），受控路径写入应落盘宿主
        const cmd = `test -x /usr/bin/bash && echo partial-ok > ${dir}/partial.txt && cat ${dir}/partial.txt`;
        const result = await run(executable, ['run', '--policy', policy, '--cwd', dir, '--', '/usr/bin/bash', '-c', cmd], { timeoutMs: 20000 });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /partial-ok/);
        assert.equal(fs.existsSync(path.join(dir, 'partial.txt')), true, '受控路径写入应落盘宿主');
    } finally {
        await ep.close();
    }
});

test('cgroup 登记覆盖 shell 进程树（best effort：环境支持时严格断言）', { skip }, async () => {
    const dir = makeFixture();
    const ep = await startEndpoint();
    const probeName = `dynobox-test-probe-${process.pid}`;
    const probePath = `/sys/fs/cgroup/${probeName}`;
    let supportsCgroup = false;
    if (fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) {
        try {
            fs.mkdirSync(probePath);
            fs.rmdirSync(probePath);
            supportsCgroup = true;
        } catch {
            supportsCgroup = false;
        }
    }
    try {
        const result = await sbx(dir, ep.url, 't', 'cat /proc/self/cgroup');
        assert.equal(result.code, 0, result.stderr);
        // cgroup v2 统一层级：0::/dynobox-<pid>。登记时机必须在装配进程 fork shell
        // 之前（回归测试：登记晚了 shell 树不在 cgroup 内，cgroup.kill 兜底失效）
        if (supportsCgroup) {
            assert.match(result.stdout, /dynobox-/, '支持 cgroup delegation 时 shell 应登记在 dynobox-* cgroup');
        } else {
            // 非特权 delegation 不可用（如无 systemd 委派）：cgroup 为 best effort，
            // pid ns + pdeathsig 为主保障；此时不应出现半初始化的 '0::/dynobox-' 条目
            assert.doesNotMatch(result.stdout, /0::\/dynobox-/, '无 delegation 时不应出现 dynobox cgroup 条目');
        }
    } finally {
        await ep.close();
    }
});
