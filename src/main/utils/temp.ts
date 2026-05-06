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
import path from 'path';

const OPENHARMONY_TMP_DIR_NAME = '.opendesk-tmp';

function isOpenHarmony(): boolean {
    return (process.platform as string) === 'openharmony';
}

function getOpenHarmonyTmpPath(): string {
    return path.join('/storage/Users/currentUser', OPENHARMONY_TMP_DIR_NAME);
}

/**
 * 初始化临时目录。
 * 非 OpenHarmony 平台无需操作；OpenHarmony 上在家目录创建 .opendesk-tmp（若已存在则先删除）。
 */
export function initTempDir(): void {
    if (!isOpenHarmony()) return;
    const tmpPath = getOpenHarmonyTmpPath();
    if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpPath, { recursive: true });
}

/**
 * 清理临时目录。
 * 非 OpenHarmony 平台无需操作；OpenHarmony 上删除 .opendesk-tmp。
 */
export function closeTempDir(): void {
    if (!isOpenHarmony()) return;
    const tmpPath = getOpenHarmonyTmpPath();
    if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { recursive: true, force: true });
    }
}

/**
 * 获取系统临时目录。
 * 非 OpenHarmony 返回 os.tmpdir()；OpenHarmony 返回我们管理的 .opendesk-tmp 目录。
 */
export function getTempDir(): string {
    if (!isOpenHarmony()) {
        return os.tmpdir();
    }
    const tmpPath = getOpenHarmonyTmpPath();
    if (!fs.existsSync(tmpPath)) {
        fs.mkdirSync(tmpPath, { recursive: true });
    }
    return tmpPath;
}

/**
 * 获取用户家目录（跨平台）。
 * OpenHarmony 返回 /storage/Users/currentUser；其它平台使用 os.homedir()。
 */
export function getHomeDir(): string {
    if (isOpenHarmony()) {
        return '/storage/Users/currentUser';
    }
    return os.homedir();
}
