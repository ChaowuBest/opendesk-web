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

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOpendeskDirectory } from '../../../utils/setting.js';

const pending = new Map<string, Promise<boolean>>();
let settledOnce = false;

const DECLINE_MARKER_FILE = 'sandbox-pipes-declined.json';

/**
 * 开机指纹：Date.now 与 os.uptime 的差值在同一次开机内稳定（分钟精度），
 * 重启后随开机时刻整体改变。用于跨应用重启记住"本次开机内用户已拒绝"。
 */
function bootFingerprint(): number {
    return Math.round((Date.now() - os.uptime() * 1000) / 60000);
}

function declineMarkerPath(): string {
    return path.join(getOpendeskDirectory(), DECLINE_MARKER_FILE);
}

/** 用户在本次开机内拒绝过提升（同机多进程共享该记忆）时返回该开机的指纹。 */
function readDeclineBoot(): number | null {
    try {
        const marker = JSON.parse(fs.readFileSync(declineMarkerPath(), 'utf8')) as {
            bootFingerprint?: number;
        };
        return typeof marker.bootFingerprint === 'number' ? marker.bootFingerprint : null;
    } catch {
        return null;
    }
}

function writeDeclineMarker(): void {
    try {
        fs.writeFileSync(declineMarkerPath(), JSON.stringify({ bootFingerprint: bootFingerprint() }));
    } catch {
        // 持久化失败只影响降频，不影响功能
    }
}

function clearDeclineMarker(): void {
    try {
        fs.rmSync(declineMarkerPath(), { force: true });
    } catch {
        // 清理失败同上，无害
    }
}

/**
 * 命名管道放通是可选增强：Windows 禁止 AppContainer 在全局命名空间创建
 * 管道，需要一次管理员确认在管道根目录追加 dynobox package SID 的
 * create-pipe ACE（设备对象 DACL 重启后重置，故每次开机重新检查）。
 * 失败（含用户取消 UAC）不阻塞沙箱：拒绝会在本次开机内被记住——跨应用
 * 重启也不再打扰；重启机器后 DACL 已被系统重置，才重新询问一次。
 */
export function ensureSandboxPipes(executable: string): Promise<boolean> {
    if (settledOnce) return Promise.resolve(false);
    const declinedBoot = readDeclineBoot();
    if (declinedBoot !== null && Math.abs(declinedBoot - bootFingerprint()) <= 2) {
        settledOnce = true;
        return Promise.resolve(false);
    }
    const existing = pending.get(executable);
    if (existing) return existing;
    const setup = new Promise<boolean>((resolve) => {
        execFile(executable, ['pipes-ensure'], { windowsHide: true, timeout: 150000 }, (error, stdout) => {
            let configured = false;
            try {
                configured = !error && JSON.parse(stdout)?.configured === true;
            } catch {
                // 提权失败/被取消时不必产生有效的 JSON 协议响应。
            }
            if (configured) clearDeclineMarker();
            else writeDeclineMarker();
            resolve(configured);
        });
    }).finally(() => {
        pending.delete(executable);
        settledOnce = true;
    });
    pending.set(executable, setup);
    return setup;
}
