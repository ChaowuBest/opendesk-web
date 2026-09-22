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
import { Setting, getOpendeskDirectory, type SettingData } from './setting.js';
import { getPlatform } from '../../platforms/base.js';
import { getCachedProxyEnvVars } from './proxy-env.js';

// ── 可执行文件查找 ──────────────────────────────────────────────────────────

/**
 * 通过 PATH 环境变量及平台备选路径查找可执行文件。
 * 支持跨平台：Windows、macOS、Linux、OpenHarmony。
 */
export function findExecutableInPath(executable: string): string | null {
    return executablePaths(executable).next().value ?? null;
}

export function findExecutablesInPath(executable: string): string[] {
    return [...executablePaths(executable)];
}

function* executablePaths(executable: string): Generator<string> {
    const isWindows = process.platform === 'win32';
    const pathSeparator = isWindows ? ';' : ':';
    const pathEnv = process.env.PATH || '';
    const searchDirs: string[] = pathEnv.split(pathSeparator).filter(Boolean);
    const sysRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';

    if (isWindows) {
        // Windows 系统工具可能不在 PATH 中（如精简版 / Server Core / 32位进程在64位系统上的重定向等），
        // 补充已知的默认安装位置作为 fallback
        searchDirs.push(
            `${sysRoot}\\System32`,
            `${sysRoot}\\System32\\WindowsPowerShell\\v1.0`,
            `${sysRoot}\\SysWOW64\\WindowsPowerShell\\v1.0`,
            `${sysRoot}\\Sysnative\\WindowsPowerShell\\v1.0`
        );
        if (['bash', 'zsh', 'pwsh'].includes(executable)) {
            const programDirs = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)']];
            for (const dir of programDirs) {
                if (dir)
                    searchDirs.push(
                        path.win32.join(dir, 'Git/bin'),
                        path.win32.join(dir, 'Git/usr/bin'),
                        path.win32.join(dir, 'PowerShell/7')
                    );
            }
            if (process.env.LOCALAPPDATA)
                searchDirs.push(path.win32.join(process.env.LOCALAPPDATA, 'Programs/Git/bin'));
        }
    } else {
        searchDirs.push('/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin');
        // OpenHarmony DevBox 的 hnp 专有路径
        if ((process.platform as string) === 'openharmony' || process.env.OHOS_SDK_HOME != null) {
            searchDirs.push('/data/service/hnp/bin');
        }
    }

    const executableNames = isWindows
        ? [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`]
        : [executable];
    const joinPath = isWindows ? path.win32.join : path.posix.join;
    const seen = new Set<string>();

    for (const dir of searchDirs) {
        for (const name of executableNames) {
            const fullPath = joinPath(dir.replace(/^"|"$/g, ''), name);
            // Windows 的 %SystemRoot%\System32\bash.exe 是 WSL 启动器而非真正的 bash：
            // 以它作为 shell 执行 Windows 路径会被当作 Linux 路径处理（issue #319），
            // 因此在唯一查找出口处排除，shell 扫描、默认 shell 与 TUI 检测统一受益
            if (
                isWindows &&
                executable === 'bash' &&
                fullPath.toLowerCase() === path.win32.join(sysRoot, 'System32', 'bash.exe').toLowerCase()
            )
                continue;
            const key = isWindows ? fullPath.toLowerCase() : fullPath;
            if (seen.has(key)) continue;
            seen.add(key);
            try {
                if (!fs.existsSync(fullPath)) continue;
                if (!isWindows) fs.accessSync(fullPath, fs.constants.X_OK);
                yield fullPath;
            } catch {
                continue;
            }
        }
    }
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

/**
 * 解析 OpenHarmony 上可用的 zsh 路径。
 *
 * 真机验证 zsh 固定安装于 /usr/bin/zsh，优先写死路径并用 spawnSync 做一次
 * 轻量执行验证；固定路径不存在或运行验证失败时，回退到 PATH 中查找 zsh
 * （与 findOpenHarmonyBash 的结构保持一致）。
 */
export function findOpenHarmonyZsh(): string | null {
    const zshPath = '/usr/bin/zsh';
    try {
        fs.accessSync(zshPath, fs.constants.X_OK);
        // 实际执行验证，确保 spawn 可用
        const verify = spawnSync(zshPath, ['-c', 'true'], { timeout: 5000 });
        if (verify.status === 0 && !verify.error) {
            return zshPath;
        }
    } catch {
        // 固定路径不可用，回退到 PATH 查找
    }
    return findExecutableInPath('zsh');
}

// 探测结果按 zsh 路径缓存：/etc/zshrc 在运行期不会变化
const zshExitNoiseCache = new Map<string, boolean>();

/**
 * 探测 zsh -i 退出阶段是否产生历史保存噪音输出。
 *
 * 部分 OpenHarmony 版本的 /etc/zshrc 无条件注册 EXIT trap（preexit：打印
 * "saving history..." / "completed." 并 fc -AI 写历史）；另一些版本 source
 * /etc/smartshell.zsh，其 EXIT trap（若有）可能承担实际功能，不能无差别
 * trap - EXIT 清除。因此按实际执行行为探测：仅当 -i 退出的输出确含该噪音
 * 时，调用方才在命令前加 trap - EXIT 前缀；探测干净的环境原样执行。
 */
export function zshInteractiveHasExitTrapNoise(zshPath: string): boolean {
    const cached = zshExitNoiseCache.get(zshPath);
    if (cached !== undefined) return cached;
    let noisy = false;
    try {
        const probe = spawnSync(zshPath, ['-i', '-c', 'true'], { timeout: 5000, encoding: 'utf8' });
        noisy = (probe.stdout ?? '').includes('saving history') || (probe.stderr ?? '').includes('saving history');
    } catch {
        noisy = false;
    }
    zshExitNoiseCache.set(zshPath, noisy);
    return noisy;
}

/** 清除退出噪音探测缓存（测试用） */
export function clearZshExitNoiseCache(): void {
    zshExitNoiseCache.clear();
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
        // 优先 zsh 交互模式（-i 加载 ~/.zshrc 环境变量设置），验证可运行后使用；
        // 不可用时回退到 HNP bash，最后兜底 /bin/sh
        const zshPath = findOpenHarmonyZsh();
        if (zshPath) {
            _cachedDefaultShell = { shellPath: zshPath, shellArgs: ['-i', '-c'] };
        } else {
            const bashPath = findOpenHarmonyBash();
            _cachedDefaultShell = bashPath
                ? { shellPath: bashPath, shellArgs: ['-c'] }
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
    /**
     * 从子进程环境中移除 NPM_CONFIG_PREFIX 和 npm_config_prefix。
     *
     * buildInterpretersEnv 会为所有子进程注入 NPM_CONFIG_PREFIX 指向
     * interpreters 沙箱目录，这会导致 `npm root -g`、`npm install -g` 等
     * 命令操作到错误的全局目录。npm 相关命令应设置此选项。
     */
    stripNpmPrefix?: boolean;
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

// ── shell 输出噪音过滤 ──────────────────────────────────────────────────────

// 过滤 shell 在某些受限环境下启动时的噪音警告
// 警告可能出现在输出中的任意位置（行首、行尾、甚至拼接在其他文本后），因此不使用 ^ 锚点
// 消息模板来自 bash 5.3 builtins/common.c get_working_directory()：
//   <标签>: error retrieving current directory: getcwd: cannot access parent directories: <strerror(errno)>
// 标签集收录经 OpenDesk 调用链验证（OpenHarmony 平台）会触发的 5 个：
//   - shell-init：bash 启动 set_pwd 主路径（PWD 缺失/失效时触发）
//   - shell_init：bash 启动按 POSIX 规则导入 PWD 后 canonpath 失败分支
//     （OpenDesk 全链路只透传不注入 PWD，该分支依赖主进程继承的失效 PWD）
//   - chdir/cd/pwd：TUI 链路固定包装 `cd '<dir>' && <cmd> && pwd`（tui/components/shell.ts），
//     agent 自由生成命令亦可达
// 末段为 strerror(errno)，取值不可枚举：真机实测已有 Permission denied/Not supported/Not a tty/
// No error information/Invalid argument 等变体，故用行内通配 [^\r\n]*。
const SHELL_CWD_WARNING_RE =
    /(?:shell-init|shell_init|chdir|cd|pwd): error retrieving current directory: getcwd: cannot access parent directories: [^\r\n]*\r?\n?/g;

// OSC（Operating System Command）序列：ESC ] + payload + 终止符（BEL 或 ST）。
// 来源：OpenDesk 以 `zsh -i -c` 启动 zsh 时会加载 .zshrc，其中若注册了 Warp 系终端
// （warpdotdev/Warp 及其分支）的 shell integration，其 hook 会在 shell 启动阶段向
// stdout/stderr 写入面向终端模拟器的事件通知。实测样例（OpenHarmony 真机）：
// \e]9278;f;{"event": "SetupComplete"}\a，OSC 9278 为 Warp 私有编号，定义见 Warp 源码
// app/assets/bundled/bootstrap/zsh_body.sh；此外还涵盖 \e]0;title\a（窗口标题）等标准
// OSC。此类序列属于终端协议层控制信息而非命令输出内容，剔除不影响结果语义。
//
// payload 不允许包含 BEL/ESC/换行（CR/LF）：
// - 排除 BEL/ESC：异常截断的序列不匹配；
// - 排除换行：OSC payload 规范上单行；而 Warp 系 integration 会将 marker 的起始
//   ESC] 与终止 BEL 分离写入（真机实测两者之间夹着命令的输出）。若 payload 允许
//   跨行，一个悬空的起始符会把整段命令输出当作 payload 吞掉（真机 "ls 输出消失，
//   仅剩 saving history..." 事故）。悬空起始符因无终止符而整体保留，信息保全优先。
const SHELL_OSC_SEQUENCE_RE = /\x1b\][^\x07\x1b\n\r]*(?:\x07|\x1b\\)/g;

// 孤立 BEL（0x07）：响铃控制符在命令输出文本中无语义。悬空 OSC 起始符的迟到终止符
// 会以孤立 BEL 形式残留在输出中间，一并剔除
const SHELL_ORPHAN_BEL_RE = /\x07/g;

/**
 * 过滤 shell 输出中的环境噪音：
 * - 受限环境下的 getcwd/chdir 启动警告
 * - 交互模式（zsh -i）下 shell integration 向终端输出的 OSC 序列
 */
export function filterShellEnvironmentWarnings(text: string): string {
    return text.replace(SHELL_CWD_WARNING_RE, '').replace(SHELL_OSC_SEQUENCE_RE, '').replace(SHELL_ORPHAN_BEL_RE, '');
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

const PATH_SEGMENT = process.platform === 'win32' ? ';' : ':';

const USER_PYTHON_ENV_KEYS = ['VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_PREFIX_1'] as const;
const USER_PYTHON_CONTEXT_ENV_KEYS = [
    'VIRTUAL_ENV',
    'VIRTUAL_ENV_PROMPT',
    'CONDA_PREFIX',
    'CONDA_PREFIX_1',
    'CONDA_DEFAULT_ENV',
    'CONDA_PROMPT_MODIFIER',
    'CONDA_SHLVL',
    'CONDA_EXE',
    'CONDA_PYTHON_EXE',
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONUSERBASE'
] as const;

function prependEnvPath(entries: string[], current: string | undefined): string {
    return [...entries, ...(current ? [current] : [])].join(PATH_SEGMENT);
}

export function hasUserPythonEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
    return USER_PYTHON_ENV_KEYS.some((key) => {
        const value = env[key];
        return typeof value === 'string' && value.trim().length > 0;
    });
}

export function shouldUseIsolatedPython(
    settingData: Pick<SettingData, 'cli_config'>,
    env: NodeJS.ProcessEnv = process.env
): boolean {
    if (settingData.cli_config?.inherit_venv !== false && hasUserPythonEnvironment(env)) {
        return false;
    }
    return settingData.cli_config?.use_isolated_python !== false;
}

function normalizePathEntry(entry: string): string {
    const normalized = path.normalize(entry);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getUserPythonPathEntries(env: NodeJS.ProcessEnv): Set<string> {
    const entries = new Set<string>();
    const isWindows = process.platform === 'win32';

    for (const key of USER_PYTHON_ENV_KEYS) {
        const rawDir = env[key];
        if (typeof rawDir !== 'string' || rawDir.trim().length === 0) continue;

        const dir = rawDir.trim();
        const candidates = [
            path.join(dir, 'bin'),
            path.join(dir, 'condabin'),
            ...(isWindows ? [dir, path.join(dir, 'Scripts'), path.join(dir, 'Library', 'bin')] : [])
        ];
        for (const candidate of candidates) {
            entries.add(normalizePathEntry(candidate));
        }
    }

    return entries;
}

export function stripUserPythonEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const next = { ...env };
    for (const key of USER_PYTHON_CONTEXT_ENV_KEYS) {
        delete next[key];
    }

    const pathEntriesToRemove = getUserPythonPathEntries(env);
    if (typeof env.PATH === 'string' && pathEntriesToRemove.size > 0) {
        next.PATH = env.PATH.split(PATH_SEGMENT)
            .filter((entry) => !pathEntriesToRemove.has(normalizePathEntry(entry)))
            .join(PATH_SEGMENT);
    }

    return next;
}

export function buildInterpretersEnv(
    options: {
        useIsolatedPython?: boolean;
        baseEnv?: NodeJS.ProcessEnv;
    } = {}
): NodeJS.ProcessEnv {
    const baseEnv = options.baseEnv ?? process.env;
    const useIsolatedPython = options.useIsolatedPython !== false;
    const interpretersDir = path.join(getOpendeskDirectory(), 'interpreters');
    const cmdPkgsDir = path.join(interpretersDir, 'cmd-pkgs');
    const isWindows = process.platform === 'win32';

    const npmPrefix = baseEnv.NPM_CONFIG_PREFIX || path.join(interpretersDir, 'npm-global');
    fs.mkdirSync(npmPrefix, { recursive: true });
    const npmBinDir = isWindows ? npmPrefix : path.join(npmPrefix, 'bin');
    const env: NodeJS.ProcessEnv = {
        NPM_CONFIG_PREFIX: npmPrefix,
        CMD_PKGS_DIR: cmdPkgsDir,
        PATH: prependEnvPath([npmBinDir], baseEnv.PATH)
    };

    if (!useIsolatedPython) return env;

    const pipTarget = baseEnv.PIP_TARGET || path.join(interpretersDir, 'pip-global');
    fs.mkdirSync(pipTarget, { recursive: true });
    const pipBinDir = path.join(pipTarget, isWindows ? 'Scripts' : 'bin');
    const uvDir = path.join(interpretersDir, 'uv');
    const uvCacheDir = baseEnv.UV_CACHE_DIR || path.join(uvDir, 'cache');
    const uvToolDir = baseEnv.UV_TOOL_DIR || path.join(uvDir, 'tools');
    const uvToolBinDir = baseEnv.UV_TOOL_BIN_DIR || path.join(uvToolDir, 'bin');
    fs.mkdirSync(uvCacheDir, { recursive: true });
    fs.mkdirSync(uvToolDir, { recursive: true });

    env.PIP_TARGET = pipTarget;
    env.UV_CACHE_DIR = uvCacheDir;
    env.UV_TOOL_DIR = uvToolDir;
    env.UV_TOOL_BIN_DIR = uvToolBinDir;
    env.PATH = prependEnvPath([npmBinDir, pipBinDir, uvToolBinDir], baseEnv.PATH);
    env.PYTHONPATH = prependEnvPath([pipTarget], baseEnv.PYTHONPATH);
    return env;
}

/**
 * 获取全局环境变量合并后的 env 对象。
 * 优先级：process.env → 平台注入环境变量 → 用户全局 environ → 调用方显式 env。
 * 自动注入非交互式防御变量（用户显式设置优先）。
 */
export function mergeGlobalEnviron(explicitEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
    // 合并平台注入的环境变量
    let baseEnv: NodeJS.ProcessEnv = { ...process.env };
    try {
        const platformEnviron = getPlatform().getInjectedEnviron();
        if (platformEnviron.size > 0) {
            baseEnv = { ...baseEnv, ...Object.fromEntries(platformEnviron) };
        }
    } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Platform is not set') throw error;
        // 平台尚未初始化时仅使用进程环境；测试与早期启动阶段可能进入这里
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

    // Windows 上系统 PATH 变量注册为 "Path"（混合大小写），{ ...process.env } 展开为
    // plain object 后 process.env 的大小写不敏感代理失效，下游 result.PATH 会返回
    // undefined，导致 spawn 时丢失系统 PATH，子进程找不到 npx/uvx/node 等命令。
    // 在统一入口处归一化为 "PATH"，所有调用方（asyncShellExec/shellExec/mcpmgr 等）都自动受益。
    const pathKey = Object.keys(result).find((k) => k.toLowerCase() === 'path');
    if (pathKey && pathKey !== 'PATH') {
        result.PATH = result[pathKey];
        delete result[pathKey];
    }

    injectNonInteractiveEnv(result);
    return result;
}

/**
 * 构建 OpenDesk 子进程的完整环境变量。
 *
 * 统一处理系统/平台/用户/调用方变量、Python 环境继承策略、内置 npm/pip/uv
 * 可写目录、UTF-8 编码和非交互式防御变量。
 */
export function buildChildProcessEnv(explicitEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    let env = mergeGlobalEnviron(explicitEnv) ?? { ...process.env, ...explicitEnv };
    let settingData: Pick<SettingData, 'cli_config' | 'network_config'> = {
        cli_config: undefined,
        network_config: undefined
    };
    try {
        settingData = Setting.getInstance().getData();
    } catch {
        // Setting 未初始化时使用默认解释器隔离策略
    }

    const inheritVenv = settingData.cli_config?.inherit_venv !== false;
    const interpreterBaseEnv = inheritVenv ? env : stripUserPythonEnvironment(env);
    env = {
        ...interpreterBaseEnv,
        ...buildInterpretersEnv({
            useIsolatedPython: shouldUseIsolatedPython(settingData, interpreterBaseEnv),
            baseEnv: interpreterBaseEnv
        })
    };

    if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = 'utf-8';
    if (!env.PYTHONUTF8) env.PYTHONUTF8 = '1';
    injectNonInteractiveEnv(env);

    // npm 不会继承平台 fetch 的 TLS 策略，需要显式映射全局证书校验设置。
    if (settingData.network_config?.no_ssl === true) {
        env.npm_config_strict_ssl = 'false';
    }

    // 代理变量注入：network_config 优先（方案 B），无条件覆盖 env。
    //   - none   → 清空所有代理变量，确保命令行不走代理
    //   - system → 覆盖为系统代理（鸿蒙走 ArkTS 桥接，其他平台透传 env）
    //   - custom → 覆盖为 custom_proxy_addr
    // 缓存由 refreshProxyEnvCache() 预热，未就绪时不动 env（不阻塞 spawn）。
    const useProxy = settingData.network_config?.use_proxy ?? 'system';
    if (useProxy === 'none') {
        delete env.HTTP_PROXY;
        delete env.HTTPS_PROXY;
        delete env.http_proxy;
        delete env.https_proxy;
        delete env.NO_PROXY;
        delete env.no_proxy;
    } else {
        const proxyEnv = getCachedProxyEnvVars();
        if (proxyEnv) Object.assign(env, proxyEnv);
    }
    return env;
}

/**
 * 异步执行 shell 命令（对标 child_process.exec 的 promisify 版本）。
 *
 * 通过 spawn + 默认 shell 执行命令，兼容不支持 exec 的平台。
 */
export function asyncShellExec(command: string, options: ShellExecOptions = {}): Promise<ShellExecResult> {
    return new Promise((resolve, reject) => {
        const { shellPath, shellArgs } = getDefaultShell();
        const env = buildChildProcessEnv(options.env);
        if (options.stripNpmPrefix) {
            delete env.NPM_CONFIG_PREFIX;
            delete env.npm_config_prefix;
        }
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
            // 与 executeShellCommand 一致过滤交互模式噪音；此处为整段拼接后过滤，不受 chunk 边界影响
            const stderr = filterShellEnvironmentWarnings(decodeShellOutput(Buffer.concat(stderrChunks)));
            const stdout = filterShellEnvironmentWarnings(decodeShellOutput(Buffer.concat(stdoutChunks)));
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
    const env = buildChildProcessEnv(options.env);
    if (options.stripNpmPrefix) {
        delete env.NPM_CONFIG_PREFIX;
        delete env.npm_config_prefix;
    }
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

    const stdout = result.stdout ? filterShellEnvironmentWarnings(decodeShellOutput(result.stdout)) : '';
    const stderr = result.stderr ? filterShellEnvironmentWarnings(decodeShellOutput(result.stderr)) : '';

    if (result.status !== 0) {
        const err: any = new Error(`Command failed with exit code ${result.status}: ${stderr}`);
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = result.status;
        throw err;
    }

    return { stdout, stderr };
}
