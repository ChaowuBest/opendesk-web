import { jest } from '@jest/globals';

/** 终端设置里的 shell 选择：默认空（未设置），个别用例按需覆盖 */
let taskConfig: Record<string, unknown> = {};
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: class {
        static getInstance() {
            return { getData: () => ({ task_config: taskConfig }) };
        }
    },
    getOpendeskDirectory: () => 'C:/opendesk-test',
    getLogDirectory: () => 'C:/opendesk-test/logs'
}));

const scanShells = jest.fn();
jest.unstable_mockModule('../../../main/applications/terminal/scan.js', () => ({
    scanSupportedShells: scanShells,
    scanShells,
    getSupportedShells: scanShells
}));

const { selectScriptShell, buildScriptArgs, readScriptLogTail, runScript, ScriptExecutionError, prepareScriptEnv } =
    await import('../../../main/applications/benchmark/script-runtime.js');
type SupportedShell = { kind: 'powershell' | 'bash' | 'zsh'; path: string; sandboxed: boolean };

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeLocale } from '../../../locale/index.js';

/**
 * 真实执行脚本用的环境：把 HOME 指向用例目录下的空 home，跳过 bash -i 加载用户 ~/.bashrc。
 * rc 加载实测约 480ms（rc 重的机器更久），全量并发（近 600 个 suite 抢 CPU）时足以把脚本的
 * 首次输出推到超时之后，让「超时也携带已捕获输出」这类用例必空；隔离后 bash 启动降到 ~150ms，
 * -i 交互语义（含 `$-` 里的 i 标志）不受影响。
 */
function scriptEnv(directory: string): NodeJS.ProcessEnv {
    const home = path.join(directory, 'home');
    fs.mkdirSync(home, { recursive: true });
    return { ...process.env, HOME: home };
}

beforeEach(() => {
    scanShells.mockReset();
    taskConfig = {};
    setRuntimeLocale('zh-CN');
});

afterEach(() => {
    setRuntimeLocale(null);
});

describe('selectScriptShell', () => {
    const makeShell = (kind: SupportedShell['kind'], sandboxed = false): SupportedShell => ({
        kind,
        path: `C:/shells/${kind}.exe`,
        sandboxed
    });

    test('优先选设置里保存的 bash，且过滤掉沙箱变体（脚本以宿主权限直跑）', () => {
        const saved = makeShell('bash');
        scanShells.mockReturnValue([
            makeShell('powershell'),
            makeShell('powershell', true),
            saved,
            makeShell('bash', true),
            makeShell('zsh')
        ]);
        expect(selectScriptShell({ shell_path: 'C:/shells/bash.exe' })).toBe(saved);
        expect(scanShells).toHaveBeenCalledTimes(1);
    });

    test('设置选了别的 shell（如 cmd 已消失、只剩 bash 类）时回退到非沙箱 bash', () => {
        scanShells.mockReturnValue([makeShell('powershell'), makeShell('bash')]);
        expect(selectScriptShell({ shell_path: 'C:/gone/cmd.exe' })).toEqual(makeShell('bash'));
    });

    test('设置选了 zsh 时就用 zsh：脚本的 rc 文件与任务终端保持一致（~/.zshrc 才会被加载）', () => {
        scanShells.mockReturnValue([makeShell('powershell'), makeShell('zsh'), makeShell('bash')]);
        expect(selectScriptShell({ shell_path: 'C:/shells/zsh.exe' })).toEqual(makeShell('zsh'));
    });

    test('设置选了 PowerShell 时返回它当外壳（先加载 profile，再启动 bash 跑脚本）', () => {
        scanShells.mockReturnValue([makeShell('powershell'), makeShell('bash')]);
        expect(selectScriptShell({ shell_path: 'C:/shells/powershell.exe' })).toEqual(makeShell('powershell'));
    });

    test('只有 PowerShell、没有 bash/zsh：未设置时无 shell 可用，选中 PowerShell 时原样返回以便报错', () => {
        scanShells.mockReturnValue([makeShell('powershell')]);
        expect(selectScriptShell({})).toBeNull();
        expect(selectScriptShell({ shell_path: 'C:/shells/powershell.exe' })).toEqual(makeShell('powershell'));
    });

    test('设置里的 shell 已不可用时回退到 bash 类 shell', () => {
        scanShells.mockReturnValue([makeShell('powershell'), makeShell('zsh')]);
        expect(selectScriptShell({ shell_path: 'C:/gone/zsh.exe' })).toEqual(makeShell('zsh'));

        scanShells.mockReturnValue([makeShell('powershell'), makeShell('zsh'), makeShell('bash')]);
        // 回退目标是平台默认的 bash 类外壳：Windows 优先 bash（Git Bash），其余平台优先 zsh
        expect(selectScriptShell({ shell_path: 'C:/gone/zsh.exe' })).toEqual(
            process.platform === 'win32' ? makeShell('bash') : makeShell('zsh')
        );
    });

    test('没有任何可用 shell 时返回 null', () => {
        scanShells.mockReturnValue([]);
        expect(selectScriptShell({})).toBeNull();
    });

    test('没有 bash 时可选 zsh，powershell 被排除', () => {
        scanShells.mockReturnValue([makeShell('powershell'), makeShell('zsh')]);
        expect(selectScriptShell({})).toEqual(makeShell('zsh'));
        expect(selectScriptShell(null)).toEqual(makeShell('zsh'));
    });

    test('未设置 shell 时按平台默认：POSIX 优先 zsh（与任务终端一致），Windows 优先 bash', () => {
        scanShells.mockReturnValue([makeShell('powershell'), makeShell('zsh'), makeShell('bash')]);
        const originalPlatform = process.platform;
        try {
            Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
            expect(selectScriptShell({})).toEqual(makeShell('zsh'));
            expect(selectScriptShell(null)).toEqual(makeShell('zsh'));

            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            expect(selectScriptShell({})).toEqual(makeShell('bash'));
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        }
    });
});

