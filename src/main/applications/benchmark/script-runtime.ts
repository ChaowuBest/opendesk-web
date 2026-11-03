/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 测评脚本运行时：用系统设置（任务终端设置）中配置的 shell 执行 bash 脚本。
 *
 * 脚本文件只假定 POSIX bash 语义，不写死 bash 路径：按系统设置选出的 shell 组装参数，
 * bash 直接执行；zsh / PowerShell 只当外壳（先加载 ~/.zshrc、PowerShell profile 里的
 * PATH 等交互环境，再把脚本交给 bash），兼顾「终端里有、脚本里没有」的环境差异与
 * 脚本兼容性；连 bash/zsh 都找不到时才显式报错。兼容 Windows 与 OpenHarmony。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import { Setting } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { decodeShellOutput, filterShellEnvironmentWarnings } from '../../utils/shellExec.js';
import { toMsysPath } from '../../../utils/path.js';
import { t } from './locale/index.js';
import { normalizeShellPath } from '../../../common/shells.js';
import { scanSupportedShells, type SupportedShell } from '../terminal/scan.js';
import type { ShellSelection } from '../../../common/shells.js';

export interface ScriptExecutionResult {
    ok: boolean;
    code: number | null;
    error: string;
    /** 失败时脚本 stdout/stderr 合并输出的尾部（已解码）；成功或未执行到脚本时为空 */
    logError: string;
}

/**
 * 脚本执行失败错误：message 为面向用例「错误」栏的一句话摘要，
 * logError 为脚本 stdout/stderr 的合并输出尾部（供「错误信息」栏展示）。
 */
export class ScriptExecutionError extends Error {
    /** 脚本输出尾部（已按 UTF-8/GBK 解码），无输出时为空字符串 */
    readonly logError: string;

    constructor(message: string, logError = '') {
        super(message);
        this.name = 'ScriptExecutionError';
        this.logError = logError;
    }
}

export interface ScriptRunOptions {
    scriptPath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
    timeoutSec: number;
    /** 回传脚本句柄；测评停止链路用它随时终止正在执行的脚本（启动前调用也可） */
    handle?: (script: ScriptHandle) => void;
}

/** 正在运行（或即将启动）的脚本句柄，abort 可安全地重复调用 */
export interface ScriptHandle {
    abort(): void;
    /** 脚本是否已结束（正常退出、超时或被中止后为 true），供调用方清理已失效的句柄 */
    readonly settled?: boolean;
}

/** 展示用输出尾部上限：完整日志已落盘，这里只截取便于在详情面板里阅读的末尾 */
const LOG_TAIL_LIMIT = 8 * 1024;

/** 脚本可直接消费的路径类 BENCH_* 环境变量（其余 BENCH_* 为 ID/计数等标量，不转换） */
const BENCH_PATH_ENV_KEYS = [
    'BENCH_RUN_DIR',
    'BENCH_CASE_DIR',
    'BENCH_WORKSPACE',
    'BENCH_RUN_WORKSPACE',
    'BENCH_VERIFY_WORKSPACE',
    'BENCH_LOG_DIR'
] as const;

/**
 * 构建脚本执行环境。
 *
 * 测评脚本按 POSIX 语义编写（tar/cp/python3 venv 等），Windows 上以 Git Bash
 * 执行时，引擎注入的 `C:\...` 路径会让 MSYS 工具把盘符冒号解析为「远程主机:文件」
 * （如 `tar: Cannot connect to C:`），因此统一转成 MSYS 形式（/c/...）；脚本再调
 * 原生 Windows 程序时由 MSYS 运行时自动转回。
 *
 * PowerShell 选中时同样要转：它只是外壳，脚本最终仍由 bash 执行。
 * 非 Windows 平台原样透传。
 */
export function prepareScriptEnv(shellKind: SupportedShell['kind'], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (process.platform !== 'win32') return env;
    const result: NodeJS.ProcessEnv = { ...env };
    for (const key of BENCH_PATH_ENV_KEYS) {
        const value = result[key];
        if (typeof value === 'string' && value) {
            result[key] = toMsysPath(value);
        }
    }
    return result;
}

/**
 * 读取脚本日志尾部（合并 stdout/stderr 的完整日志），截取末尾用于错误展示。
 * 解码复用 shellExec 的同一套策略（UTF-8，Windows 上出现替换符时回退 GBK）。
 */
