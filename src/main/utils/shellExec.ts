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

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
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

    if (!isWindows) {
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
 */
export function findOpenHarmonyBash(): string | null {
    const hnpBash = '/data/service/hnp/bin/bash';
    try {
        fs.accessSync(hnpBash, fs.constants.X_OK);
        return hnpBash;
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
        const psPath = findExecutableInPath('powershell');
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
 * 获取全局环境变量合并后的 env 对象。
 * 优先级：process.env → 平台注入环境变量 → 用户全局 environ → 调用方显式 env。
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
    if (!globalEnviron || Object.keys(globalEnviron).length === 0) {
        return explicitEnv ? { ...baseEnv, ...explicitEnv } : baseEnv;
    }
    if (explicitEnv) {
        return { ...baseEnv, ...globalEnviron, ...explicitEnv };
    }
    return { ...baseEnv, ...globalEnviron };
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
        const proc = spawn(shellPath, [...shellArgs, command], {
            cwd: options.cwd,
            env: env,
            stdio: 'pipe'
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = options.timeout
            ? setTimeout(() => {
                  timedOut = true;
                  proc.kill('SIGTERM');
              }, options.timeout)
            : null;

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });
        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (timer) clearTimeout(timer);
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
    const result = spawnSync(shellPath, [...shellArgs, command], {
        cwd: options.cwd,
        env: env,
        timeout: options.timeout,
        encoding: 'utf-8',
        stdio: 'pipe'
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const stderr = result.stderr || '';
        const err: any = new Error(`Command failed with exit code ${result.status}: ${stderr}`);
        err.stderr = stderr;
        err.stdout = result.stdout || '';
        err.code = result.status;
        throw err;
    }

    return {
        stdout: result.stdout || '',
        stderr: result.stderr || ''
    };
}