describe('buildScriptArgs', () => {
    const scriptPath = '/tmp/case/run-prepare.sh';

    test('bash：直接以交互模式执行脚本', () => {
        expect(buildScriptArgs('bash', scriptPath)).toEqual(['-i', scriptPath]);
    });

    test('zsh：先加载 ~/.zshrc，再 exec bash 执行脚本', () => {
        const args = buildScriptArgs('zsh', scriptPath);
        expect(args.slice(0, 2)).toEqual(['-i', '-c']);
        expect(args[2]).toContain('exec bash "$1"');
        // zsh 内找不到 bash 时退回 zsh 自己执行，避免直接失败
        expect(args[2]).toContain('exec zsh "$1"');
        // zsh -c 后第一个参数是 $0，脚本路径必须落在 $1
        expect(args.slice(3)).toEqual(['opendesk-benchmark', scriptPath]);
    });

    test('powershell：用 -Command 启动已解析好的 bash，并透传退出码', () => {
        const args = buildScriptArgs('powershell', scriptPath, 'C:\\Program Files\\Git\\bin\\bash.exe');
        expect(args[0]).toBe('-Command');
        // PowerShell 的 -Command 会把后续参数拼进命令行，所以路径必须内联并加单引号
        expect(args).toHaveLength(2);
        expect(args[1]).toContain(`& 'C:\\Program Files\\Git\\bin\\bash.exe'`);
        expect(args[1]).toContain(`'${scriptPath}'`);
        expect(args[1]).toContain('exit $LASTEXITCODE');
    });

    test('powershell：路径里的单引号按 PowerShell 规则转义', () => {
        const args = buildScriptArgs('powershell', "/tmp/it's here/run.sh", '/usr/bin/bash');
        expect(args[1]).toContain(`'/tmp/it''s here/run.sh'`);
    });
});

describe('readScriptLogTail', () => {
    test('日志标记行按实际 shell 记录，并在错误信息里被掐掉', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tail-'));
        const logPath = path.join(dir, 'run.log');
        fs.writeFileSync(logPath, '\n$ zsh /usr/bin/zsh run-prepare.sh\nPATH_HEAD=/x\nboom\n');

        const tail = readScriptLogTail(logPath);
        expect(tail).not.toContain('run-prepare.sh');
        expect(tail).toBe('PATH_HEAD=/x\nboom');
    });
});

