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

import fs from 'fs';
import { asyncShellExec } from './shellExec.js';

export interface DriveInfo {
    name: string;
    path: string;
    isDirectory: boolean;
    isDrive: boolean;
    driveLetter?: string;
    size?: number;
    free?: number;
}

/**
 * 获取 Windows 系统盘符列表
 * 优先使用 PowerShell 获取详细容量信息，回退到 Node.js 原生方式遍历盘符。
 */
export async function getWindowsDrives(): Promise<DriveInfo[]> {
    if (process.platform !== 'win32') {
        return [];
    }

    try {
        // 方法1：使用 PowerShell 获取盘符信息（包含容量）
        const { stdout } = await asyncShellExec(
            'Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, Used, Free | ConvertTo-Json',
            { timeout: 5000 }
        );

        const drives = JSON.parse(stdout);
        const driveList = Array.isArray(drives) ? drives : [drives];

        return driveList
            .filter((d: any) => d.Name && d.Root)
            .map((d: any) => ({
                name: `本地磁盘 (${d.Name}:)`,
                path: d.Root,
                isDirectory: true,
                isDrive: true,
                driveLetter: d.Name,
                size: d.Used ? d.Used + (d.Free || 0) : undefined,
                free: d.Free || undefined
            }));
    } catch (error) {
        // 方法2：回退到 Node.js 原生方式遍历盘符（wmic 在 Windows 10 21H2+ 已被移除）
        try {
            const drives: DriveInfo[] = [];
            for (let i = 65; i <= 90; i++) {
                const letter = String.fromCharCode(i);
                const drivePath = `${letter}:\\`;
                if (fs.existsSync(drivePath)) {
                    drives.push({
                        name: `本地磁盘 (${letter}:)`,
                        path: drivePath,
                        isDirectory: true,
                        isDrive: true,
                        driveLetter: letter
                    });
                }
            }
            return drives;
        } catch (fallbackError) {
            console.error('Failed to get Windows drives:', fallbackError);
            return [];
        }
    }
}
