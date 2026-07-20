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
 * 跨平台 shell 命令执行模块。
 *
 * 在不同平台上自动检测可用的 shell（powershell / zsh / bash），
 * 通过 spawn 执行命令，避免直接依赖 child_process.exec / execSync，
 * 从而兼容 OpenHarmony 等受限平台。
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { Setting } from './setting.js';
import { getPlatform } from '../../platforms/base.js';

// ── 可执行文件查找 ──────────────────────────────────────────────────────────

/**
 * 通过 PATH 环境变量及平台备选路径查找可执行文件。
 * 支持跨平台：Windows、macOS、Linux、OpenHarmony。
 */
export function findExecutableInPath(executable: string): string | null {
    const isWindows = process.platform === 'win32';
    const pathSeparator = isWindows ? ';' : ':';
    const pathEnv = process.env.PATH || '';
    const searchDirs: string[] = pathEnv.split(pathSeparator).filter(Boolean);

    if (isWindows) {
        // Windows 系统工具可能不在 PATH 中（如精简版 / Server Core / 32位进程在64位系统上的重定向等），
        // 补充已知的默认安装位置作为 fallback
        const sysRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
        searchDirs.push(
            `${sysRoot}\\System32`,
            `${sysRoot}\\System32\\WindowsPowerShell\\v1.0`,
            `${sysRoot}\\SysWOW64\\WindowsPowerShell\\v1.0`,
            `${sysRoot}\\Sysnative\\WindowsPowerShell\\v1.0`
        );
    } else {
        searchDirs.push('/bin', '/usr/bin', '/usr/local/bin');
        // OpenHarmony DevBox 的 hnp 专有路径
        if ((process.platform as string) === 'openharmony' || process.env.OHOS_SDK_HOME != null) {
            searchDirs.push('/data/service/hnp/bin');
        }
    }

    const executableNames = isWindows
        ? [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`]
        : [executable];

    for (const dir of searchDirs) {
        for (const name of executableNames) {
            const fullPath = path.join(dir, name);
            try {
                if (!fs.existsSync(fullPath)) continue;
                if (isWindows) return fullPath;
                fs.accessSync(fullPath, fs.constants.X_OK);
                return fullPath;
            } catch {
                continue;
            }
        }
    }
    return null;
}

export function hasZsh(): boolean {
    return findExecutableInPath('zsh') !== null;
}

/**
 * 解析 OpenHarmony 上首选的 bash 路径。
 *
 * /bin/zsh 在 OpenHarmony PC 上可能存在但运行时报 "Error relocating /bin/zsh"，
 * 因此优先使用 DevBox HNP 提供的 bash，再回退到 PATH 中查找到的 bash。
 *
 * 注意：仅靠 fs.accessSync 无法保证文件能被 spawn 执行（例如 HNP 文件系统
 * 在主进程可见但子进程命名空间中不可见、或依赖的 .so 缺失等场景），
 * 因此 accessSync 通过后再用 spawnSync 做一次轻量执行验证。
 */
export function findOpenHarmonyBash(): string | null {
    const hnpBash = '/data/service/hnp/bin/bash';
    try {
        fs.accessSync(hnpBash, fs.constants.X_OK);
        // 实际执行验证，确保 spawn 可用
        const verify = spawnSync(hnpBash, ['-c', 'true'], { timeout: 5000 });
        if (verify.status === 0 && !verify.error) {
            return hnpBash;
        }
    } catch {
        // HNP bash 不可用，回退到 PATH 查找
    }
    return findExecutableInPath('bash');
}

// ── 默认 shell 检测 ────────────────────────────────────────────────────────

export interface ShellInfo {
    shellPath: string;
    shellArgs: string[];
}

let _cachedDefaultShell: ShellInfo | undefined;

/**
 * 清除默认 shell 缓存，下次 getDefaultShell() 调用会重新探测。
 *
 * 用于 spawn 失败（如 ENOENT）后让下次调用拿到最新的 shell 路径，
 * 避免 HNP 文件系统未就绪时缓存了无效路径。
 */
export function clearDefaultShellCache(): void {
    _cachedDefaultShell = undefined;
}

/**
 * 获取当前平台的默认 shell。
 *
 * 策略：
 * - Windows: powershell 优先，回退到 bash
 * - 非 Windows: zsh 优先，回退到 bash
 */
export function getDefaultShell(): ShellInfo {
    if (_cachedDefaultShell) return _cachedDefaultShell;

    const isWindows = process.platform === 'win32';

    if (isWindows) {
        // 先查 powershell（Windows PowerShell 5.1），再查 pwsh（PowerShell 7+）
        const psPath = findExecutableInPath('powershell') || findExecutableInPath('pwsh');
        if (psPath) {
            _cachedDefaultShell = { shellPath: psPath, shellArgs: ['-NoProfile', '-Command'] };
            return _cachedDefaultShell;
        }
        const bashPath = findExecutableInPath('bash');
        if (bashPath) {
            _cachedDefaultShell = { shellPath: bashPath, shellArgs: ['-c'] };
            return _cachedDefaultShell;
        }
        _cachedDefaultShell = { shellPath: 'powershell.exe', shellArgs: ['-NoProfile', '-Command'] };
    } else if ((process.platform as string) === 'openharmony') {
        // 优先 HNP bash，避免 OpenHarmony 上 zsh 运行时报 "Error relocating"；
        // 无可用 bash 时回退到 zsh，最后兜底 /bin/sh
        const bashPath = findOpenHarmonyBash();
        if (bashPath) {
            _cachedDefaultShell = { shellPath: bashPath, shellArgs: ['-c'] };
        } else {
            const zshPath = findExecutableInPath('zsh');
            _cachedDefaultShell = zshPath
                ? { shellPath: zshPath, shellArgs: ['-c'] }
                : { shellPath: '/bin/sh', shellArgs: ['-c'] };
        }
    } else {
        const zshPath = findExecutableInPath('zsh');
        if (zshPath) {
            _cachedDefaultShell = { shellPath: zshPath, shellArgs: ['-c'] };
            return _cachedDefaultShell;
        }
        const bashPath = findExecutableInPath('bash');
        if (bashPath) {
            _cachedDefaultShell = { shellPath: bashPath, shellArgs: ['-c'] };
            return _cachedDefaultShell;
        }
        _cachedDefaultShell = { shellPath: '/bin/sh', shellArgs: ['-c'] };
    }

    return _cachedDefaultShell;
}

// ── asyncShellExec / shellExec ──────────────────────────────────────────────

export interface ShellExecOptions {
    cwd?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
}

export interface ShellExecResult {
    stdout: string;
    stderr: string;
}

/**
 * 将 shell 命令输出的 Buffer 解码为字符串。
 *
 * 在 Windows 上，cmd / PowerShell 默认输出编码为系统代码页（中文系统为 GBK/CP936），
 * 而非 UTF-8。直接使用 Buffer.toString('utf8') 会导致中文乱码。
 *
 * 策略：先尝试 UTF-8 解码，若结果包含替换字符（\\uFFFD）则回退到 GBK 解码。
 * 非 Windows 平台直接使用 UTF-8。
 */
export function decodeShellOutput(buffer: Buffer): string {
    if (process.platform !== 'win32') {
        return buffer.toString('utf8');
    }
    const utf8 = buffer.toString('utf8');
    // 包含 Unicode 替换字符说明 UTF-8 解码失败，回退到 GBK
    if (!utf8.includes('\uFFFD')) {
        return utf8;
    }
    try {
        return iconv.decode(buffer, 'gbk');
    } catch {
        return utf8;
    }
}

// ── detached 进程退出清理 ──────────────────────────────────────────────────
// detached 子进程经过 setsid() 后在新会话中运行，不会随父进程退出而终止。
// 维护一个全局 PID 集合，在 Node.js 退出时统一杀掉整个进程组，防止泄漏。

const detachedPids = new Set<number>();
const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const;
type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];
let exitHandlerInstalled = false;
let exitHandler: (() => void) | undefined;
const terminationHandlers = new Map<TerminationSignal, () => void>();

function signalDetachedProcesses(signal: NodeJS.Signals): void {
    for (const pid of detachedPids) {
        try {
            process.kill(-pid, signal);
        } catch {
            /* already dead */
        }
    }
}

function forceCleanupDetachedProcesses(): void {
    signalDetachedProcesses('SIGKILL');
    detachedPids.clear();
    uninstallExitHandlersIfIdle();
}

function uninstallExitHandlersIfIdle(): void {
    if (!exitHandlerInstalled || detachedPids.size > 0) return;
    if (exitHandler) process.removeListener('exit', exitHandler);
    for (const [signal, handler] of terminationHandlers) {
        process.removeListener(signal, handler);
    }
    exitHandler = undefined;
    terminationHandlers.clear();
    exitHandlerInstalled = false;
}

function handleTerminationSignal(signal: TerminationSignal, handler: () => void): void {
    signalDetachedProcesses('SIGTERM');

    // 若已有上层信号处理器，由上层负责异步保存、遥测刷新和最终退出；这里不能提前 process.exit()。
    // 若本处理器是唯一监听者，则移除自身并重放原始信号，以保留默认信号退出状态。
    if (process.listenerCount(signal) === 1) {
        forceCleanupDetachedProcesses();
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
        return;
    }

    // 上层优雅退出若迟迟没有结束，最终强制清理仍存活的进程组；unref 避免该定时器阻止正常退出。
    const forceTimer = setTimeout(forceCleanupDetachedProcesses, 1000);
    forceTimer.unref();
}

function ensureExitHandler(): void {
    if (exitHandlerInstalled) return;
    exitHandlerInstalled = true;
    exitHandler = forceCleanupDetachedProcesses;
    process.on('exit', exitHandler);
    for (const signal of TERMINATION_SIGNALS) {
        const handler = () => handleTerminationSignal(signal, handler);
        terminationHandlers.set(signal, handler);
        process.on(signal, handler);
    }
}

/**
 * 跟踪一个 detached 子进程，确保 OpenDesk 退出时杀掉其整个进程组。
 * close 事件确认进程及其 stdio 均已关闭后，自动从跟踪列表中移除。
 */
export function trackDetachedProcess(proc: ChildProcess): void {
    if (process.platform === 'win32' || !proc.pid) return;
    const pid = proc.pid;
    ensureExitHandler();
    detachedPids.add(pid);
    const remove = () => {
        detachedPids.delete(pid);
        uninstallExitHandlersIfIdle();
    };
    proc.on('close', remove);
}

// ── 非交互式环境变量防御表 ───────────────────────────────────────────────
// 子进程的 stdin 已关闭，但部分工具会绕过 stdin/stdout pipe 直接打开
// /dev/tty 做交互式提示，导致进程永久阻塞。以下变量告知这些工具：
// 此处没有交互终端可用。
//
// 仅当 env 中不存在该 key 时才注入，用户/平台/全局 environ 显式设置的值优先。
const NON_INTERACTIVE_ENV: Record<string, string> = {
    CI: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    DEBIAN_FRONTEND: 'noninteractive',
    NEEDRESTART_MODE: 'a',
    SUDO_ASKPASS: '/bin/false',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    npm_config_yes: 'true',
    PIP_NO_INPUT: '1',
    DOCKER_CLI_HINTS: 'false',
    DOCKER_SCAN_SUGGEST: 'false',
    HGPLAIN: '1',
    PYTHONINSPECT: '0',
    GPG_TTY: '',
    // OpenSSH 8.4+：禁止 askpass 弹窗，覆盖直接调用 ssh 的场景（GIT_SSH_COMMAND 仅覆盖 git 调用的 ssh）
    SSH_ASKPASS_REQUIRE: 'never',
    POETRY_NO_INTERACTION: '1',
    CONAN_NON_INTERACTIVE: '1'
};

/**
 * 向 env 注入非交互式防御变量。已存在的 key 不会被覆盖。
 */
export function injectNonInteractiveEnv(env: NodeJS.ProcessEnv): void {
    for (const [key, value] of Object.entries(NON_INTERACTIVE_ENV)) {
        if (!(key in env)) {
            env[key] = value;
        }
    }
}

/**
 * 获取全局环境变量合并后的 env 对象。
 * 优先级：process.env → 平台注入环境变量 → 用户全局 environ → 调用方显式 env。
 * 自动注入非交互式防御变量（用户显式设置优先）。
 */
export function mergeGlobalEnviron(explicitEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
    // 合并平台注入的环境变量（如 OpenHarmony 上的 NODE_OPTIONS=--jitless）
    let baseEnv: NodeJS.ProcessEnv = { ...process.env };
    const platformEnviron = getPlatform().getInjectedEnviron();
    if (platformEnviron.size > 0) {
        baseEnv = { ...baseEnv, ...Object.fromEntries(platformEnviron) };
    }

    let globalEnviron: Record<string, string> | undefined;
    try {
        globalEnviron = Setting.getInstance().getData().environ;
    } catch {
        // Setting 未初始化时回退
    }

    let result: NodeJS.ProcessEnv;
    if (!globalEnviron || Object.keys(globalEnviron).length === 0) {
        result = explicitEnv ? { ...baseEnv, ...explicitEnv } : baseEnv;
    } else if (explicitEnv) {
        result = { ...baseEnv, ...globalEnviron, ...explicitEnv };
    } else {
        result = { ...baseEnv, ...globalEnviron };
    }

    injectNonInteractiveEnv(result);
    return result;
}

/**
 * 异步执行 shell 命令（对标 child_process.exec 的 promisify 版本）。
 *
 * 通过 spawn + 默认 shell 执行命令，兼容不支持 exec 的平台。
 */
export function asyncShellExec(command: string, options: ShellExecOptions = {}): Promise<ShellExecResult> {
    return new Promise((resolve, reject) => {
        const { shellPath, shellArgs } = getDefaultShell();
        const env = mergeGlobalEnviron(options.env);
        // detached 让子进程在新会话中运行（POSIX setsid），使其没有控制终端。
        // 这样 open("/dev/tty") 直接失败（ENXIO），所有工具自动回退非交互模式，
        // 不依赖逐个工具的环境变量兼容性。Windows 无 /dev/tty 问题，跳过。
        const proc = spawn(shellPath, [...shellArgs, command], {
            cwd: options.cwd,
            env: env,
            stdio: 'pipe',
            detached: process.platform !== 'win32'
        });
        proc.stdin?.end();
        trackDetachedProcess(proc);

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let timedOut = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

        const timer = options.timeout
            ? setTimeout(() => {
                  timedOut = true;
                  // detached 模式下 proc.pid = PGID，向进程组发信号可杀掉整个子进程树，避免子进程泄漏
                  // Windows 不支持负 PID，detached 也为 false，直接 fallback 到单进程 kill
                  if (proc.pid) {
                      try {
                          process.kill(-proc.pid, 'SIGTERM');
                      } catch {
                          proc.kill('SIGTERM');
                      }
                  } else {
                      proc.kill('SIGTERM');
                  }
                  forceKillTimer = setTimeout(() => {
                      if (proc.pid) {
                          try {
                              if (process.platform === 'win32') {
                                  proc.kill('SIGKILL');
                              } else {
                                  process.kill(-proc.pid, 'SIGKILL');
                              }
                          } catch {
                              /* process already dead */
                          }
                      }
                  }, 1000);
                  forceKillTimer.unref();
              }, options.timeout)
            : null;

        proc.stdout?.on('data', (data: Buffer) => {
            stdoutChunks.push(data);
        });
        proc.stderr?.on('data', (data: Buffer) => {
            stderrChunks.push(data);
        });

        proc.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            const stderr = decodeShellOutput(Buffer.concat(stderrChunks));
            const stdout = decodeShellOutput(Buffer.concat(stdoutChunks));
            if (timedOut) {
                reject(new Error(`Command timed out after ${options.timeout}ms`));
            } else if (code !== 0) {
                const err: any = new Error(`Command failed with exit code ${code}: ${stderr}`);
                err.stderr = stderr;
                err.stdout = stdout;
                err.code = code;
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });

        proc.on('error', (err) => {
            if (timer) clearTimeout(timer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            reject(err);
        });
    });
}

/**
 * 同步执行 shell 命令（对标 child_process.execSync）。
 *
 * 通过 spawnSync + 默认 shell 执行命令，兼容不支持 execSync 的平台。
 */
export function shellExec(command: string, options: ShellExecOptions = {}): ShellExecResult {
    const { shellPath, shellArgs } = getDefaultShell();
    const env = mergeGlobalEnviron(options.env);
    // 不使用内置 encoding 以获取原始 Buffer，后续手动解码处理 Windows GBK 乱码
    const result = spawnSync(shellPath, [...shellArgs, command], {
        cwd: options.cwd,
        env: env,
        timeout: options.timeout,
        stdio: 'pipe'
    });

    if (result.error) {
        throw result.error;
    }

    const stdout = result.stdout ? decodeShellOutput(result.stdout) : '';
    const stderr = result.stderr ? decodeShellOutput(result.stderr) : '';

    if (result.status !== 0) {
        const err: any = new Error(`Command failed with exit code ${result.status}: ${stderr}`);
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = result.status;
        throw err;
    }

    return { stdout, stderr };
}