/**
 * 真实执行链路的轻集成测试：跑一个输出 BENCH_SCRIPT_OK 的临时脚本。
 * 在装有 bash（或 zsh）的 CI / 本机环境均可运行；两者都没有时跳过。
 */
describe('runScript integration', () => {
    const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    const zshPath = process.platform === 'win32' ? null : '/bin/zsh';
    const shellPath = [bashPath, zshPath].find((p) => p !== null && fs.existsSync(p));
    const maybe = shellPath ? it : it.skip;

    maybe('用真实 bash 执行脚本并写入日志', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo BENCH_SCRIPT_OK\n');
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: shellPath, sandboxed: false }]);
        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 30 });

        expect(result).toMatchObject({ ok: true, code: 0 });
        expect(fs.readFileSync(logPath, 'utf8')).toContain('BENCH_SCRIPT_OK');
    });

    maybe('脚本超时会被杀掉并返回失败摘要与已捕获输出', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'sleep 5\n');
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: shellPath, sandboxed: false }]);
        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 1 });

        expect(result.ok).toBe(false);
        expect(result.code).toBeNull();
        expect(result.error).toContain('未结束');
        // runScript 超时即 resolve，不等子进程退出；等 taskkill 杀树与管道收尾，避免 jest worker 强退告警
        await new Promise((resolve) => setTimeout(resolve, 500));
    });

    maybe('脚本非零退出时结果携带 stdout/stderr 合并输出', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo out-line; echo err-line >&2; exit 3\n');
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: shellPath, sandboxed: false }]);
        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 30 });

        expect(result).toMatchObject({ ok: false, code: 3, error: '退出码 3' });
        expect(result.logError).toContain('out-line');
        expect(result.logError).toContain('err-line');
        expect(result.logError).not.toContain('$ bash');
    });
});

describe('失败结果携带脚本输出（logError）', () => {
    // 真实 bash 执行链路，全量并发跑时易受 CPU 饥饿影响触发默认 5s 超时（单跑/目录跑均稳过）。
    jest.setTimeout(30000);

    const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    const zshPath = process.platform === 'win32' ? null : '/bin/zsh';
    const shellPath = [bashPath, zshPath].find((p) => p !== null && fs.existsSync(p));
    const maybe = shellPath ? it : it.skip;

    maybe('非零退出时 logError 包含 stdout 与 stderr', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo out-line; echo err-line >&2; exit 3\n');
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: shellPath, sandboxed: false }]);
        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 30 });

        expect(result.ok).toBe(false);
        expect(result.logError).toContain('out-line');
        expect(result.logError).toContain('err-line');
        expect(result.logError).not.toContain('$ bash');
    });

    maybe('超时失败时同样携带已捕获的脚本输出', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        // 输出后长睡，让 3s 超时在 echo 之后触发（bash 启动开销由 scriptEnv 隔离掉，
        // 否则 rc 加载 + 并发饥饿会让 echo 还没执行就被杀，日志必空）
        fs.writeFileSync(scriptPath, 'echo partial-out; sleep 30\n');
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: shellPath, sandboxed: false }]);
        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 3 });

        expect(result.ok).toBe(false);
        expect(result.logError).toContain('partial-out');
        // runScript 超时即 resolve，不等子进程退出；等 taskkill 杀树与管道收尾，避免 jest worker 强退告警
        await new Promise((resolve) => setTimeout(resolve, 500));
    });

    maybe('成功路径 logError 为空', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo ok\n');
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: shellPath, sandboxed: false }]);
        await expect(
            runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 30 })
        ).resolves.toMatchObject({ ok: true, code: 0, logError: '' });
    });
});

