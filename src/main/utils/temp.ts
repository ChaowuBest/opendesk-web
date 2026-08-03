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

import os from 'os';
import fs from 'fs';
import { getHarmonyHomeDirectory, getHarmonyRuntimeEnvironment } from './harmonyRuntime.js';

/**
 * 初始化临时目录。
 * 非 HarmonyOS 平台无需操作；HarmonyOS 使用 ArkTS 提供的应用沙箱临时目录。
 */
export function initTempDir(): void {
    const runtime = getHarmonyRuntimeEnvironment();
    if (!runtime) return;
    fs.mkdirSync(runtime.tempDir, { recursive: true });
}

/**
 * 清理临时目录。
 * HarmonyOS 的 tempDir 由系统管理，应用退出时不得删除该目录本身。
 */
export function closeTempDir(): void {
    // Intentionally empty. Callers still use this hook for other platforms.
}

/**
 * 获取系统临时目录。
 * 非 HarmonyOS 返回 os.tmpdir()；HarmonyOS 返回应用沙箱 Context.tempDir。
 */
export function getTempDir(): string {
    const runtime = getHarmonyRuntimeEnvironment();
    if (!runtime) {
        return os.tmpdir();
    }
    if (!fs.existsSync(runtime.tempDir)) {
        fs.mkdirSync(runtime.tempDir, { recursive: true });
    }
    return runtime.tempDir;
}

/**
 * 获取用户家目录（跨平台）。
 * HarmonyOS PC 返回 userHomeDir；tablet 返回 appDataDir，避免暴露或写入 PC 家目录。
 * 其它平台使用 os.homedir()。
 */
export function getHomeDir(): string {
    const runtime = getHarmonyRuntimeEnvironment();
    if (runtime) {
        return getHarmonyHomeDirectory(runtime);
    }
    return os.homedir();
}

/**
 * 获取所有应被视为"临时目录"的路径列表（去重）。
 *
 * 除 getTempDir()（os.tmpdir()）外，还包含系统级临时目录：
 * - macOS: /tmp（符号链接）和 /private/tmp（实际路径）
 * - Linux: /tmp
 * - Windows: 无额外路径（os.tmpdir() 已覆盖 %TEMP%/%TMP%）
 *
 * 用于权限引擎将所有临时目录标记为始终允许。
 */
export function getAllTempDirs(): string[] {
    const dirs: string[] = [getTempDir()];

    if (process.platform === 'darwin') {
        dirs.push('/tmp', '/private/tmp');
    } else if ((process.platform as string) !== 'openharmony' && process.platform !== 'win32') {
        dirs.push('/tmp');
    }

    // 去重（规范化后比较）
    const seen = new Set<string>();
    const result: string[] = [];
    for (const dir of dirs) {
        const norm = dir.replace(/\\/g, '/');
        if (!seen.has(norm)) {
            seen.add(norm);
            result.push(norm);
        }
    }
    return result;
}
