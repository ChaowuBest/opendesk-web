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

// 跨平台回收站：解析各平台的回收站目录 / 用系统能力打开回收站。
// OpenHarmony 沙箱的回收站位于家目录 Trash（见 native/openharmony/sandbox 的
// --del-to-trash / --trash）；Windows 打开系统回收站窗口。
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { getPlatform } from '../../platforms/base.js';
import { getHarmonyHomeDirectory, getHarmonyRuntimeEnvironment } from '../../platforms/bridges/harmonyos/runtime.js';

/** 各平台回收站目录（Windows 返回 null，使用系统回收站窗口）。 */
export function resolveOpenDeskTrashDirectory(): string | null {
    if (process.platform === 'openharmony') {
        const runtime = getHarmonyRuntimeEnvironment();
        if (runtime) return path.join(getHarmonyHomeDirectory(runtime), 'Trash');
        return process.env.USER_DATA_PATH ? path.join(process.env.USER_DATA_PATH, 'Trash') : null;
    }
    if (process.platform === 'linux') return path.join(os.homedir(), '.local', 'share', 'Trash');
    if (process.platform === 'darwin') return path.join(os.homedir(), '.Trash');
    return null; // Windows：使用系统回收站窗口
}

/** 用系统能力打开当前平台的回收站。 */
export async function openSystemTrash(): Promise<void> {
    if (process.platform === 'win32') {
        // 打开 Windows 回收站窗口（系统能力）
        const child = spawn('explorer.exe', ['shell:RecycleBinFolder'], {
            stdio: 'ignore',
            detached: true
        });
        child.unref();
        return;
    }
    const directory = resolveOpenDeskTrashDirectory();
    if (!directory) throw new Error('当前平台没有可打开的回收站目录');
    await getPlatform().openPath(directory);
}