describe('prepareScriptEnv 跨平台路径处理', () => {
    // afterEach 需要恢复真实平台：process.platform 可能已被用例覆盖，恢复值必须在覆盖前捕获
    const realPlatform = process.platform;

    function setPlatform(platform: string): void {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }

    afterEach(() => {
        setPlatform(realPlatform);
    });

    test('Windows + bash：路径类 BENCH_* 转 MSYS 形式，非路径变量与用户变量不动', () => {
        setPlatform('win32');
        const env = prepareScriptEnv('bash', {
            PATH: 'C:\\Windows\\system32',
            BENCH_RUN_ID: 'run-1',
            BENCH_CONCURRENCY: '2',
            BENCH_CASE_DIR: 'C:\\Users\\liyif\\datasets\\case',
            BENCH_WORKSPACE: 'C:/Users/liyif/runs/r1/run-workspace',
            BENCH_PHASE: 'run-prepare'
        });
        expect(env.BENCH_CASE_DIR).toBe('/c/Users/liyif/datasets/case');
        expect(env.BENCH_WORKSPACE).toBe('/c/Users/liyif/runs/r1/run-workspace');
        expect(env.BENCH_RUN_ID).toBe('run-1');
        expect(env.BENCH_CONCURRENCY).toBe('2');
        expect(env.BENCH_PHASE).toBe('run-prepare');
        expect(env.PATH).toBe('C:\\Windows\\system32');
    });

    test('Windows + powershell：同样转 MSYS 形式（它只是外壳，脚本最终由 bash 执行）', () => {
        setPlatform('win32');
        const env = prepareScriptEnv('powershell', { BENCH_CASE_DIR: 'C:\\data' });
        expect(env.BENCH_CASE_DIR).toBe('/c/data');
    });

    test('macOS/Linux/鸿蒙：原样返回，不影响 POSIX 路径', () => {
        setPlatform('linux');
        const env = prepareScriptEnv('bash', {
            BENCH_CASE_DIR: '/data/service/hnp/bin',
            BENCH_WORKSPACE: '/storage/Users/currentUser/ws'
        });
        expect(env.BENCH_CASE_DIR).toBe('/data/service/hnp/bin');
        expect(env.BENCH_WORKSPACE).toBe('/storage/Users/currentUser/ws');
    });
});

describe('Windows Git Bash 真实脚本复现（tar 盘符问题）', () => {
    // 真实 tar/cp 链路 + 全量并发负载，默认 5s 不够稳（单跑 ~1s 通过）。
    jest.setTimeout(30000);

    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const maybe = process.platform === 'win32' && fs.existsSync(bashPath) ? it : it.skip;

    maybe('MSYS 形式的 BENCH_* 路径让 tar/cp 正常工作', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-msys-'));
        const caseDir = path.join(dir, 'case');
        const workspace = path.join(dir, 'workspace');
        fs.mkdirSync(path.join(caseDir, 'assets'), { recursive: true });
        fs.mkdirSync(workspace, { recursive: true });
        // 用 Git Bash 自带的 tar 打一个真实 tar.gz，复现「Cannot connect to C:」场景
        const tarExe = 'C:\\Program Files\\Git\\usr\\bin\\tar.exe';
        fs.writeFileSync(path.join(caseDir, 'assets', 'hello.txt'), 'workspace-file');
        const { execFileSync } = await import('node:child_process');
        // 准备步骤本身也避开盘符冒号（tar 会把 C: 当远程主机），用 cwd + 相对路径
        execFileSync(tarExe, ['-czf', 'assets/workspace.tar.gz', 'assets/hello.txt'], {
            cwd: caseDir,
            stdio: 'ignore'
        });

        const scriptPath = path.join(caseDir, 'prepare.sh');
        fs.writeFileSync(
            scriptPath,
            [
                'set -euo pipefail',
                'mkdir -p "$BENCH_WORKSPACE"',
                'tar -xzf "$BENCH_CASE_DIR/assets/workspace.tar.gz" -C "$BENCH_WORKSPACE"',
                'cp "$BENCH_CASE_DIR/assets/hello.txt" "$BENCH_WORKSPACE/copied.txt"',
                'cat "$BENCH_WORKSPACE/copied.txt"'
            ].join('\n')
        );
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: bashPath, sandboxed: false }]);
        const result = await runScript({
            scriptPath,
            cwd: caseDir,
            env: prepareScriptEnv('bash', {
                ...scriptEnv(dir),
                BENCH_CASE_DIR: caseDir,
                BENCH_WORKSPACE: workspace
            }),
            logPath,
            timeoutSec: 60
        });

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(path.join(workspace, 'copied.txt'), 'utf8')).toContain('workspace-file');
    });
});