export function readScriptLogTail(logPath: string): string {
    try {
        if (!fs.existsSync(logPath)) return '';
        const buffer = fs.readFileSync(logPath);
        if (buffer.length === 0) return '';
        // 截断点必须落在换行符上：直接按字节切 8KB 可能切在三字节汉字的中间，半个字符
        // 会被解码成替换符并误触发 GBK 回退，整段中文变乱码。\n 在 UTF-8 与 GBK 里都只
        // 作为单字节 ASCII 出现，是安全的切分点；找不到换行（单行超长）时才退回字节切分
        const cut = Math.max(0, buffer.length - LOG_TAIL_LIMIT);
        const newline = cut > 0 ? buffer.indexOf(0x0a, cut) : -1;
        const tail = buffer.subarray(newline >= 0 ? newline + 1 : cut);
        // bash -i 无 tty 的 job control 启动警告是启动噪音，不进错误信息展示
        const text = filterShellEnvironmentWarnings(decodeShellOutput(tail));
        // 掐头去尾：去掉脚本执行前写入的 `$ <shell> <path> <script>` 标记行与末尾多余空行
        const lines = text.split('\n');
        const start = lines.findIndex((line) => line.startsWith('$ '));
        const body = (start >= 0 ? lines.slice(start + 1) : lines).join('\n');
        return body.replace(/^\s+|\s+$/g, '');
    } catch (error) {
        logger.warn(
            `[benchmark] failed to read script log ${logPath}: ${error instanceof Error ? error.message : String(error)}`
        );
        return '';
    }
}

/**
 * 从扫描结果里挑「实际执行脚本」的 bash 类外壳：Windows 上 bash（Git Bash）优先，
 * 其余平台 zsh 优先（与任务终端默认一致），沙箱变体一律排除（脚本要继承宿主环境变量）。
 */
function pickBashLikeShell(shells: readonly SupportedShell[]): SupportedShell | null {
    const candidates = shells.filter((shell) => !shell.sandboxed);
    const shellOf = (kind: SupportedShell['kind']) => candidates.find((shell) => shell.kind === kind) ?? null;
    return process.platform === 'win32' ? (shellOf('bash') ?? shellOf('zsh')) : (shellOf('zsh') ?? shellOf('bash'));
}

/**
 * 选脚本要启动的 shell。
 *
 * 选中的 bash/zsh 直接执行；选中的 PowerShell 也原样返回（它先加载自己的 profile，
 * 再启动 bash 跑脚本，见 buildScriptArgs）。用户没显式改过设置（shell_path 为空）
 * 时用平台默认的 bash 类外壳，否则会出现「任务终端是 zsh、准备脚本是 bash」，
 * ~/.zshrc 里的 PATH 在脚本里看不到。
 *
 * 返回 null 只表示「没有任何 shell 可用」；选中 PowerShell 但机器上没有 bash/zsh 时
 * 仍返回 PowerShell，由 runScript 报出「无法执行 bash 脚本」的具体原因。
 */
export function selectScriptShell(
    selection: ShellSelection | null | undefined,
    scanned: readonly SupportedShell[] = scanSupportedShells()
): SupportedShell | null {
    const bashLike = pickBashLikeShell(scanned);
    if (!selection?.shell_path) return bashLike;
    const shells = scanned.filter((shell) => !shell.sandboxed);
    const selected = shells.find(
        (shell) =>
            normalizeShellPath(shell.path, process.platform) ===
            normalizeShellPath(selection.shell_path!, process.platform)
    );
    if (!selected) {
        // 设置里的 shell 与扫描结果对不上时把两边都打出来，便于定位「设置是 zsh 但脚本跑了 bash」
        logger.warn(
            `[benchmark] configured shell ${selection.shell_path} not found; scanned: ` +
                (shells.map((shell) => `${shell.kind}:${shell.path}`).join(', ') || '<none>')
        );
        return bashLike;
    }
    // 按设置的 shell 执行：脚本加载的 rc 文件（~/.bashrc / ~/.zshrc / PowerShell profile）
    // 与任务终端保持一致，PATH 等写在 profile 里的环境不会出现「终端里有、脚本里没有」。
    return selected;
}

