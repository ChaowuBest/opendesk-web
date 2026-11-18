import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

// locale/index.ts 在 jest ESM VM 下 createRequire 与内置 require 冲突，mock 掉
jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string) => key
}));

const { prepareDarwinSandbox, prepareShellForSandbox, sandboxExecCacheDir } =
    await import('../../../main/applications/terminal/sandboxes/darwin-sandbox.js');

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

// 与 e2e 相同：独立 exec 缓存目录，避免并行 jest worker 共享用户级缓存时
// 重签 rename 与 spawn 交叉（也使白名单测试的"缓存零新增"断言免受并发污染）。
// 必须在模块加载时设置：describe 收集阶段就会求值 sandboxExecCacheDir()，
// beforeAll 来不及（晚于收集、早于执行，目录常量已固化旧值）。
process.env.OPENDESK_SANDBOX_EXEC_CACHE = path.join(os.tmpdir(), `opendesk-sandbox-exec-cache-${process.pid}`);

const CLANG = '/usr/bin/clang';
const CODESIGN = '/usr/bin/codesign';
const CLT_USR_BIN = '/Library/Developer/CommandLineTools/usr/bin';

function compileProbe(dir: string, name: string, source: string): string {
    const sourcePath = path.join(dir, `${name}.c`);
    fs.writeFileSync(sourcePath, source);
    const binary = path.join(dir, name);
    const sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    execFileSync(CLANG, ['-isysroot', sdk, '-O1', '-o', binary, sourcePath], { stdio: 'pipe' });
    execFileSync(CODESIGN, ['--force', '--sign', '-', binary], { stdio: 'ignore' });
    return binary;
}

/**
 * 异步运行沙箱内命令并收集输出。
 * 必须用异步 spawn：decide 端点运行在同一 jest 进程的事件循环里，
 * spawnSync 会阻塞循环导致 ask 响应回调饿死 → curl/cprobe/spawnSync 三方死锁。
 */
function runSandboxed(
    launch: { file: string; args: string[]; cwd?: string; env?: Record<string, string> },
    file: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    timeoutMs = 30000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const proc = spawn(file, args, {
            cwd: launch.cwd,
            env: { ...process.env, ...launch.env, ...extraEnv }
        });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d) => (stdout += String(d)));
        proc.stderr?.on('data', (d) => (stderr += String(d)));
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`sandbox cmd timeout: ${file} ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
        }, timeoutMs);
        proc.once('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        proc.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

darwinOnly('沙箱内核行为（C 探针真实进程）', () => {
    let root = '';
    let workspace = '';
    let outside = '';
    let trash = '';
    let probe = '';
    let launch: Awaited<ReturnType<typeof prepareDarwinSandbox>> = null;
    /**
     * 非 temp 外部根（HOME 下固定前缀）：统一策略把 POSIX temp 区（/tmp、
     * /private/var/folders 等）读写放行（shell 管道/heredoc/编译器落盘区），
     * 且该区文件删除不入回收站（trash-excluded 内建清单）。因此"工作区外拒绝"
     * 与"删除入回收站"语义必须在非 temp 路径上测——os.tmpdir() 的 mktemp
     * fixture 本身就在 temp 区，外部拒绝/回收站断言会全部反向。
     */
    const outsideRoot = path.join(os.homedir(), '.opendesk-sbx-kernel-outside');
    // exec 缓存目录已在模块加载时重定向（见文件顶部）
    const execCacheDir = sandboxExecCacheDir();
    const execCacheEntries = (): string[] => {
        fs.mkdirSync(execCacheDir, { recursive: true });
        return fs.readdirSync(execCacheDir);
    };
    const sandboxEnv = (): Record<string, string> => ({
        // These cases exercise the CLT shim and its allowlist, independently
        // of whether the user's selected developer directory is a full Xcode.
        DEVELOPER_DIR: path.resolve(CLT_USR_BIN, '../..'),
        OPENDESK_SANDBOX_TRASH_DIR: trash,
        OPENDESK_SANDBOX_TRASH: '1',
        // 沙箱判定日志（dylib slog）：python3/回收站用例失败时从此归因。
        // 放 /tmp（测试清理区外），失败后可直接读取。
        OPENDESK_SANDBOX_LOG: '/tmp/darwin-sbx-debug.log'
    });

    test('setup: 编译探针并启动沙箱', async () => {
        root = path.join(outsideRoot, 'run');
        workspace = path.join(root, 'workspace');
        outside = path.join(outsideRoot, 'outside');
        trash = path.join(outsideRoot, 'trash');
        // 全部 fixture 在非 temp 区（HOME 下）：统一策略把 temp 区写放行且
        // temp 区文件删除不入回收站（trash-excluded），workspace/trash 在
        // temp 区会让"外部拒绝/回收站"断言全部反向。探针编译产物（root）
        // 也在此，保证 cprobe 的执行与读写都在受控非 temp 路径上。
        fs.rmSync(outsideRoot, { recursive: true, force: true });
        for (const dir of [workspace, outside, trash]) fs.mkdirSync(dir, { recursive: true });
        probe = compileProbe(
            root,
            'cprobe',
            `#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