describe('runScript 交互模式真实执行（-i）', () => {
    const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    const maybe = fs.existsSync(bashPath) ? it : it.skip;

    maybe('脚本内 $- 含 i 标志，job control 启动警告不进错误信息', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-i-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        // logError 仅在失败路径填充：输出标志后以非零码退出，让标志出现在错误信息里
        fs.writeFileSync(
            scriptPath,
            'case $- in *i*) echo FLAG-INTERACTIVE ;; *) echo FLAG-NON-INTERACTIVE ;; esac\nexit 7\n'
        );
        const logPath = path.join(dir, 'run.log');

        scanShells.mockReturnValue([{ kind: 'bash', path: bashPath, sandboxed: false }]);
        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 60 });

        expect(result.ok).toBe(false);
        expect(result.logError).toContain('FLAG-INTERACTIVE');
        // bash -i 在无 tty 下的启动警告是噪音，不应污染错误信息展示
        expect(result.logError).not.toContain('cannot set terminal process group');
        expect(result.logError).not.toContain('no job control');
    });
});

/**
 * 选中 PowerShell 时它只当外壳：先加载 profile，再启动 bash 执行脚本。
 * 这里跑真实链路，确认脚本真的跑在 bash 里、退出码与输出都能透传。
 */
describe('PowerShell 外壳启动 bash（真实执行）', () => {
    jest.setTimeout(60000);
    const psPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const maybe = process.platform === 'win32' && fs.existsSync(psPath) && fs.existsSync(bashPath) ? it : it.skip;

    maybe('脚本跑在 bash 里：bash 语法可用，退出码与输出原样透传', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ps-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        // ${BASH_VERSION} 只有在 bash 里才有值；PowerShell 直接执行这个脚本会直接报错
        fs.writeFileSync(scriptPath, 'echo "BASH-VERSION=${BASH_VERSION:-none}"\necho "SCRIPT-PATH=$0"\nexit 5\n');
        const logPath = path.join(dir, 'run.log');

        taskConfig = { shell_path: psPath };
        scanShells.mockReturnValue([
            { kind: 'powershell', path: psPath, sandboxed: false },
            { kind: 'bash', path: bashPath, sandboxed: false }
        ]);

        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 60 });

        expect(result.ok).toBe(false);
        expect(result.code).toBe(5);
        expect(result.logError).toContain('BASH-VERSION=');
        expect(result.logError).not.toContain('BASH-VERSION=none');
        expect(result.logError).toContain('SCRIPT-PATH=');
    });

    maybe('选中 PowerShell 但机器上没有 bash：直接报「无法执行 bash 脚本」，不静默失败', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ps-'));
        const scriptPath = path.join(dir, 'prepare.sh');
        fs.writeFileSync(scriptPath, 'echo SHOULD-NOT-RUN\n');
        const logPath = path.join(dir, 'run.log');

        taskConfig = { shell_path: psPath };
        scanShells.mockReturnValue([{ kind: 'powershell', path: psPath, sandboxed: false }]);

        const result = await runScript({ scriptPath, cwd: dir, env: scriptEnv(dir), logPath, timeoutSec: 60 });

        expect(result.ok).toBe(false);
        expect(result.code).toBeNull();
        expect(result.error).toContain('bash');
        expect(fs.existsSync(logPath)).toBe(false);
    });
});

describe('readScriptLogTail 编码回退', () => {
    // GBK 回退只在 Windows 生效（与 shellExec 的 decodeShellOutput 策略一致）：
    // 其它平台的日志一律是 UTF-8，硬套 GBK 只会把正常中文解成乱码
    const maybeWindows = process.platform === 'win32' ? test : test.skip;

    maybeWindows('GBK 字节按 GBK 解码，不产生乱码替换符', async () => {
        const { readScriptLogTail } = await import('../../../main/applications/benchmark/script-runtime.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const logPath = path.join(dir, 'run.log');
        // "准备脚本失败" 是真实故障输出中的典型中文
        const gbk = (await import('iconv-lite')).default.encode('准备脚本失败\n第二行\n', 'gbk');
        fs.writeFileSync(logPath, gbk);

        const text = readScriptLogTail(logPath);
        expect(text).toContain('准备脚本失败');
        expect(text).not.toContain('\uFFFD');
    });

    test('UTF-8 内容原样解码', async () => {
        const { readScriptLogTail } = await import('../../../main/applications/benchmark/script-runtime.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runtime-'));
        const logPath = path.join(dir, 'run.log');
        fs.writeFileSync(logPath, 'line1\nline2 中文\n', 'utf8');

        expect(readScriptLogTail(logPath)).toContain('line2 中文');
    });

    test('日志文件不存在时返回空字符串', async () => {
        const { readScriptLogTail } = await import('../../../main/applications/benchmark/script-runtime.js');
        expect(readScriptLogTail('Z:/nonexistent/dir/run.log')).toBe('');
    });
});