/** PowerShell 单引号字符串转义（' → ''），用于把路径安全内联进 -Command */
function powershellQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 组装脚本执行参数。
 *
 * bash 直接以交互模式执行脚本（加载 ~/.bashrc）。
 *
 * zsh / PowerShell 只当外壳：先用它们加载各自的交互环境（~/.zshrc、PowerShell
 * profile 里的 PATH 等），再把脚本交给 bash 执行 —— 用例脚本一律按 bash 语义编写，
 * zsh 的 nomatch、无 word splitting 等差异以及 PowerShell 完全不同的语法都会直接
 * 让脚本失败。zsh 内找不到 bash 时才退回用 zsh 自己执行；PowerShell 外壳要求调用方
 * 给出已解析好的 bash 路径（不能在 PowerShell 里 Get-Command bash，那样可能命中
 * WSL 的 System32\bash.exe，跑进另一个文件系统）。
 */
export function buildScriptArgs(shellKind: SupportedShell['kind'], scriptPath: string, bashPath = 'bash'): string[] {
    if (shellKind === 'powershell') {
        // -Command 之后的参数会被拼进命令行文本，路径必须内联并做单引号转义；
        // bash 起不来时 PowerShell 以非零码退出，$LASTEXITCODE 会透传脚本的退出码。
        // 这里的 bash 不带动交互标志：环境来自 PowerShell profile，脚本本身按 bash 语义跑。
        return ['-Command', `& ${powershellQuote(bashPath)} ${powershellQuote(scriptPath)}; exit $LASTEXITCODE`];
    }
    if (shellKind === 'zsh') {
        const body = 'if command -v bash >/dev/null 2>&1; then exec bash "$1"; else exec zsh "$1"; fi';
        // zsh -c 之后第一个参数是 $0，第二个才是 $1
        return ['-i', '-c', body, 'opendesk-benchmark', scriptPath];
    }
    return ['-i', scriptPath];
}

