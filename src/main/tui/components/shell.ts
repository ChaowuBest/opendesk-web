import { type AutocompleteItem } from '@mariozechner/pi-tui';
import { spawnSync, spawn, type ChildProcess } from 'child_process';
import chalk from 'chalk';
import process from 'process';
import path from 'path';
import fs from 'fs';

// ── Shell 检测 ──────────────────────────────────────────────────────────

function detectShell(): { shell: string; args: string[] } {
    const isOpenHarmony = process.env.OPENHARMONY === '1' || process.env.OHOS_SDK_HOME != null;
    if (isOpenHarmony) {
        return { shell: 'zsh', args: ['-c'] };
    }
    if (process.platform === 'win32') {
        for (const bin of ['bash']) {
            try {
                const r = spawnSync('where', [bin], {
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                if (r.status === 0 && r.stdout.trim()) {
                    return { shell: r.stdout.trim().split(/\r?\n/)[0]!, args: ['-c'] };
                }
            } catch {
                /* ignore */
            }
        }
        return { shell: 'powershell.exe', args: ['-Command'] };
    }
    for (const bin of ['bash', 'sh']) {
        try {
            const r = spawnSync('which', [bin], {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            if (r.status === 0 && r.stdout.trim()) {
                return { shell: r.stdout.trim().split(/\r?\n/)[0]!, args: ['-c'] };
            }
        } catch {
            /* ignore */
        }
    }
    return { shell: '/bin/sh', args: ['-c'] };
}

let _cachedShell: { shell: string; args: string[] } | undefined;

export function getShell() {
    if (!_cachedShell) _cachedShell = detectShell();
    return _cachedShell;
}

export function isBashLikeShell(): boolean {
    const { shell } = getShell();
    return /zsh|bash|sh$/.test(shell);
}

/**
 * 将 Windows 路径转为适合在 bash-like shell 中 cd 使用的形式。
 *
 * Git Bash (MSYS2) 不认识 `C:\foo\bar` 这种格式，需要转成 `/c/foo/bar`。
 * 路径中可能有空格所以还要加引号。
 *
 * 对于 PowerShell / cmd 等非 bash 场景，只需要用引号包裹即可。
 */
export function shellQuoteCwd(cwd: string): string {
    const { shell } = getShell();
    const bashLike = /zsh|bash|sh$/.test(shell);

    if (process.platform === 'win32' && bashLike) {
        // Windows + bash-like shell (Git Bash / MSYS2):
        // Convert  C:\Users\foo  →  /c/Users/foo
        let converted = cwd.replace(/\\/g, '/');
        const driveMatch = converted.match(/^([a-zA-Z]):\//);
        if (driveMatch) {
            converted = '/' + driveMatch[1].toLowerCase() + converted.slice(2);
        }
        return `'${converted}'`;
    }

    if (!bashLike) {
        // PowerShell: use double quotes, escape internal double-quotes
        return `"${cwd.replace(/"/g, '`"')}"`;
    }

    // Unix bash/zsh: single-quote is safest (handles spaces, parens, etc.)
    return `'${cwd.replace(/'/g, "'\\''")}'`;
}

// ── Shell 命令补全 ──────────────────────────────────────────────────────

const SHELL_COMPLETION_MAX = 30;
const _shellCompletionCache: Map<string, { items: AutocompleteItem[]; ts: number }> = new Map();
const SHELL_CACHE_TTL = 30_000;

export function getShellCompletions(inputCmd: string, cwd: string): AutocompleteItem[] {
    const trimmed = inputCmd.trim();
    if (trimmed.length === 0) return [];

    const cacheKey = `${cwd}::${trimmed}`;
    const cached = _shellCompletionCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SHELL_CACHE_TTL) return cached.items;

    const { shell, args } = getShell();
    const bashLike = /zsh|bash|sh$/.test(shell);

    let completions: string[] = [];

    if (bashLike) {
        const tokens = trimmed.split(/\s+/);
        const isFirstToken = tokens.length <= 1;
        const lastToken = tokens[tokens.length - 1] || '';

        if (isFirstToken) {
            const result = spawnSync(shell, [...args, `compgen -c -- '${lastToken.replace(/'/g, "'\\''")}'`], {
                cwd,
                encoding: 'utf-8',
                timeout: 3000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            if (result.status === 0 && result.stdout) {
                completions = result.stdout.trim().split('\n').filter(Boolean);
            }
        } else {
            const result = spawnSync(shell, [...args, `compgen -f -- '${lastToken.replace(/'/g, "'\\''")}'`], {
                cwd,
                encoding: 'utf-8',
                timeout: 3000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            if (result.status === 0 && result.stdout) {
                completions = result.stdout.trim().split('\n').filter(Boolean);
            }
        }
    } else {
        const tokens = trimmed.split(/\s+/);
        const isFirstToken = tokens.length <= 1;
        const lastToken = tokens[tokens.length - 1] || '';

        if (isFirstToken && lastToken.length > 0) {
            const psCmd = `(Get-Command '${lastToken}*' -ErrorAction SilentlyContinue | Select-Object -First ${SHELL_COMPLETION_MAX} -ExpandProperty Name) -join "\\n"`;
            const result = spawnSync(shell, [...args, psCmd], {
                cwd,
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            if (result.status === 0 && result.stdout) {
                completions = result.stdout.trim().split(/\r?\n/).filter(Boolean);
            }
        } else if (!isFirstToken) {
            try {
                const dir =
                    lastToken.includes('/') || lastToken.includes('\\')
                        ? path.resolve(cwd, path.dirname(lastToken))
                        : cwd;
                const prefix =
                    lastToken.includes('/') || lastToken.includes('\\') ? path.basename(lastToken) : lastToken;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name.toLowerCase().startsWith(prefix.toLowerCase())) {
                        completions.push(entry.name + (entry.isDirectory() ? '/' : ''));
                    }
                }
            } catch {
                /* ignore */
            }
        }
    }

    const seen = new Set<string>();
    const items: AutocompleteItem[] = [];
    for (const c of completions) {
        if (seen.has(c)) continue;
        seen.add(c);
        items.push({ value: c, label: c });
        if (items.length >= SHELL_COMPLETION_MAX) break;
    }

    _shellCompletionCache.set(cacheKey, { items, ts: Date.now() });
    if (_shellCompletionCache.size > 200) {
        const first = _shellCompletionCache.keys().next().value;
        if (first) _shellCompletionCache.delete(first);
    }

    return items;
}

// ── ANSI 转义序列清理 ───────────────────────────────────────────────────

/**
 * 清理 ANSI 转义序列，只保留 SGR（Select Graphic Rendition）颜色/样式代码。
 *
 * 原因：curl、git 等命令的 --help 输出包含非 SGR 控制序列，如：
 * - \x1b[K  清除到行尾（被当作文本显示导致空白）
 * - \r     回车符（导致覆盖问题）
 * - \x1b[J 清屏等
 *
 * 这些序列被 pi-tui 当作文本显示，导致渲染异常。
 * 本函数移除这些控制序列，只保留颜色代码以保持可读性。
 */
function sanitizeAnsiForTui(text: string): string {
    // 匹配 ANSI C0 控制字符（C0 control characters）
    // 包括 \r, \n, \t, \x00-\x1f (除了 \n, \t), \x7f (DEL)
    // 但保留换行符 \n 和水平制表符 \t
    let result = text;

    // 处理 \r 回车符：转换为换行（保留内容）或移除（避免覆盖）
    // curl --help 等命令用 \r 来在同一行覆盖输出，保留 \r 会导致覆盖问题
    // 转为 \n 更安全
    result = result.replace(/\r\n?/g, '\n');

    // 移除非 SGR 的 ANSI 转义序列
    // SGR 序列格式: \x1b[...m
    // 匹配: \x1b[...m 但排除 SGR (Select Graphic Rendition)
    // SGR 参数范围: 0-9, 10-29, 30-39, 40-49, 50-69, 70-79, 80-87, 88-89, 90-97, 100-107, 108-109, 110-112, 113-115, 116-119, 120-122, 123-129, 130-135, 137-138, 139, 148-149, 151-153, 154-155, 156, 157-159, 160-255
    // 简化的 SGR 匹配: \x1b\[[\d;]+m 其中参数为数字，可包含分号
    // 非 SGR: 光标移动 \x1b[H \x1b[{row};{col}H \x1b[{n}A/B/C/D \x1b[{n}E/F/G \x1b[6n 等
    //       清屏 \x1b[J \x1b[2J \x1b[3J 等
    //       擦除 \x1b[K \x1b[0K 等
    //       保存/恢复光标位置 \x1b[s \x1b[u \x1b7 \x1b8
    //       模式设置 \x1b[?{n}h \x1b[?{n}l 等

    // 移除 CSI 序列（非 SGR）
    // CSI 格式: \x1b[...{letter}
    // SGR 以 'm' 结尾
    // 匹配 \x1b[ 后跟非 'm' 的内容直到字母结尾
    result = result.replace(/\x1b\[[\d;]*[ABCDHJKXfhilmnsu]/g, '');

    // 移除 OSC (Operating System Command) 序列: \x1b]...\x07 或 \x1b]...\x1b\\
    result = result.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

    // 移除其他 escape 序列
    // \x1b( 字符集设置
    result = result.replace(/\x1b\([A-Z0-9`#%()*+-./<=>]/g, '');

    // 移除孤立的 \x1b
    result = result.replace(/\x1b/g, '');

    // 折叠连续的空行（超过2个空行合并为2个）
    result = result.replace(/\n{3,}/g, '\n\n');

    return result;
}

// ── Shell 命令执行 ──────────────────────────────────────────────────────

export interface ShellExecCallbacks {
    onHint: (text: string) => void;
    onResult: (header: string, output: string) => void;
    onError: (header: string, output: string) => void;
    onCwdChanged: (newCwd: string) => void;
    requestRender: () => void;
}

let _runningShellProcess: ChildProcess | undefined;

export function killRunningShell() {
    if (_runningShellProcess) {
        try {
            _runningShellProcess.kill();
        } catch {
            /* ignore */
        }
        _runningShellProcess = undefined;
    }
}

export function hasRunningShell(): boolean {
    return _runningShellProcess !== undefined;
}

export function executeShellCommand(cmd: string, cwd: string, callbacks: ShellExecCallbacks) {
    killRunningShell();

    const { shell, args } = getShell();
    const isWin = process.platform === 'win32';

    const pwdCmd = isWin ? 'pwd -W' : 'pwd';
    const quotedCwd = shellQuoteCwd(cwd);
    const wrappedCmd = `cd ${quotedCwd} && ${cmd} && ${pwdCmd}`;

    const child = spawn(shell, [...args, wrappedCmd], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    _runningShellProcess = child;

    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
    });

    child.on('close', (code) => {
        if (_runningShellProcess === child) {
            _runningShellProcess = undefined;
        }

        const exitLabel = code === 0 ? chalk.green(`exit: ${code}`) : chalk.red(`exit: ${code ?? '?'}`);
        const header = `${chalk.cyan('$')} ${chalk.bold(cmd)}  ${exitLabel}`;

        // 清理 ANSI 控制序列，只保留颜色代码
        const cleanedStdout = sanitizeAnsiForTui(stdout);
        const cleanedStderr = sanitizeAnsiForTui(stderr);

        let displayOutput = cleanedStdout;
        let cwdChangedMsg = '';

        if (code === 0 && cleanedStdout.trim()) {
            const lines = cleanedStdout.trimEnd().split('\n');
            let lastLine = lines[lines.length - 1].trim();
            if (isWin) {
                const msysMatch = lastLine.match(/^\/([a-zA-Z])\/(.*)/);
                if (msysMatch) {
                    lastLine = msysMatch[1].toUpperCase() + ':\\' + msysMatch[2].replace(/\//g, '\\');
                }
            }
            const resolvedNew = path.resolve(lastLine);
            if (lastLine && path.isAbsolute(lastLine) && fs.existsSync(resolvedNew)) {
                const oldCwd = path.resolve(cwd);
                displayOutput = lines.slice(0, -1).join('\n');
                const cwdChanged = isWin ? resolvedNew.toLowerCase() !== oldCwd.toLowerCase() : resolvedNew !== oldCwd;
                if (cwdChanged) {
                    callbacks.onCwdChanged(resolvedNew);
                    cwdChangedMsg = chalk.yellow(`📂 工作空间已切换: ${oldCwd} → ${resolvedNew}`);
                }
            }
        }

        const parts: string[] = [];
        const trimmedOutput = (displayOutput + (cleanedStderr ? chalk.red(cleanedStderr) : '')).trimEnd();
        if (trimmedOutput) parts.push(trimmedOutput);
        if (cwdChangedMsg) parts.push(cwdChangedMsg);
        const finalOutput = parts.length > 0 ? parts.join('\n') : chalk.dim('(无输出)');

        callbacks.onResult(header, finalOutput);
        callbacks.requestRender();
    });

    child.on('error', (err) => {
        if (_runningShellProcess === child) {
            _runningShellProcess = undefined;
        }
        const header = `${chalk.cyan('$')} ${chalk.bold(cmd)}  ${chalk.red('error')}`;
        callbacks.onError(header, chalk.red(`执行失败: ${err.message}`));
        callbacks.requestRender();
    });
}