describe('readScriptLogTail 大日志截断', () => {
    test('截断点落在换行上：8KB 边界不切断多字节字符，中文尾部不乱码', async () => {
        const { readScriptLogTail } = await import('../../../main/applications/benchmark/script-runtime.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tail-big-'));
        const logPath = path.join(dir, 'run.log');
        // 造一份远超 8KB 的中文日志：按字节切 8KB 必然落在某个三字节汉字的中间
        const line = '准备脚本失败：无法连接远端主机，请检查网络与代理配置';
        let text = '$ bash C:/tools/bash.exe run-prepare.sh\n';
        while (Buffer.byteLength(text, 'utf8') < 20000) text += `${line}\n`;
        text += 'LAST-LINE-中文尾部\n';
        fs.writeFileSync(logPath, text, 'utf8');

        const tail = readScriptLogTail(logPath);
        expect(tail).not.toContain('\uFFFD');
        expect(tail).toContain('LAST-LINE-中文尾部');
        expect(tail).toContain('准备脚本失败');
        // 半个汉字会让 UTF-8 解码失败并误回退 GBK，整段变「锟斤拷」式乱码
        expect(tail).not.toContain('锟');
        // 截断后只保留尾部：完整日志有 20KB+，这里应显著更短
        expect(Buffer.byteLength(tail, 'utf8')).toBeLessThan(9000);
    });
});

describe('runScript 句柄中止（停止链路）', () => {
    const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    const maybe = fs.existsSync(bashPath) ? it : it.skip;

    maybe(
        '脚本执行中 abort 会终止脚本并以失败结果收尾',
        async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-abort-'));
            const scriptPath = path.join(dir, 'prepare.sh');
            fs.writeFileSync(scriptPath, 'echo before-abort; sleep 30\n');
            const logPath = path.join(dir, 'run.log');

            scanShells.mockReturnValue([{ kind: 'bash', path: bashPath, sandboxed: false }]);
            let scriptHandle: { abort(): void } | null = null;
            const pending = runScript({
                scriptPath,
                cwd: dir,
                env: scriptEnv(dir),
                logPath,
                timeoutSec: 60,
                handle: (script) => (scriptHandle = script)
            });
            // 等 handle 回调（runScript 在 spawn 前同步回调，但 Promise 构造体已在执行）
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(scriptHandle).not.toBeNull();
            scriptHandle!.abort();

            const result = await pending;
            expect(result.ok).toBe(false);
            expect(result.error).toContain('终止');
            // runScript abort 即 resolve，不等子进程退出；等 taskkill 杀树与管道收尾，避免 jest worker 强退告警
            await new Promise((resolve) => setTimeout(resolve, 500));
        },
        15000
    );

    maybe(
        '重复 abort 幂等，不抛异常',
        async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-abort2-'));
            const scriptPath = path.join(dir, 'prepare.sh');
            fs.writeFileSync(scriptPath, 'sleep 30\n');
            const logPath = path.join(dir, 'run.log');

            scanShells.mockReturnValue([{ kind: 'bash', path: bashPath, sandboxed: false }]);
            let scriptHandle: { abort(): void } | null = null;
            const pending = runScript({
                scriptPath,
                cwd: dir,
                env: scriptEnv(dir),
                logPath,
                timeoutSec: 60,
                handle: (script) => (scriptHandle = script)
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(() => {
                scriptHandle!.abort();
                scriptHandle!.abort();
            }).not.toThrow();

            const result = await pending;
            expect(result.ok).toBe(false);
            await new Promise((resolve) => setTimeout(resolve, 500));
        },
        15000
    );
});
