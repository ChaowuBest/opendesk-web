/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findExecutablesInPath, findOpenHarmonyBash, findOpenHarmonyZsh } from '../../utils/shellExec.js';
import type { SupportedShell, SupportedShellKind } from '../../../common/shells.js';
export { selectSupportedShell, type SupportedShell, type SupportedShellKind } from '../../../common/shells.js';
import {
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyLocalRuntimeState,
    type HarmonyLocalRuntimeState
} from '../../../platforms/bridges/harmonyos/local-runtime.js';
import { getPlatform } from '../../../platforms/base.js';
import { resolveOpenHarmonySandboxExecutable } from './sandboxes/resolve-ohos.js';

/**
 * CLI 模式不会安装沙箱的二进制与 Dokan 驱动（仅桌面安装包携带），注册沙箱变体
 * 只会让选中的 PowerShell 在运行时报 executableMissing，并让 TUI 设置页暴露
 * 无效选项；因此沙箱变体仅在非 CLI 平台（桌面版）注册。
 * @param targetPlatform 目标平台（与运行时平台分离，便于跨平台测试模拟）
 */
function sandboxVariantsAvailable(targetPlatform: string): boolean {
    try {
        if (getPlatform().getName() === 'cli') return false;
    } catch {
        // 平台未初始化（如单元测试）时保持原有行为
    }
    // 仅 Linux/OpenHarmony 沙箱变体依赖本地二进制（dynobox-linux）；
    // win32/darwin 的沙箱组件随桌面安装包提供，无需本机探测
    if (targetPlatform === 'win32' || targetPlatform === 'darwin') return true;
    if (targetPlatform === 'openharmony') {
        // 与 openharmony-sandbox.ts 共用同一解析：OPENDESK_DYNOBOX_BIN →
        // /data/app/bin/dynobox（真机壳工程部署）→ resources/sandbox → 仓库 runtime
        return resolveOpenHarmonySandboxExecutable() !== null;
    }
    if (targetPlatform !== 'linux') return false;
    const electronProcess = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
    const dev = path.join(
        process.env.INIT_CWD || process.cwd(),
        'native',
        'linux',
        'sandbox',
        'target',
        'release',
        'dynobox-linux'
    );
    const packaged = path.join(electronProcess.resourcesPath || '', 'sandbox', 'dynobox-linux');
    if (!fs.existsSync(dev) && !fs.existsSync(packaged)) return false;
    // userns 探测：fork 子进程 unshare(CLONE_NEWUSER)（AppArmor/内核限制时 EPERM）
    try {
        const probe = spawnSync('unshare', ['-U', 'true'], { timeout: 3000 });
        return probe.status === 0 && probe.error === undefined;
    } catch {
        return false;
    }
    return true;
}

/** Discover runnable shells using the current platform and its configured runtime state. */
export function scanSupportedShells(
    platform: NodeJS.Platform | string = process.platform,
    harmonyState: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
): SupportedShell[] {
    const shells: SupportedShell[] = [];
    const allowSandboxVariant = sandboxVariantsAvailable(platform);
    const add = (kind: SupportedShellKind, shellPath: string | null | undefined, sandboxed = false) => {
        if (!shellPath || shells.some((shell) => shell.path === shellPath && shell.sandboxed === sandboxed)) return;
        // Windows command wrappers require cmd.exe and cannot be spawned as the selected shell.
        if (platform === 'win32' && !/\.exe$/i.test(shellPath)) return;
        shells.push({ kind, path: shellPath, sandboxed });
        if (platform === 'win32' && kind === 'powershell' && !sandboxed && allowSandboxVariant)
            add(kind, shellPath, true);
        if (platform === 'linux' && (kind === 'bash' || kind === 'zsh') && !sandboxed && allowSandboxVariant)
            add(kind, shellPath, true);
        if (platform === 'darwin' && (kind === 'zsh' || kind === 'bash') && !sandboxed && allowSandboxVariant)
            add(kind, shellPath, true);
        if (platform === 'openharmony' && (kind === 'bash' || kind === 'zsh') && !sandboxed && allowSandboxVariant)
            add(kind, shellPath, true);
    };
    if (platform === 'win32') {
        for (const shellPath of findExecutablesInPath('powershell')) add('powershell', shellPath);
        for (const shellPath of findExecutablesInPath('pwsh')) add('powershell', shellPath);
        for (const shellPath of findExecutablesInPath('bash')) add('bash', shellPath);
        for (const shellPath of findExecutablesInPath('zsh')) add('zsh', shellPath);
        return shells;
    }
    if (platform === 'openharmony') {
        if (!getHarmonyLocalRuntimeFeatureAvailability('terminal', harmonyState).available) return [];
        // 宿主快照中的命令已经验证；CLI 无快照时才执行本机探测。
        add('zsh', harmonyState ? harmonyState.commands.zsh : findOpenHarmonyZsh());
        add('bash', harmonyState ? harmonyState.commands.bash : findOpenHarmonyBash());
        return shells;
    }
    for (const kind of ['zsh', 'bash'] as const) {
        for (const shellPath of findExecutablesInPath(kind)) add(kind, shellPath);
    }
    for (const shellPath of findExecutablesInPath('pwsh')) add('powershell', shellPath);
    return shells;
}

export const scanShells = scanSupportedShells;
export const getSupportedShells = scanSupportedShells;