/* 用法: cprobe <mode> [args...] */
int main(int argc, char **argv) {
    if (argc < 2) return 2;
    const char *mode = argv[1];
    if (strcmp(mode, "open") == 0) {
        int flags = strcmp(argv[3], "w") == 0 ? O_WRONLY | O_CREAT | O_TRUNC
                  : strcmp(argv[3], "a") == 0 ? O_WRONLY | O_CREAT | O_APPEND
                  : O_RDONLY;
        int fd = open(argv[2], flags, 0644);
        printf("%d\\n", fd);
        if (fd >= 0) {
            if (flags != O_RDONLY) { write(fd, "x", 1); }
            else { char buf[64]; ssize_t n = read(fd, buf, sizeof(buf) - 1); if (n > 0) buf[n] = 0, printf("read:%s\\n", buf); }
            close(fd);
        } else printf("errno=%d\\n", errno);
        return 0;
    }
    if (strcmp(mode, "dup-write") == 0) {
        /* dup 别名共享文件表项：open ws 文件 → F_DUPFD → 外部打开应拒 → dup 别名写 ws 仍成功 */
        int fd1 = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd1 < 0) { printf("open1-failed\\n"); return 1; }
        int dup_fd = fcntl(fd1, F_DUPFD_CLOEXEC, 10);
        int fd2 = open(argv[3], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        printf("dup_fd=%d open2=%d errno=%d\\n", dup_fd, fd2, fd2 < 0 ? errno : 0);
        if (fd2 >= 0) { write(fd2, "bad", 3); close(fd2); }
        write(dup_fd, "ok", 2);
        close(fd1);
        return 0;
    }
    if (strcmp(mode, "append") == 0) {
        int fd = open(argv[2], O_WRONLY | O_APPEND);
        printf("append_fd=%d errno=%d\\n", fd, fd < 0 ? errno : 0);
        if (fd >= 0) close(fd);
        return 0;
    }
    if (strcmp(mode, "openat-rel") == 0) {
        int fd = openat(AT_FDCWD, argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        printf("openat_fd=%d errno=%d\\n", fd, fd < 0 ? errno : 0);
        if (fd >= 0) close(fd);
        return 0;
    }
    if (strcmp(mode, "exec-enoent") == 0) {
        execvp(argv[2], (char *[]){ (char *)argv[2], NULL });
        printf("errno=%d\\n", errno);
        return 0;
    }
    if (strcmp(mode, "exec") == 0) {
        /* exec <file> [args...]：带完整参数列表 exec（argv[0]=file 惯例） */
        execvp(argv[2], &argv[2]);
        printf("errno=%d\\n", errno);
        return 0;
    }
    return 2;
}
`
        );
        launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', 'true'],
            command: 'setup',
            cwd: workspace,
            deleteToTrash: true
        });
        expect(launch).not.toBeNull();
    }, 60000);

    test('工作区边界文件写放行', async () => {
        const r = await runSandboxed(launch!, probe, ['open', path.join(workspace, 'boundary.txt'), 'w'], sandboxEnv());
        expect(r.stdout).toMatch(/^(\d+)\n/m); // 首行是 fd 数字（成功 ≥3）
        expect(fs.existsSync(path.join(workspace, 'boundary.txt'))).toBe(true);
    });

    test('O_APPEND 打开外部文件被拒绝（追加属写语义）', async () => {
        const target = path.join(outside, 'append-target.txt');
        fs.writeFileSync(target, 'keep');
        const r = await runSandboxed(launch!, probe, ['append', target], sandboxEnv());
        expect(r.stdout).toContain('append_fd=-1');
        expect(r.stdout).toContain('errno=13'); // EACCES
        expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    });

    test('openat(AT_FDCWD, 相对路径) 写外部被拒绝', async () => {
        const r = await runSandboxed(launch!, probe, ['openat-rel', '../outside/openat-escape.txt'], sandboxEnv());
        expect(r.stdout).toContain('openat_fd=-1');
        expect(fs.existsSync(path.join(outside, 'openat-escape.txt'))).toBe(false);
    });

    test('fd 复用: dup 别名写原文件放行，外部打开仍拒绝', async () => {
        const inWs = path.join(workspace, 'dup-target.txt');
        const outsideTarget = path.join(outside, 'dup-outside.txt');
        const r = await runSandboxed(launch!, probe, ['dup-write', inWs, outsideTarget], sandboxEnv());
        expect(r.stdout).toMatch(/open2=-1 errno=13/);
        expect(fs.readFileSync(inWs, 'utf8')).toContain('ok');
        expect(fs.existsSync(outsideTarget)).toBe(false);
    });

    test('exec ENOENT 传播 ENOENT（不是沙箱 EACCES）', async () => {
        const r = await runSandboxed(launch!, probe, ['exec-enoent', 'definitely-not-exist-cmd-xyz'], sandboxEnv());
        expect(r.stdout).toContain('errno=2'); // ENOENT
    });

    test('CLT 编译工具链白名单：原地 exec，不走重签副本', async () => {
        // 白名单内（cc/clang/ld/swift 等编译/链接驱动）从 CLT 路径 exec：
        // strip_dyld_env 豁免 → 二进制不被复制到 exec 缓存，直接原地运行
        //（重签副本对庞大 @rpath 依赖树不稳定，且其写操作由策略另行管控）。
        const before = execCacheEntries();
        const r = await runSandboxed(
            launch!,
            probe,
            ['exec', `${CLT_USR_BIN}/clang`, '--version'],
            sandboxEnv(),
            60000
        );
        expect(r.stdout).toContain('clang version'); // 真的跑起来了
        expect(r.stdout).not.toContain('errno='); // exec 成功替换进程，不会回落到 errno 输出
        // 沙箱内 exec 前后缓存目录零新增：豁免目标不产生重签副本
        const after = execCacheEntries();
        expect(after.filter((n) => !before.includes(n))).toEqual([]);
    }, 60000);

    test('CLT 白名单匹配版本后缀：clang++/gcc 等基名与 clang-N 通配一致放行', async () => {
        // clang++ 同样命中白名单；真实带版本号二进制（clang-NN）CLT 内不存在，
        // 通配匹配由 boxdylib-matching 的 C harness 单测覆盖
        for (const tool of ['clang++', 'gcc', 'ld']) {
            const r = await runSandboxed(
                launch!,
                probe,
                ['exec', `${CLT_USR_BIN}/${tool}`, '--version'],
                sandboxEnv(),
                60000
            );
            expect(r.stdout).not.toContain('errno=');
        }
    }, 120000);

    test('白名单外 CLT 平台二进制（clang-format）走重签副本，仍被注入管控', async () => {
        // clang-format 是 Apple 平台二进制但不在白名单：复制+adhoc 重签后
        // 从缓存 exec，DYLD 注入生效（与白名单的 strip 行为相反路径）。
        // 缓存副本可能被同进程更早的运行预建（重试/超时续跑），故断言
        // "运行后缓存中存在该 basename 的副本"而非"条目数新增"。
        const r = await runSandboxed(
            launch!,
            probe,
            ['exec', `${CLT_USR_BIN}/clang-format`, '--version'],
            sandboxEnv(),
            60000
        );
        expect(r.stdout).toContain('clang-format version');
        expect(r.stdout).not.toContain('errno=');
        const hasCopy = (dir: string): boolean =>
            fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
                const p = path.join(dir, e.name);
                return e.isDirectory() ? hasCopy(p) : e.name === 'clang-format';
            });
        expect(hasCopy(execCacheDir)).toBe(true);
    }, 60000);

    test('lipo 只读子命令白名单放行，变更型子命令拒绝（fail-closed）', async () => {
        const okRead = await runSandboxed(
            launch!,
            probe,
            ['exec', `${CLT_USR_BIN}/lipo`, '-archs', CLANG],
            sandboxEnv(),
            60000
        );
        expect(okRead.stdout).toContain('x86_64'); // lipo -archs 输出包含架构名
        expect(okRead.stdout).not.toContain('errno=');

        const denyWrite = await runSandboxed(
            launch!,
            probe,
            ['exec', `${CLT_USR_BIN}/lipo`, '-create', CLANG, '-output', path.join(workspace, 'fat')],
            sandboxEnv(),
            60000
        );
        expect(denyWrite.stdout).toContain('errno=13'); // EACCES：变更型 lipo 拒绝
        expect(fs.existsSync(path.join(workspace, 'fat'))).toBe(false);
    }, 120000);

    test('xcode-select shim（/usr/bin/lipo）两跳 exec：真实 lipo 命中白名单不被重签', async () => {
        // 回归（BUG lipo SIGABRT）：构建脚本经 /usr/bin/lipo（xcode-select tool-shim）
        // 调用。shim 自身也是平台二进制，旧逻辑将其复制重签后，运行时 shim 会
        // exec CLT 真实 lipo，第二次 exec 再次走重签——副本平铺布局破坏
        // @rpath/libLTO.dylib（LC_RPATH=@executable_path/../lib/）解析，
        // dyld Library not loaded → SIGABRT，npm run build 的
        // build-sandbox:darwin（lipo -archs 校验产物）在沙箱内必炸。
        // 现修复：真实 lipo 命中 CLT 白名单走 strip_dyld_env 豁免，第二跳不再重签；
        // 两跳都必须成功且 stderr 无 dyld 报错。
        const r = await runSandboxed(launch!, probe, ['exec', '/usr/bin/lipo', '-archs', CLANG], sandboxEnv(), 60000);
        expect(r.stdout).toContain('x86_64'); // -archs 正常输出
        expect(r.stdout).not.toContain('errno=');
        expect(r.stderr).not.toContain('dyld');
        expect(r.stderr).not.toContain('Library not loaded');
        expect(r.code).toBe(0);
    }, 60000);

    test('xcode-select tool-shim（/usr/bin/python3）在沙箱内正常工作', async () => {
        // /usr/bin/python3 是 CLT tool-shim：重签副本依赖原 basename 与 CLT 依赖
        // 桥接（目录化布局 + @executable_path 镜像层级 + 依赖符号链接）
        const r = await runSandboxed(
            launch!,
            prepareShellForSandbox('/usr/bin/python3'),
            ['--version'],
            sandboxEnv(),
            60000
        );
        expect(r.stdout).toContain('Python 3.');
    });

    test('python3 写工作区外被拦（PermissionError），写工作区放行', async () => {
        // python3 全链路：shim 副本 → CLT 真工具 → 沙箱管控生效。
        // 逃逸目标必须在非 temp 外部（HOME 下）：temp 区被统一策略写放行。
        const escaped = path.join(outside, 'py-escape.txt');
        const py3 = prepareShellForSandbox('/usr/bin/python3');
        const r1 = await runSandboxed(
            launch!,
            py3,
            ['-c', `open(${JSON.stringify(escaped)}, 'w').write('escape')`],
            sandboxEnv(),
            60000
        );
        // python3 把 EACCES 转为 traceback 输出到 stderr，退出码 1
        expect(r1.code).toBe(1);
        expect(r1.stderr).toContain('PermissionError');
        expect(fs.existsSync(escaped)).toBe(false);
        // 工作区内写正常
        const inWs = path.join(workspace, 'py-ws.txt');
        const r2 = await runSandboxed(
            launch!,
            py3,
            ['-c', `open(${JSON.stringify(inWs)}, 'w').write('in-ws')`],
            sandboxEnv(),
            60000
        );
        expect(r2.code).toBe(0);
        expect(fs.readFileSync(inWs, 'utf8')).toBe('in-ws');
    });

    test('python3 写 temp 区放行（统一策略：POSIX temp 区读写放行）', async () => {
        // temp 区（/tmp、/private/var/folders 等）是 shell 管道/heredoc/编译器的
        // 落盘工作区，policyTextLinux 显式写放行——语义正向固化，防止误收紧
        //（一旦被误改成 ask/deny，jest/npm 等工具链在沙箱内会全面卡死）。
        const py3 = prepareShellForSandbox('/usr/bin/python3');
        const tempTarget = path.join(fs.realpathSync(os.tmpdir()), `sbx-kernel-temp-${process.pid}-${Date.now()}.txt`);
        const r = await runSandboxed(
            launch!,
            py3,
            ['-c', `open(${JSON.stringify(tempTarget)}, 'w').write('temp-ok')`],
            sandboxEnv(),
            60000
        );
        expect(r.code).toBe(0);
        expect(fs.readFileSync(tempTarget, 'utf8')).toBe('temp-ok');
    });

    test('python3 环境下删除预存在文件进回收站', async () => {
        const p = path.join(workspace, 'py-del.txt');
        fs.writeFileSync(p, 'pre-existing-for-py');
        // 用 python3 的 os.unlink 删除（走 python3 进程内的 unlink interpose）
        const r = await runSandboxed(
            launch!,
            prepareShellForSandbox('/usr/bin/python3'),
            ['-c', `import os; os.unlink(${JSON.stringify(p)})`],
            sandboxEnv(),
            60000
        );
        expect(r.code).toBe(0);
        expect(fs.existsSync(p)).toBe(false);
        // 统一回收站协议：<uuid>.back（随机 UUID 防同名覆盖 TOCTOU），
        // original_path 记录在 summary.json 供宿主 GUI 找回
        const trashed = fs.readdirSync(trash).find((n) => n.endsWith('.back'));
        expect(trashed).toBeTruthy();
        const summary = JSON.parse(fs.readFileSync(path.join(trash, 'summary.json'), 'utf8'));
        expect(summary.some((e: { original_path: string }) => e.original_path.includes('py-del.txt'))).toBe(true);
    });

    test('CLT 真实工具（shim exec 的目标）进程脱离 dylib 管控是已知边界，但 shim 本身可用', async () => {
        // 通过 shim 再执行一层脚本验证：python3 -c 传代码
        const r = await runSandboxed(
            launch!,
            prepareShellForSandbox('/usr/bin/python3'),
            ['-c', 'import sys; print("py-inline-ok")'],
            sandboxEnv(),
            60000
        );
        expect(r.stdout).toContain('py-inline-ok');
    });

    test('回收站: 同名文件删除两次产生两个独立副本（UUID 命名防覆盖）', async () => {
        for (const content of ['first', 'second']) {
            const p = path.join(workspace, 'same-name.txt');
            fs.writeFileSync(p, content);
            const r = await runSandboxed(
                launch!,
                prepareShellForSandbox('/bin/rm'),
                ['same-name.txt'],
                sandboxEnv(),
                60000
            );
            expect(r.code).toBe(0);
        }
        // 统一回收站协议：<uuid>.back（随机 UUID，防同名覆盖 TOCTOU），内容均可找回
        const summary = JSON.parse(fs.readFileSync(path.join(trash, 'summary.json'), 'utf8'));
        const entries = summary.filter((e: { original_path: string }) => e.original_path.includes('same-name.txt'));
        expect(entries).toHaveLength(2);
        const contents = entries
            .map((e: { uuid: string }) => fs.readFileSync(path.join(trash, `${e.uuid}.back`), 'utf8'))
            .sort();
        expect(contents).toEqual(['first', 'second']);
    }, 120000);

    test('实例内新建文件删除直接清除（不进废纸篓）', async () => {
        // 用沙箱内进程创建+删除：文件出生时间晚于该沙箱实例启动 → 属"实例内新建"，
        // 删除应直接清除而非送废纸篓（测试进程预先写的文件属"预存在"，会进废纸篓）
        const creator = compileProbe(
            root,
            'creator',
            `#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
int main(void) {
    int fd = open("fresh-created.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { perror("create"); return 1; }
    write(fd, "born-in-sandbox", 15);
    close(fd);
    /* 同进程内删除：出生时间 > 本进程沙箱启动 → 应直清不进废纸篓 */
    int rc = unlink("fresh-created.txt");
    printf("unlink rc=%d errno=%s\\n", rc, rc != 0 ? strerror(errno) : "ok");
    return rc != 0;
}
`
        );
        const r = await runSandboxed(launch!, creator, [], sandboxEnv(), 30000);
        expect(r.stdout).toContain('unlink rc=0');
        expect(r.code).toBe(0);
        expect(fs.existsSync(path.join(workspace, 'fresh-created.txt'))).toBe(false);
        const trashed = fs.readdirSync(trash).filter((n) => n.startsWith('fresh-created'));
        expect(trashed).toEqual([]);
    });

    test('清理', async () => {
        await launch!.cleanup();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }, 60000);
});