export async function runScript(options: ScriptRunOptions): Promise<ScriptExecutionResult> {
    const shells = scanSupportedShells();
    const shell = selectScriptShell(Setting.getInstance().getData().task_config, shells);
    if (!shell) {
        return { ok: false, code: null, error: t('error.noScriptShell'), logError: '' };
    }
    // 选中 PowerShell 时需要它启动的 bash：找不到 bash/zsh 就没法按 POSIX 语义跑脚本
    const bashLike = pickBashLikeShell(shells);
    if (!bashLike) {
        return { ok: false, code: null, error: t('error.scriptShellUnsupported', { shell: shell.path }), logError: '' };
    }
    // 外壳要启动的解释器：脚本按 bash 语义编写，优先用真正的 bash（POSIX 上默认外壳可能是 zsh）
    const launcher = shells.find((candidate) => !candidate.sandboxed && candidate.kind === 'bash') ?? bashLike;
    const scriptName = options.scriptPath.replace(/\\/g, '/').split('/').pop() ?? options.scriptPath;
    const scriptArgs = buildScriptArgs(shell.kind, options.scriptPath, launcher.path);
    logger.info(
        `[benchmark] run ${scriptName} via ${shell.kind} ${shell.path} ` +
            `(bash=${launcher.path}, HOME=${options.env.HOME ?? ''}, ZDOTDIR=${options.env.ZDOTDIR ?? ''})`
    );
    return new Promise<ScriptExecutionResult>((resolve) => {
        let output: fs.WriteStream | null = null;
        try {
            output = fs.createWriteStream(options.logPath, { flags: 'a' });
            // 日志目录不可写时 createWriteStream 不会同步抛错，而是后来抛 error 事件；
            // 没有监听器的话这个 error 会变成未捕获异常，把整个 worker 带崩。
            output.on('error', (error) => {
                logger.warn(`[benchmark] failed to write script log ${options.logPath}: ${toLogMessage(error)}`);
                output = null;
            });
            output.write(`\n$ ${shell.kind} ${shell.path} ${scriptName}\n`);
        } catch (error) {
            logger.warn(`[benchmark] failed to open script log ${options.logPath}: ${toLogMessage(error)}`);
            output = null;
        }

        let settled = false;
        let child: ReturnType<typeof spawn> | null = null;

        /** 失败结果统一附上脚本输出尾部（stdout/stderr 已合并写入日志），供「错误信息」栏展示 */
        const finish = (result: ScriptExecutionResult) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            // 超时/中止路径按约定不等子进程真正退出就收尾，但 stdio 管道仍挂在子进程上，
            // 要等 taskkill 杀完才会释放，期间句柄一直存活（jest --detectOpenHandles 会报
            // PIPEWRAP 拖住 worker 退出）。这里已不再需要输出，主动销毁管道句柄。
            if (typeof child?.stdout?.destroy === 'function') child.stdout.destroy();
            if (typeof child?.stderr?.destroy === 'function') child.stderr.destroy();
            const resolveWith = () =>
                resolve(result.ok ? result : { ...result, logError: readScriptLogTail(options.logPath) });
            // 快速脚本可能在本轮事件循环内就 close，同步读会拿到还没刷盘的空日志，
            // 无论成败都先等日志流刷盘再 resolve，保证 resolve 时日志文件完整
            if (!output || output.destroyed) {
                resolveWith();
                return;
            }
            output.end();
            output.once('finish', resolveWith);
            // 磁盘故障等流错误时已有监听记录日志，这里兜底避免 Promise 悬挂；resolve 幂等
            output.once('error', resolveWith);
        };

        let timer: NodeJS.Timeout | null = null;
        timer = setTimeout(
            () => {
                killTree(child);
                finish({
                    ok: false,
                    code: null,
                    error: t('error.scriptTimeout', { seconds: options.timeoutSec }),
                    logError: ''
                });
            },
            Math.max(1, options.timeoutSec) * 1000
        );

        /** 停止请求先于脚本启动到达时，spawn 后立即杀掉，脚本最多活一个 spawn 周期 */
        let abortRequested = false;
        const scriptHandle: ScriptHandle = {
            get settled() {
                return settled;
            },
            abort: () => {
                if (settled) return;
                abortRequested = true;
                killTree(child);
                // Windows 上 taskkill 杀掉进程树后 close 事件不一定触发（stdio 管道句柄
                // 未随进程退出释放），与超时路径一样不等 close，直接按中止结果收尾
                finish({ ok: false, code: null, error: t('error.scriptAborted'), logError: '' });
            }
        };
        options.handle?.(scriptHandle);

        /** 脚本超时被杀掉后仍可能有残留输出，写已 end 的流会抛 write after end */
        const writeChunk = (chunk: Buffer | string) => {
            if (!output || output.writableEnded || output.destroyed) return;
            output.write(chunk);
        };

        try {
            child = spawn(shell.path, scriptArgs, {
                cwd: options.cwd,
                env: prepareScriptEnv(shell.kind, options.env),
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            finish({ ok: false, code: null, error: toLogMessage(error), logError: '' });
            return;
        }
        // 停止请求可能先于 spawn 到达：脚本已无意义，立即终止
        if (abortRequested) {
            killTree(child);
            return;
        }

        child.stdout?.on('data', (chunk: Buffer) => writeChunk(chunk));
        child.stderr?.on('data', (chunk: Buffer) => writeChunk(chunk));
        child.on('error', (error) => finish({ ok: false, code: null, error: toLogMessage(error), logError: '' }));
        child.on('close', (code) => {
            // 超时/中止路径已按结果收尾，这里不能再求值 t(...)：close 可能远晚于收尾到达
            // （Windows 上 taskkill 杀树后管道句柄释放有延迟），此时若已离开调用方上下文
            // （如测试环境 teardown），t() 内部的 locale 动态 import 会抛
            // "You are trying to `import` a file after the Jest environment has been torn down"
            if (settled) return;
            finish({
                ok: code === 0,
                code,
                // 主动中止与脚本自身失败分开报，避免把停止误写成脚本错误
                error:
                    code === 0
                        ? ''
                        : abortRequested
                          ? t('error.scriptAborted')
                          : t('error.scriptExitCode', { code: code ?? '' }),
                logError: ''
            });
        });
    });
}

/** 超时杀掉脚本进程树：Windows 用 taskkill，POSIX（含 detached setsid）杀进程组 */
function killTree(child: ReturnType<typeof spawn> | null): void {
    if (!child || child.pid === undefined) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        try {
            child.kill('SIGKILL');
        } catch {
            /* 进程已退出 */
        }
    }
}

function toLogMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
